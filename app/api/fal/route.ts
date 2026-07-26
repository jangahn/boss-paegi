import "server-only";
import * as Sentry from "@sentry/nextjs";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import { uploadFaceTmp, deleteFaceTmp } from "@/lib/character-gen/upload-face";
import { analyzeInputFace } from "@/lib/fal";
import { getGenerationConfigWithMeta } from "@/lib/config/getters";
import { buildGenerationPlan, FIXED_FLUX } from "@/lib/character-gen/plan";
import { failGeneration } from "@/lib/generation-recovery";
import { PROVENANCE_SCHEMA_VERSION } from "@/lib/character-gen/provenance";
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

  // ── 생성권 빠른 차단 (prep/제출 낭비 방지) — 실제 차감은 얼굴 게이트 통과 후
  //    create_generation_and_consume(queued row 생성 + lot 소비 원자) 로 ──
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
  const startedAt = Date.now();

  // gen row 는 얼굴 게이트 통과 후 소비 시점(create_generation_and_consume)에 생성된다.
  // 임시 얼굴 업로드 경로는 genId 로 결정적(tmpFacePath)인데 row 가 아직 없으므로,
  // 분석용 업로드에는 임의 uuid 를 쓰고 row 생성 후 genId 경로로 재업로드해
  // 이후 정리(generations 폴링/doll pick 의 cleanupFace)와 경로 계약을 맞춘다.
  const tmpFaceId = randomUUID();

  // face 임시 업로드 → signed URL → fal 에 제출(결과 대기 X) → 즉시 반환.
  // 생성은 fal 에서 진행되고, 클라가 /api/generations 폴링으로 완성분을 받는다.
  // 임시 얼굴은 fal 이 생성 중 fetch 하므로 지금 안 지움 — 복구가 done 시 삭제.
  let facePath: string | null = null;
  let genId: string | null = null;

  // 임시 얼굴 정리(베스트에포트) — 실패는 원본이 남는 정책 #1 리스크라 반드시 가시화.
  const cleanupFace = (path: string): Promise<void> =>
    deleteFaceTmp(path).catch((err) =>
      log.warn("gen.face_cleanup_fail", { genId, tmpFaceId, userId: user.id, ...errInfo(err) })
    );

  try {
    const uploaded = await Sentry.startSpan(
      { name: "gen.face_upload", op: "storage.upload", attributes: { tmpFaceId, userId: user.id } },
      () => uploadFaceTmp(user.id, tmpFaceId, prepared)
    );
    facePath = uploaded.path;

    // 얼굴 분석(1회 VLM) — 얼굴 존재 + 안경 여부(+ provenance 기록용 메타). 얼굴은 제출 전 게이트용.
    const analysis = await Sentry.startSpan(
      { name: "gen.analyze_face", op: "fal.vqa", attributes: { tmpFaceId, userId: user.id } },
      () => analyzeInputFace(uploaded.url)
    );
    const { faceVisible, singlePerson, faceClear, wearsGlasses } = analysis;
    if (wearsGlasses) log.info("gen.glasses_detected", { tmpFaceId, userId: user.id });

    // 제출 전 입력 게이트 — 소비·제출 없이 즉시 반려(불량 입력의 fal 낭비·아티팩트 방지). 각 판정은
    // 명시적 위반일 때만 차단(fail-open). gen row 없어 실패 기록 불요 — row 없이 400 반환.
    // 우선순위: 얼굴 없음 → 여러 명 → 얼굴 가림. (정수리 잘림은 moondream 신뢰성 미달로 제외 — 생성 프롬프트가 담당.)
    const inputReject = !faceVisible
      ? "no_face"
      : !singlePerson
        ? "multiple_people"
        : !faceClear
          ? "face_obstructed"
          : null;
    if (inputReject) {
      // 입력 거부도 어드민에 가시화 — **소비 없이** row 생성(create_generation_row, ops 경로 재사용)
      // 후 failed+사유+analyze 스냅샷 기록. best-effort(기록 실패해도 반려는 유지). 크레딧 미차감이라
      // 크레딧 로트/원장 무접촉 → G-1·환불 sweep 불변식과 독립(credit_lot_id=NULL).
      try {
        const { data: rejId } = await admin.rpc("create_generation_row", {
          p_user: user.id,
          p_role: role,
        });
        if (rejId) {
          await admin
            .from("ai_generations")
            .update({
              status: "failed",
              fail_reason: inputReject,
              gen_params: {
                schemaVersion: PROVENANCE_SCHEMA_VERSION,
                analyze: {
                  model: analysis.model,
                  status: analysis.status,
                  faceVisible: analysis.faceVisible,
                  singlePerson: analysis.singlePerson,
                  peopleCount: analysis.peopleCount,
                  faceClear: analysis.faceClear,
                  wearsGlasses: analysis.wearsGlasses,
                  checks: analysis.checks,
                },
                rejected: { reason: inputReject },
              },
            })
            .eq("id", rejId as string);
        }
      } catch (e) {
        log.warn("gen.input_reject_record_fail", {
          userId: user.id,
          reason: inputReject,
          ...errInfo(e),
        });
      }
      await cleanupFace(facePath);
      log.info("gen.input_rejected", { tmpFaceId, userId: user.id, reason: inputReject });
      return NextResponse.json({ error: inputReject }, { status: 400 });
    }

    // ── queued row 생성 + 생성권 차감 — 외부 비용(fal submit) 직전, 원자적 RPC(동시요청 안전) ──
    if (isOps) {
      // 운영 계정은 생성권 소비 없이 진행 — 소비 없는 queued 행 생성 RPC 경유(§13: 0063 이
      // ai_generations INSERT 를 회수하므로 직접 insert 불가). RPC 가 owner_id/status/role 만 set,
      // credit_lot_id/consumed_at 등 금융귀속 컬럼은 미접촉.
      const { data: genRowId, error: logError } = await admin.rpc("create_generation_row", {
        p_user: user.id,
        p_role: role,
      });
      if (logError || !genRowId) {
        log.error("gen.log_insert_fail", {
          userId: user.id,
          ...errInfo(logError),
        });
        await cleanupFace(facePath);
        return NextResponse.json({ error: "log_failed" }, { status: 500 });
      }
      genId = genRowId as string;
    } else {
      const { data: consumed, error: consumeErr } = await admin.rpc(
        "create_generation_and_consume",
        { p_user: user.id, p_role: role }
      );
      if (consumeErr) {
        // RPC 가 row 생성+소비를 원자 rollback — 여기서 정리할 row 없음, 임시얼굴만 정리.
        await cleanupFace(facePath);
        if (consumeErr.message.includes("insufficient_credits")) {
          // 차감 불가(소진/동시요청 경합 패배) → 402.
          log.warn("gen.no_credits", { userId: user.id, ...errInfo(consumeErr) });
          return NextResponse.json({ error: "no_credits" }, { status: 402 });
        }
        log.error("gen.create_consume_fail", { userId: user.id, ...errInfo(consumeErr) });
        return NextResponse.json({ error: "log_failed" }, { status: 500 });
      }
      const created = consumed as { generation_id?: string; remaining?: number } | null;
      if (!created?.generation_id) {
        log.error("gen.create_consume_fail", { userId: user.id, detail: "missing_generation_id" });
        await cleanupFace(facePath);
        return NextResponse.json({ error: "log_failed" }, { status: 500 });
      }
      genId = created.generation_id;
      log.info("gen.credit_consumed", {
        userId: user.id,
        genId,
        remaining: created.remaining ?? null,
      });
    }

    // ── 임시 얼굴을 genId 경로로 이관(재업로드) ──
    // 정리 계약(cleanupFace = tmpFacePath(owner, genId))이 genId 기준이라, 임의 uuid 경로에
    // 남기면 영구 잔존(정책 #1 위반) 위험 → genId 경로로 재업로드 후 분석용 경로는 즉시 삭제.
    // (uploadFaceTmp 는 결정적 경로 + upsert 라 재시도 안전. fal 은 genId 경로 URL 만 fetch.)
    const analyzePath = facePath;
    const uploadedFinal = await uploadFaceTmp(user.id, genId, prepared);
    facePath = uploadedFinal.path;
    await cleanupFace(analyzePath);

    // 생성 설정 — 발행 즉시 반영 위해 uncached 강한읽기 1회(SWR 우회). source/version/invalid 은 provenance 로.
    const cfg = await getGenerationConfigWithMeta();
    const plan = buildGenerationPlan(cfg.value, { role, wearsGlasses, numImages: 3 });

    // provenance 초기 스냅샷(submitted) — 제출 **전** 저장(부분 실패 시 계획 유실 방지). 비밀/URL 미포함.
    const provenance = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      config: {
        key: "generation_config" as const,
        source: cfg.source,
        version: cfg.version,
        invalid: !!cfg.invalid,
      },
      analyze: {
        model: analysis.model,
        status: analysis.status,
        faceVisible: analysis.faceVisible,
        singlePerson: analysis.singlePerson,
        peopleCount: analysis.peopleCount,
        faceClear: analysis.faceClear,
        wearsGlasses: analysis.wearsGlasses,
        checks: analysis.checks,
      },
      generation: {
        provider: FIXED_FLUX.provider,
        model: FIXED_FLUX.model,
        role,
        request: plan.request,
        snapshot: plan.snapshot,
        candidates: plan.candidates.map((c) => ({
          index: c.index,
          suitColor: c.suitColor,
          positivePrompt: c.positivePrompt,
          requestId: null as string | null,
          seed: null as number | null,
          status: "submitted" as "submitted" | "completed" | "failed",
        })),
      },
      postprocess: null,
      picked: null,
    };

    // 제출 전 선저장 — 실패면 fal 미제출 + 원자 환불(소비 크레딧 회수) 후 반려.
    const { error: preErr } = await admin
      .from("ai_generations")
      .update({ gen_params: provenance })
      .eq("id", genId);
    if (preErr) {
      log.error("gen.provenance_presave_fail", { genId, ...errInfo(preErr) });
      await failGeneration(admin, genId, user.id, isOps, "provenance_presave_fail");
      await cleanupFace(facePath);
      return NextResponse.json({ error: "log_failed" }, { status: 500 });
    }

    // fal 큐에 3건 allSettled 제출 — 부분 성공 허용, 접수된 request_id 유실 금지.
    const submitResults = await Sentry.startSpan(
      {
        name: "gen.fal_submit",
        op: "fal.queue.submit",
        attributes: { genId, userId: user.id, numImages: 3, wearsGlasses },
      },
      () => provider.submitPlan({ faceImageUrl: uploadedFinal.url, plan })
    );
    const okResults = submitResults.filter((r) => r.status === "submitted" && r.requestId);
    // 성공 0 = 전부 제출 실패 → failed + 환불.
    if (okResults.length === 0) {
      log.error("gen.submit_all_failed", { genId, userId: user.id });
      await failGeneration(admin, genId, user.id, isOps, "submit_failed");
      await cleanupFace(facePath);
      return NextResponse.json({ error: "generation_failed" }, { status: 502 });
    }

    // 후보 provenance 에 requestId/status 반영 + fal_request_ids 파생(index 순, 성공분만).
    const byIndex = new Map(submitResults.map((r) => [r.index, r]));
    provenance.generation.candidates = provenance.generation.candidates.map((c) => {
      const r = byIndex.get(c.index);
      return r ? { ...c, requestId: r.requestId, status: r.status } : c;
    });
    const falRequestIds = okResults
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((r) => r.requestId as string);

    // 저장(bounded retry) — fal_request_ids(복구 회수용) + gen_params(requestId 반영). 둘 다 operational 컬럼.
    let persistErr: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error } = await admin
        .from("ai_generations")
        .update({ fal_request_ids: falRequestIds, gen_params: provenance })
        .eq("id", genId);
      if (!error) {
        persistErr = null;
        break;
      }
      persistErr = error.message;
      log.warn("gen.request_ids_persist_retry", { genId, attempt, error: error.message });
    }
    if (persistErr) {
      // 영속 실패 = 복구가 request_id 를 못 찾아 좀비화 → failed + 환불(관측가능 오류로 종료).
      log.error("gen.request_ids_persist_fail", { genId, error: persistErr });
      await failGeneration(admin, genId, user.id, isOps, "persist_failed");
      await cleanupFace(facePath);
      return NextResponse.json({ error: "log_failed" }, { status: 500 });
    }

    log.info("gen.submitted", {
      genId,
      userId: user.id,
      provider: provider.name,
      requestCount: falRequestIds.length,
      wearsGlasses,
      elapsedMs: Date.now() - startedAt,
    });

    // 즉시 반환 — 생성중. 클라는 generationId 로 /api/generations 폴링.
    return NextResponse.json({ generationId: genId, status: "generating" });
  } catch (e) {
    // genId 없음 = 소비 전(업로드/분석 단계) 실패 — row 자체가 없어 마킹·환급 불필요.
    if (genId) {
      if (isOps) {
        // ops 는 소비가 없었으니 마킹만(operational 컬럼 직접 UPDATE 유지).
        await admin
          .from("ai_generations")
          .update({ status: "failed", fail_reason: "submit_error" })
          .eq("id", genId);
      } else {
        // 소비했는데 제출 실패 → failed 마킹 + 생성권 환급(원자·멱등 정본=DB refunded_at).
        const { error: refundErr } = await admin.rpc("mark_generation_failed_and_refund", {
          p_gen_id: genId,
          p_fail_reason: "submit_error",
        });
        if (refundErr) {
          log.error("gen.credit_refund_fail", {
            genId,
            userId: user.id,
            ...errInfo(refundErr),
          });
        }
      }
    }
    // 제출 실패 → fal 이 face 를 안 쓰므로 임시 얼굴 즉시 삭제(정책: 원본 폐기).
    if (facePath) {
      await cleanupFace(facePath);
    }
    log.error("gen.submit_fail", { genId, tmpFaceId, userId: user.id, ...errInfo(e) });
    return NextResponse.json(
      {
        error: "generation_failed",
        detail: e instanceof Error ? e.message : "unknown",
      },
      { status: 500 }
    );
  }
}
