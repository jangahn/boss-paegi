import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import { uploadFaceTmp, deleteFaceTmp } from "@/lib/character-gen/upload-face";
import { analyzeInputFace } from "@/lib/fal";
import { checkFalBalance } from "@/lib/fal-balance";
import { SERVER_ENV } from "@/lib/env.server";
import { isRoleId } from "@/lib/roles";
import { log, errInfo } from "@/lib/log";

const MAX_BYTES = 10 * 1024 * 1024;

export const runtime = "nodejs";
// 비동기 제출 — fal 에 등록만 하고 즉시 반환(업로드+검출+제출 ~6s)이라 짧게 충분.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // 회원 전용 게이트 (비회원/무세션/멤버화 미완 → 401/403)
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user, member } = gate;
  // 14세/약관/방침 동의는 로그인 직후 통합 게이트(requireMember 의 consent_required)에서 보장 — 여기 backstop 없음.

  log.info("gen.request", { userId: user.id });

  // 운영 계정은 생성권 무제한.
  const isOps = !!SERVER_ENV.OPS_USER_ID && user.id === SERVER_ENV.OPS_USER_ID;

  // ── 생성권 빠른 차단 (prep/제출 낭비 방지) — 실제 차감은 fal submit 직전 원자적으로 ──
  if (!isOps && member.gen_credits < 1) {
    log.warn("gen.no_credits_precheck", { userId: user.id });
    return NextResponse.json({ error: "no_credits" }, { status: 402 });
  }

  // ── fal 잔액 hard cap — $2 미만이면 전 계정 생성 일시 중단 ─────────
  const balance = await checkFalBalance();
  if (!balance.ok) {
    log.warn("gen.balance_blocked", { userId: user.id, balance: balance.balance });
    return NextResponse.json({ error: "service_paused" }, { status: 503 });
  }

  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "image_required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", maxMB: 10 },
      { status: 400 }
    );
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "not_an_image" }, { status: 400 });
  }

  // 생성 시 선택한 롤 — 복장·표정 프롬프트 + doll.role 에 반영. 미전송이면 boss, 미지값은 400.
  const roleRaw = form.get("role")?.toString() ?? "boss";
  if (!isRoleId(roleRaw)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const role = roleRaw;

  const provider = selectProvider(null);

  // 입력 정규화 (1024×1024 cover) — 원본은 메모리 안에서만
  const rawBuf = await file.arrayBuffer();
  let prepared: Buffer;
  try {
    prepared = await Sentry.startSpan(
      { name: "gen.prepare_input", op: "image.process", attributes: { userId: user.id } },
      () => prepareInputImage(rawBuf)
    );
  } catch (e) {
    log.error("gen.input_prep_fail", {
      userId: user.id,
      fileSize: file.size,
      fileType: file.type,
      ...errInfo(e),
    });
    return NextResponse.json({ error: "input_prep_failed" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: genRow, error: logError } = await admin
    .from("ai_generations")
    .insert({ owner_id: user.id, status: "queued", role })
    .select("id")
    .single();
  if (logError || !genRow) {
    log.error("gen.log_insert_fail", {
      userId: user.id,
      ...errInfo(logError),
    });
    return NextResponse.json({ error: "log_failed" }, { status: 500 });
  }

  const genId = genRow.id as string;
  const startedAt = Date.now();

  // face 임시 업로드 → signed URL → fal 에 제출(결과 대기 X) → 즉시 반환.
  // 생성은 fal 에서 진행되고, 클라가 /api/generations 폴링으로 완성분을 받는다.
  // 임시 얼굴은 fal 이 생성 중 fetch 하므로 지금 안 지움 — 복구가 done 시 삭제.
  let facePath: string | null = null;
  let creditConsumed = false;
  try {
    const uploaded = await Sentry.startSpan(
      { name: "gen.face_upload", op: "storage.upload", attributes: { genId, userId: user.id } },
      () => uploadFaceTmp(user.id, genId, prepared)
    );
    facePath = uploaded.path;

    // 얼굴 분석(1회 VLM) — 얼굴 존재 + 안경 여부. 안경은 PuLID 누락 보정용, 얼굴은 제출 전 게이트용.
    const { faceVisible, wearsGlasses } = await Sentry.startSpan(
      { name: "gen.analyze_face", op: "fal.vqa", attributes: { genId, userId: user.id } },
      () => analyzeInputFace(uploaded.url)
    );
    if (wearsGlasses) log.info("gen.glasses_detected", { genId, userId: user.id });

    // 제출 전 얼굴 게이트 — 확실한 no-face 면 차감·제출 없이 즉시 반려(no-face fal 낭비·30~60초 대기 방지).
    if (!faceVisible) {
      await admin
        .from("ai_generations")
        .update({ status: "failed", fail_reason: "no_face" })
        .eq("id", genId);
      if (facePath) {
        await deleteFaceTmp(facePath).catch((err) =>
          log.warn("gen.face_cleanup_fail", { genId, ...errInfo(err) })
        );
      }
      log.info("gen.no_face_rejected", { genId, userId: user.id });
      return NextResponse.json({ error: "no_face" }, { status: 400 });
    }

    // ── 생성권 차감 — 외부 비용(fal submit) 직전, 원자적 RPC(동시요청 안전) ──
    if (!isOps) {
      const { data: remaining, error: consumeErr } = await admin.rpc(
        "consume_gen_credit",
        { p_user: user.id }
      );
      if (consumeErr || remaining === null) {
        // 차감 불가(소진/동시요청 경합 패배) → 만든 row·임시얼굴 정리 후 402.
        await admin
          .from("ai_generations")
          .update({ status: "failed", fail_reason: "no_credits" })
          .eq("id", genId);
        if (facePath) {
          await deleteFaceTmp(facePath).catch((err) =>
            log.warn("gen.face_cleanup_fail", { genId, ...errInfo(err) })
          );
        }
        log.warn("gen.no_credits", { userId: user.id, genId, ...errInfo(consumeErr) });
        return NextResponse.json({ error: "no_credits" }, { status: 402 });
      }
      creditConsumed = true;
      log.info("gen.credit_consumed", { userId: user.id, genId, remaining });
    }

    // fal 큐에 3건 제출 — request_id 만 받고 대기 X.
    const requestIds = await Sentry.startSpan(
      {
        name: "gen.fal_submit",
        op: "fal.queue.submit",
        attributes: { genId, userId: user.id, numImages: 3, wearsGlasses },
      },
      () =>
        provider.submitGeneration({
          faceImageUrl: uploaded.url,
          templateImageUrl: "", // PuLID 는 template 무시
          numImages: 3,
          wearsGlasses,
          role,
        })
    );

    // request_id 저장 — 복구(generation-recovery)가 이걸로 fal 결과 회수 + done 마킹.
    const { error: ridErr } = await admin
      .from("ai_generations")
      .update({ fal_request_ids: requestIds })
      .eq("id", genId);
    // migration 0006 미적용이면 복구만 비활성 — 다른 에러는 추적.
    if (ridErr && !ridErr.message.includes("fal_request_ids")) {
      log.warn("gen.request_ids_persist_fail", { genId, ...errInfo(ridErr) });
    }

    log.info("gen.submitted", {
      genId,
      userId: user.id,
      provider: provider.name,
      requestCount: requestIds.length,
      wearsGlasses,
      elapsedMs: Date.now() - startedAt,
    });

    // 즉시 반환 — 생성중. 클라는 generationId 로 /api/generations 폴링.
    return NextResponse.json({ generationId: genId, status: "generating" });
  } catch (e) {
    await admin
      .from("ai_generations")
      .update({ status: "failed", fail_reason: "submit_error" })
      .eq("id", genId);
    // 제출 실패 → fal 이 face 를 안 쓰므로 임시 얼굴 즉시 삭제(정책: 원본 폐기).
    if (facePath) {
      await deleteFaceTmp(facePath).catch((err) =>
        log.warn("gen.face_cleanup_fail", { genId, ...errInfo(err) })
      );
    }
    // 차감했는데 제출 실패 → 생성권 환불(원자적). ops 는 차감 안 했으니 스킵.
    if (creditConsumed && !isOps) {
      const { error: refundErr } = await admin.rpc("refund_gen_credit", {
        p_user: user.id,
      });
      if (refundErr) {
        log.error("gen.credit_refund_fail", {
          genId,
          userId: user.id,
          ...errInfo(refundErr),
        });
      }
    }
    log.error("gen.submit_fail", { genId, userId: user.id, ...errInfo(e) });
    return NextResponse.json(
      {
        error: "generation_failed",
        detail: e instanceof Error ? e.message : "unknown",
      },
      { status: 500 }
    );
  }
}
