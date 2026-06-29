import "server-only";
import * as Sentry from "@sentry/nextjs";
import { fal } from "@fal-ai/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVER_ENV } from "@/lib/env.server";
import { DOLLS_BUCKET, candidatePrefix } from "@/lib/generation";
import { logCreditEvent } from "@/lib/credit-ledger";
import { log, errInfo } from "@/lib/log";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/** 활성 provider 와 동일 — request_id 는 이 엔드포인트에 등록됨 */
const FLUX_PULID = "fal-ai/flux-pulid";
const COST_CENTS_PER_IMAGE = 4;

type SrcImage = { url: string; width: number; height: number };
export type CandidateImage = { url: string; width: number; height: number };
/** 복사 결과 — copied=false 면 url 은 원본(fal) url 폴백(즉시 노출용, 곧 만료) */
export type CopiedCandidate = CandidateImage & { copied: boolean };

// 방금 생성된 fal 이미지는 CDN 전파에 시간이 걸릴 수 있어 넉넉히. 실패 시 1회 재시도.
const COPY_FETCH_TIMEOUT_MS = 15_000;
const COPY_ATTEMPTS = 2;

/** 한 장을 fetch+upload (재시도 포함). 끝내 실패하면 copied:false + 원본 url 폴백. */
async function copyOne(
  admin: SupabaseClient,
  prefix: string,
  img: SrcImage,
  index: number,
  genId: string
): Promise<CopiedCandidate> {
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(img.url, {
        signal: AbortSignal.timeout(COPY_FETCH_TIMEOUT_MS),
      });
      if (!r.ok) {
        log.warn("gen.candidate_copy_fail", {
          genId,
          index,
          attempt,
          stage: "fetch",
          httpStatus: r.status,
        });
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const path = `${prefix}/${index}.jpg`;
      const { error: upErr } = await admin.storage
        .from(DOLLS_BUCKET)
        .upload(path, buf, { contentType: "image/jpeg", upsert: true });
      if (upErr) {
        log.warn("gen.candidate_copy_fail", {
          genId,
          index,
          attempt,
          stage: "upload",
          ...errInfo(upErr),
        });
        continue;
      }
      return {
        // private 버킷 — 경로 저장(candidate_urls). /api/generations 가 읽을 때 서명. getPublicUrl 미사용.
        url: path,
        width: img.width,
        height: img.height,
        copied: true,
      };
    } catch (e) {
      log.warn("gen.candidate_copy_fail", {
        genId,
        index,
        attempt,
        stage: "throw",
        ...errInfo(e),
      });
    }
  }
  // 재시도 모두 실패 — 원본(fal) url 폴백. 즉시 고르기엔 유효하나 만료되므로
  // candidate_urls(durable storage 전용)엔 넣지 않는다(copied:false).
  log.warn("gen.candidate_copy_giveup", { genId, index });
  return { url: img.url, width: img.width, height: img.height, copied: false };
}

/**
 * fal 결과 이미지들을 우리 Supabase storage 로 복사 (fal URL 은 만료되므로).
 * 입력 순서 보존. 복사 실패 칸은 copied:false + 원본 url 폴백(즉시 노출용).
 * 호출부는 copied 플래그로 candidate_urls(durable) 여부를 가른다. fal route·복구가 공유.
 */
export async function copyCandidatesToStorage(
  admin: SupabaseClient,
  ownerId: string,
  genId: string,
  images: SrcImage[]
): Promise<CopiedCandidate[]> {
  const prefix = candidatePrefix(ownerId, genId);
  return Promise.all(
    images.map((img, i) => copyOne(admin, prefix, img, i, genId))
  );
}

export type RecoverResult = {
  /** ready: 복구 완료(후보 있음) / pending: fal 아직 처리 중(더 기다림) / failed: 복구 불가 */
  status: "ready" | "pending" | "failed";
  candidateUrls: string[];
  /**
   * failed 가 **결정적**(fal 이 전부 멈춤[COMPLETED/ERROR]인데 쓸 결과 0 → 재시도 무의미)인지.
   * true 면 호출부가 30분 대기 없이 *즉시* failed 마킹 + 환불 + 유저 안내(보통 no-face).
   * copy 실패 등 transient 는 false(=미설정) → 마감(30분)까지 더 기다림.
   */
  definitive?: boolean;
  /** 실패 사유(어드민 fail_reason 기록용): no_face | fal_error | no_requests. transient 면 미설정. */
  reason?: string;
};

/**
 * queued 박제 row 를 fal 에 다시 물어 복구.
 * 저장된 request_id 들로 status 폴링 → COMPLETED 면 result fetch → 후보 복사 → done 마킹.
 * 추가 생성 비용 없음(이미 만들어진 결과를 받아올 뿐).
 *
 * forceFinalize=false 이면 아직 도는 request 가 있을 때 pending 으로 더 기다린다
 * (스트래글러 회수 — 보통 곧 따라 끝남). true(마감 도달)면 완료분만으로 확정해
 * 진행분을 잃더라도 받은 만큼은 살린다.
 */
export async function recoverQueuedGeneration(
  admin: SupabaseClient,
  ownerId: string,
  genId: string,
  requestIds: string[],
  forceFinalize: boolean
): Promise<RecoverResult> {
  if (requestIds.length === 0)
    return { status: "failed", candidateUrls: [], definitive: true, reason: "no_requests" };

  // 1) 각 request 상태 조회 (결과 만료/없음이면 throw → ERROR 취급)
  const statuses = await Sentry.startSpan(
    {
      name: "gen.fal_status",
      op: "fal.queue.status",
      attributes: { genId, requests: requestIds.length },
    },
    () =>
      Promise.all(
        requestIds.map(async (rid) => {
          try {
            const s = await fal.queue.status(FLUX_PULID, { requestId: rid });
            return s.status as string;
          } catch (e) {
            log.warn("gen.recover_status_fail", {
              genId,
              requestId: rid,
              ...errInfo(e),
            });
            return "ERROR";
          }
        })
      )
  );
  const completedIdx = statuses
    .map((s, i) => (s === "COMPLETED" ? i : -1))
    .filter((i) => i >= 0);
  const stillRunning = statuses.some(
    (s) => s === "IN_PROGRESS" || s === "IN_QUEUE"
  );

  // 아직 도는 request 가 있고 마감 전이면 — 완료분이 있어도 더 기다린다.
  // (성급히 done 마킹하면 곧 끝날 나머지 후보를 영구히 잃음)
  if (stillRunning && !forceFinalize) {
    return { status: "pending", candidateUrls: [] };
  }

  // 여기 도달 = 전부 멈췄거나(완료/에러) 마감 도달 → 완료분으로 확정.
  if (completedIdx.length === 0) {
    // 도는 게 없는데 완료도 0 = 전부 ERROR(fal 측 실패) → 결정적.
    return {
      status: "failed",
      candidateUrls: [],
      definitive: !stillRunning,
      reason: stillRunning ? undefined : "fal_error",
    };
  }

  // 2) 완료분 결과 fetch
  const images = (
    await Sentry.startSpan(
      {
        name: "gen.fal_result",
        op: "fal.queue.result",
        attributes: { genId, completed: completedIdx.length },
      },
      () =>
        Promise.all(
          completedIdx.map(async (i) => {
            try {
              const res = await fal.queue.result(FLUX_PULID, {
                requestId: requestIds[i],
              });
          const data = res.data as {
            images?: { url: string; width?: number; height?: number }[];
          };
          return (data.images ?? []).map((im) => ({
            url: im.url,
            width: im.width ?? 1024,
            height: im.height ?? 1024,
          }));
        } catch (e) {
          log.warn("gen.recover_result_fail", {
            genId,
            requestId: requestIds[i],
            ...errInfo(e),
          });
          return [];
        }
      })
        )
    )
  ).flat();

  // COMPLETED 인데 결과를 못 받음(facexlib no-face 400·result 만료/404) → 결정적 실패(재시도해도 동일).
  if (images.length === 0) {
    return { status: "failed", candidateUrls: [], definitive: true, reason: "no_face" };
  }

  // 3) 후보 복사 + done 마킹. 복구는 durable storage url 만 사용
  // (fal queue.result url 도 만료 → resume 때 깨질 수 있어 copied 만).
  const copied = await Sentry.startSpan(
    {
      name: "gen.copy_candidates",
      op: "storage.copy",
      attributes: { genId, images: images.length },
    },
    () => copyCandidatesToStorage(admin, ownerId, genId, images)
  );
  const stored = copied.filter((c) => c.copied);
  if (stored.length === 0) {
    return { status: "failed", candidateUrls: [] };
  }
  if (stored.length < images.length) {
    log.warn("gen.recover_candidate_copy_partial", {
      genId,
      copied: stored.length,
      total: images.length,
    });
  }

  const urls = stored.map((c) => c.url);
  const doneRow = {
    status: "done",
    // 실제 받은 이미지 수 기준 — fal route(images.length)와 일치
    cost_cents: COST_CENTS_PER_IMAGE * images.length,
    fal_request_id: `flux-pulid:${genId}:recovered`,
  };
  const { error: doneErr } = await admin
    .from("ai_generations")
    .update({ ...doneRow, candidate_urls: urls })
    .eq("id", genId);
  // migration 0005 (candidate_urls) 미적용 환경 fallback
  if (doneErr && doneErr.message.includes("candidate_urls")) {
    await admin.from("ai_generations").update(doneRow).eq("id", genId);
  } else if (doneErr) {
    log.error("gen.recover_done_update_fail", { genId, ...errInfo(doneErr) });
  }

  log.info("gen.recovered", {
    ownerId,
    genId,
    candidatesSaved: stored.length,
    completedReqs: completedIdx.length,
    stillRunning,
    forced: forceFinalize,
  });
  return { status: "ready", candidateUrls: urls };
}

/**
 * 비동기 생성 실패를 **1회만** 처리 — `status` 전이 가드로 폴링(3.5s)·cron 스윕·동시요청에 멱등.
 * status 가 아직 failed 가 아닐 때만 failed 마킹 → 그 전이가 일어난 호출에서만 생성권 환불(이중환불 방지).
 * ops(테스트 계정)는 제출 시 차감을 안 했으니 환불 스킵. (generations 폴링 + gen-recover cron 공용.)
 */
export async function failGeneration(
  admin: SupabaseClient,
  genId: string,
  userId: string,
  isOps: boolean,
  reason?: string
): Promise<void> {
  const patch = reason ? { status: "failed", fail_reason: reason } : { status: "failed" };
  let { data: flipped, error } = await admin
    .from("ai_generations")
    .update(patch)
    .eq("id", genId)
    .neq("status", "failed")
    .select("id");
  // 0046(fail_reason) 미적용 환경 — 사유만 빼고 재시도(마킹/환불은 반드시 보존).
  if (error && reason && error.message.includes("fail_reason")) {
    ({ data: flipped, error } = await admin
      .from("ai_generations")
      .update({ status: "failed" })
      .eq("id", genId)
      .neq("status", "failed")
      .select("id"));
  }
  if (error) {
    log.warn("gen.fail_mark_error", { genId, ...errInfo(error) });
    return;
  }
  if ((flipped?.length ?? 0) > 0 && !isOps) {
    const { data: bal, error: rErr } = await admin.rpc("refund_gen_credit", { p_user: userId });
    if (rErr) {
      log.error("gen.fail_refund_error", { genId, userId, ...errInfo(rErr) });
    } else {
      log.info("gen.fail_refunded", { genId, userId });
      await logCreditEvent(admin, {
        userId,
        delta: 1,
        eventType: "gen_refund",
        balanceAfter: typeof bal === "number" ? bal : null,
        refGenId: genId,
      });
    }
  }
}
