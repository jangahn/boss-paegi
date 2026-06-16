import "server-only";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import { uploadFaceTmp, deleteFaceTmp } from "@/lib/character-gen/upload-face";
import { detectGlasses } from "@/lib/fal";
import { checkFalBalance } from "@/lib/fal-balance";
import { log, errInfo } from "@/lib/log";

const MAX_BYTES = 10 * 1024 * 1024;
/** 기본 일일 생성 한도 — profiles.daily_gen_limit 조회 실패 시 fallback */
const DEFAULT_DAILY_LIMIT = 2;

export const runtime = "nodejs";
// 비동기 제출 — fal 에 등록만 하고 즉시 반환(업로드+검출+제출 ~6s)이라 짧게 충분.
export const maxDuration = 30;

/** 오늘 KST 자정 (UTC ISO) — 일일 한도 리셋 기준 */
function kstMidnightUtcIso(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  kst.setUTCHours(0, 0, 0, 0);
  return new Date(kst.getTime() - 9 * 3600_000).toISOString();
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  log.info("gen.request", { userId: user.id });

  // ── fal 잔액 hard cap — $2 미만이면 전 계정 생성 일시 중단 ─────────
  const balance = await checkFalBalance();
  if (!balance.ok) {
    log.warn("gen.balance_blocked", { userId: user.id, balance: balance.balance });
    return NextResponse.json({ error: "service_paused" }, { status: 503 });
  }

  // ── 일일 생성 한도 (KST 자정 리셋). daily_gen_limit null = 무제한 ──
  const adminForQuota = createAdminClient();
  let limit: number | null = DEFAULT_DAILY_LIMIT;
  const { data: profileRow, error: profileErr } = await adminForQuota
    .from("profiles")
    .select("daily_gen_limit")
    .eq("id", user.id)
    .single();
  if (!profileErr && profileRow && "daily_gen_limit" in profileRow) {
    limit = profileRow.daily_gen_limit as number | null;
  } else {
    // migration 0004 미적용(컬럼 없음) / profile row 없음(PGRST116) / 조회 에러
    // → 기본 한도 유지. errInfo 로 세 원인 구분 가능하게 남김.
    log.warn("gen.daily_limit_col_missing", {
      userId: user.id,
      fallbackLimit: DEFAULT_DAILY_LIMIT,
      ...errInfo(profileErr),
    });
  }
  if (limit !== null) {
    const { count, error: countErr } = await adminForQuota
      .from("ai_generations")
      .select("*", { head: true, count: "exact" })
      .eq("owner_id", user.id)
      .neq("status", "failed") // 실패한 생성은 차감 안 함
      .gte("created_at", kstMidnightUtcIso());
    if (countErr) {
      // 카운트 확인 실패 = 한도가 적용되지 않은 채 생성이 진행됨(fail-open).
      // 정책 #5(카운트 확인 후 진행) 위반 사고이므로 반드시 추적 가능해야 함.
      log.error("gen.daily_count_fail", { userId: user.id, limit, ...errInfo(countErr) });
    } else if ((count ?? 0) >= limit) {
      log.warn("gen.daily_limit", { userId: user.id, used: count ?? 0, limit });
      return NextResponse.json(
        { error: "daily_limit", limit, used: count ?? 0 },
        { status: 429 }
      );
    }
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
    .insert({ owner_id: user.id, status: "queued" })
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
  try {
    const uploaded = await Sentry.startSpan(
      { name: "gen.face_upload", op: "storage.upload", attributes: { genId, userId: user.id } },
      () => uploadFaceTmp(user.id, genId, prepared)
    );
    facePath = uploaded.path;

    // 입력에 안경이 있으면 캐릭터에도 반영 (PuLID 가 액세서리를 떨궈 누락되므로 조건부).
    // 검출 실패 시 false 폴백(생성은 진행).
    const wearsGlasses = await Sentry.startSpan(
      { name: "gen.detect_glasses", op: "fal.vqa", attributes: { genId, userId: user.id } },
      () => detectGlasses(uploaded.url)
    );
    if (wearsGlasses) log.info("gen.glasses_detected", { genId, userId: user.id });

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
    await admin.from("ai_generations").update({ status: "failed" }).eq("id", genId);
    // 제출 실패 → fal 이 face 를 안 쓰므로 임시 얼굴 즉시 삭제(정책: 원본 폐기).
    if (facePath) {
      await deleteFaceTmp(facePath).catch((err) =>
        log.warn("gen.face_cleanup_fail", { genId, ...errInfo(err) })
      );
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
