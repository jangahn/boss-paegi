import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareInputImage } from "@/lib/image-utils";
import { selectProvider } from "@/lib/character-gen";
import { uploadFaceTmp, deleteFaceTmp } from "@/lib/character-gen/upload-face";
import { detectGlasses } from "@/lib/fal";
import { checkFalBalance } from "@/lib/fal-balance";
import { copyCandidatesToStorage } from "@/lib/generation-recovery";
import { log, errInfo } from "@/lib/log";

const MAX_BYTES = 10 * 1024 * 1024;
/** 기본 일일 생성 한도 — profiles.daily_gen_limit 조회 실패 시 fallback */
const DEFAULT_DAILY_LIMIT = 2;

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby max

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
    prepared = await prepareInputImage(rawBuf);
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
  log.info("gen.fal_start", {
    genId,
    userId: user.id,
    provider: provider.name,
    fileSize: file.size,
  });

  // face 임시 업로드 → signed URL → fal → 결과 → 임시 삭제 (정책: 원본 폐기)
  let facePath: string | null = null;
  try {
    const uploaded = await uploadFaceTmp(user.id, prepared);
    facePath = uploaded.path;

    // fal 큐 등록 즉시 request_id 를 row 에 저장 → 함수가 done 전에 죽어도
    // 갤러리에서 이 id 로 결과를 복구할 수 있다. (직렬 체인으로 덮어쓰기 순서 보장)
    const requestIds: string[] = [];
    let persistChain: Promise<unknown> = Promise.resolve();
    const persistRequestIds = (rid: string) => {
      requestIds.push(rid);
      const snapshot = [...requestIds];
      persistChain = persistChain.then(async () => {
        const { error } = await admin
          .from("ai_generations")
          .update({ fal_request_ids: snapshot })
          .eq("id", genRow.id);
        // migration 0006 (fal_request_ids) 미적용이면 복구만 비활성 — 생성은 계속.
        if (error && !error.message.includes("fal_request_ids")) {
          log.warn("gen.request_ids_persist_fail", { genId, ...errInfo(error) });
        }
      });
    };

    // 입력에 안경이 있으면 캐릭터에도 반영 (PuLID 가 액세서리를 떨궈 누락되므로 조건부).
    // 검출 실패 시 false 폴백(생성은 진행). ~2-3s 직렬이라 60s 한도 내 여유.
    const wearsGlasses = await detectGlasses(uploaded.url);
    if (wearsGlasses) log.info("gen.glasses_detected", { genId, userId: user.id });

    const result = await provider.generate({
      faceImageUrl: uploaded.url,
      // PuLID 는 template 무시 — 호환성 위해 빈 문자열 전달
      templateImageUrl: "",
      numImages: 3,
      wearsGlasses,
      onEnqueue: persistRequestIds,
    });

    log.info("gen.fal_success", {
      genId,
      userId: user.id,
      provider: result.provider,
      durationMs: result.durationMs,
      costCents: result.costCents,
      imageCount: result.images.length,
    });

    // 후보 3장을 Supabase 에 복사 보관 (fal URL 은 만료되므로) — 고르기 전
    // 이탈/실패에서 갤러리로 이어서 고를 수 있게. 복구 경로와 동일 헬퍼 공유.
    const copied = await copyCandidatesToStorage(
      admin,
      user.id,
      genRow.id,
      result.images
    );
    const storedUrls = copied.filter((c) => c.copied).map((c) => c.url);
    if (storedUrls.length < result.images.length) {
      log.warn("gen.candidate_copy_partial", {
        genId,
        copied: storedUrls.length,
        total: result.images.length,
      });
    }
    // UI 응답: 생성된 장수 그대로 노출 — 복사 성공은 storage url, 실패 칸은 원본 fal url
    // 폴백(즉시 고르기엔 유효). 한 장이라도 조용히 사라지지 않게.
    const images = copied.map(({ url, width, height }) => ({ url, width, height }));

    const doneRow = {
      status: "done",
      cost_cents: result.costCents,
      fal_request_id: `${result.provider}:${genRow.id}`,
    };
    const { error: doneErr } = await admin
      .from("ai_generations")
      // candidate_urls 는 durable storage url 만 (resume 때 fal url 은 만료됨)
      .update({ ...doneRow, candidate_urls: storedUrls })
      .eq("id", genRow.id);
    // migration 0005 (candidate_urls 컬럼) 미적용 환경 fallback — 생성은 성공해야
    if (doneErr && doneErr.message.includes("candidate_urls")) {
      log.warn("gen.candidate_col_missing", { genId });
      await admin.from("ai_generations").update(doneRow).eq("id", genRow.id);
    } else if (doneErr) {
      log.error("gen.done_update_fail", { genId, ...errInfo(doneErr) });
    }

    log.info("gen.done", {
      genId,
      userId: user.id,
      candidatesSaved: storedUrls.length,
      shown: images.length,
      totalMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      images,
      generationId: genRow.id,
      provider: result.provider,
      durationMs: result.durationMs,
    });
  } catch (e) {
    const { error: failErr } = await admin
      .from("ai_generations")
      .update({ status: "failed" })
      .eq("id", genRow.id);
    if (failErr) {
      // failed 마킹마저 실패하면 row 가 queued 로 남아 복구 로직을 교란 → 추적.
      log.error("gen.failed_status_update_fail", { genId, ...errInfo(failErr) });
    }
    // abort(48s 가드) = fal 큐 혼잡으로 시간 초과 → 일반 실패와 구분해 추적/안내.
    const timedOut =
      e instanceof Error &&
      (e.name === "TimeoutError" ||
        e.name === "AbortError" ||
        /timed out|timeout|abort/i.test(e.message));
    log.error(timedOut ? "gen.fal_timeout" : "gen.fal_fail", {
      genId,
      userId: user.id,
      totalMs: Date.now() - startedAt,
      ...errInfo(e),
    });
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json(
      timedOut
        ? { error: "generation_timeout" }
        : { error: "generation_failed", detail: msg },
      { status: timedOut ? 504 : 500 }
    );
  } finally {
    if (facePath) {
      // await — fire-and-forget 면 응답 후 람다가 얼어 원본이 안 지워질 수 있음
      // (정책: 업로드 원본 즉시 폐기). 실패해도 응답엔 영향 없게 swallow.
      try {
        await deleteFaceTmp(facePath);
      } catch (e) {
        log.warn("gen.face_cleanup_fail", { genId, ...errInfo(e) });
      }
    }
  }
}
