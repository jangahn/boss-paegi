import "server-only";
import { fal } from "@fal-ai/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVER_ENV } from "@/lib/env.server";
import { DOLLS_BUCKET, candidatePrefix } from "@/lib/generation";
import { log, errInfo } from "@/lib/log";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/** 활성 provider 와 동일 — request_id 는 이 엔드포인트에 등록됨 */
const FLUX_PULID = "fal-ai/flux-pulid";
const COST_CENTS_PER_IMAGE = 4;

type SrcImage = { url: string; width: number; height: number };
export type CandidateImage = { url: string; width: number; height: number };

/**
 * fal 결과 이미지들을 우리 Supabase storage 로 복사 (fal URL 은 만료되므로).
 * 부분 실패는 건너뛰고 성공분만 반환. fal route·복구가 공유.
 */
export async function copyCandidatesToStorage(
  admin: SupabaseClient,
  ownerId: string,
  genId: string,
  images: SrcImage[]
): Promise<CandidateImage[]> {
  const prefix = candidatePrefix(ownerId, genId);
  const copied = await Promise.all(
    images.map(async (img, i) => {
      try {
        // per-fetch 타임아웃 — fal CDN 지연이 함수 한도까지 끌고 가지 않게.
        const r = await fetch(img.url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) {
          log.warn("gen.candidate_copy_fail", {
            genId,
            index: i,
            stage: "fetch",
            httpStatus: r.status,
          });
          return null;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        const path = `${prefix}/${i}.jpg`;
        const { error: upErr } = await admin.storage
          .from(DOLLS_BUCKET)
          .upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (upErr) {
          log.warn("gen.candidate_copy_fail", {
            genId,
            index: i,
            stage: "upload",
            ...errInfo(upErr),
          });
          return null;
        }
        return {
          url: admin.storage.from(DOLLS_BUCKET).getPublicUrl(path).data
            .publicUrl,
          width: img.width,
          height: img.height,
        };
      } catch (e) {
        log.warn("gen.candidate_copy_fail", {
          genId,
          index: i,
          stage: "throw",
          ...errInfo(e),
        });
        return null;
      }
    })
  );
  return copied.filter((c): c is CandidateImage => c !== null);
}

export type RecoverResult = {
  /** ready: 복구 완료(후보 있음) / pending: fal 아직 처리 중(더 기다림) / failed: 복구 불가 */
  status: "ready" | "pending" | "failed";
  candidateUrls: string[];
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
  if (requestIds.length === 0) return { status: "failed", candidateUrls: [] };

  // 1) 각 request 상태 조회 (결과 만료/없음이면 throw → ERROR 취급)
  const statuses = await Promise.all(
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
    return { status: "failed", candidateUrls: [] };
  }

  // 2) 완료분 결과 fetch
  const images = (
    await Promise.all(
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
  ).flat();

  // COMPLETED 인데 결과를 못 받음(만료/404) → 실패 (재시도해도 동일)
  if (images.length === 0) {
    return { status: "failed", candidateUrls: [] };
  }

  // 3) 후보 복사 + done 마킹
  const candidates = await copyCandidatesToStorage(admin, ownerId, genId, images);
  if (candidates.length === 0) {
    return { status: "failed", candidateUrls: [] };
  }
  if (candidates.length < images.length) {
    // fal route 와 동일하게 partial 복사를 추적 (storage 업로드 일부 실패)
    log.warn("gen.recover_candidate_copy_partial", {
      genId,
      copied: candidates.length,
      total: images.length,
    });
  }

  const urls = candidates.map((c) => c.url);
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
    candidatesSaved: candidates.length,
    completedReqs: completedIdx.length,
    stillRunning,
    forced: forceFinalize,
  });
  return { status: "ready", candidateUrls: urls };
}
