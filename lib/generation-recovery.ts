import "server-only";
import * as Sentry from "@sentry/nextjs";
import { fal } from "@fal-ai/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVER_ENV } from "@/lib/env.server";
import {
  DOLLS_BUCKET,
  candidatePrefix,
  cleanupCandidateStorage,
} from "@/lib/generation";
import {
  candidateIndexFromPath,
  candidateRequests,
  hasUnresolvedSubmitAcknowledgement,
  isRecoverableGeneration,
  mergeCandidatePaths,
} from "@/lib/character-gen/generation-state";
import {
  ownerStateFromProfileRead,
  runOwnerGuardedCopy,
  type GenerationOwnerState,
  type OwnerGuardedCopyResult,
} from "@/lib/character-gen/owner-lifecycle";
import {
  claimGenerationArtifactWrite,
  releaseGenerationArtifactWrite,
} from "@/lib/character-gen/generation-artifact-write";
import { parseGenerationFailureRpcResult } from "@/lib/character-gen/generation-failure-result";
import { log, errInfo } from "@/lib/log";
import {
  parseFluxPulidResult,
  parsePersistedFluxPulidResults,
} from "@/lib/character-gen/flux-pulid-result-contract";
import {
  DOLL_IMAGE_DOWNLOAD_MAX_BYTES,
} from "@/lib/media-download";
import { fetchPrivateFalMediaBlob } from "@/lib/character-gen/fal-private-media";
import { assertGeneratedImageEvidence } from "@/lib/image-utils";
import { removeStorageObjects } from "@/lib/supabase-operation";

fal.config({ credentials: SERVER_ENV.FAL_KEY });

/** 활성 provider 와 동일 — request_id 는 이 엔드포인트에 등록됨 */
const FLUX_PULID = "fal-ai/flux-pulid";
const COST_CENTS_PER_IMAGE = 4;

async function readGenerationOwnerState(
  admin: SupabaseClient,
  ownerId: string,
  genId: string,
): Promise<GenerationOwnerState> {
  try {
    const result = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", ownerId)
      .maybeSingle();
    const state = ownerStateFromProfileRead(result);
    if (state === "unavailable") {
      log.warn("gen.recover_owner_guard_fail", {
        ownerId,
        genId,
        ...(result.error ? errInfo(result.error) : { reason: "profile_missing" }),
      });
    }
    return state;
  } catch (error) {
    log.warn("gen.recover_owner_guard_fail", {
      ownerId,
      genId,
      ...errInfo(error),
    });
    return "unavailable";
  }
}

type SrcImage = { url: string; width: number; height: number };
export type CandidateImage = { url: string; width: number; height: number };
/** 복사 결과 — copied=false 면 url 은 원본(fal) url 폴백(즉시 노출용, 곧 만료). index=원 candidate index(재번호화 금지). */
export type CopiedCandidate = CandidateImage & { copied: boolean; index: number };

// 방금 생성된 fal 이미지는 CDN 전파에 시간이 걸릴 수 있어 넉넉히. 실패 시 1회 재시도.
const COPY_FETCH_TIMEOUT_MS = 15_000;
const COPY_ATTEMPTS = 2;

async function scrubGenerationProviderOutputs(
  admin: SupabaseClient,
  ownerId: string,
  genId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "scrub_generation_submit_provider_outputs",
    {
      p_gen_id: genId,
      p_owner_id: ownerId,
    },
  );
  const result =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (
    error ||
    result?.ok !== true ||
    (result.outcome !== "scrubbed" &&
      result.outcome !== "already_scrubbed") ||
    !Number.isSafeInteger(result.scrubbed) ||
    (result.scrubbed as number) < 0
  ) {
    log.error("gen.provider_output_scrub_fail", {
      ownerId,
      genId,
      outcome:
        typeof result?.outcome === "string" ? result.outcome : "invalid",
      ...(error ? errInfo(error) : {}),
    });
    return false;
  }
  return true;
}

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
      const downloaded = await fetchPrivateFalMediaBlob({
        url: img.url,
        credentials: SERVER_ENV.FAL_KEY,
        kind: "image",
        maxBytes: DOLL_IMAGE_DOWNLOAD_MAX_BYTES,
        signal: AbortSignal.timeout(COPY_FETCH_TIMEOUT_MS),
      });
      if (
        downloaded.type !== "image/jpeg" &&
        downloaded.type !== "image/png"
      ) {
        throw new Error("candidate_media_type_invalid");
      }
      const buf = Buffer.from(await downloaded.blob.arrayBuffer());
      await assertGeneratedImageEvidence(buf, {
        width: img.width,
        height: img.height,
      });
      const path = `${prefix}/${index}.jpg`;
      const { error: upErr } = await admin.storage
        .from(DOLLS_BUCKET)
        .upload(path, buf, { contentType: downloaded.type, upsert: true });
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
        index,
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
  return { url: img.url, width: img.width, height: img.height, copied: false, index };
}

/**
 * fal 결과 이미지들을 우리 Supabase storage 로 복사 (fal URL 은 만료되므로).
 * **각 항목의 명시적 candidateIndex 로 저장**({prefix}/{index}.jpg) — 배열 위치 재번호화 금지
 * (후보 0 실패·1·2 성공이어도 파일명·pickedIndex 가 1·2 유지). 복사 실패 칸은 copied:false + 원본 url 폴백.
 */
export async function copyCandidatesToStorage(
  admin: SupabaseClient,
  ownerId: string,
  genId: string,
  items: { index: number; image: SrcImage }[]
): Promise<CopiedCandidate[]> {
  const prefix = candidatePrefix(ownerId, genId);
  return Promise.all(
    items.map((it) => copyOne(admin, prefix, it.image, it.index, genId))
  );
}

export type RecoverResult = {
  /** terminal: 다른 전이(pick/fail/expire)가 이겨 더 이상 복구하면 안 됨. */
  status:
    | "ready"
    | "pending"
    | "failed"
    | "terminal"
    | "owner_deleted";
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
  requestSlots: unknown,
  forceFinalize: boolean
): Promise<RecoverResult> {
  // 네트워크 작업 전에 DB 상태/버전을 고정해 terminal row나 이미 환급된 row를
  // 되살리지 않는다. 최종 update도 같은 version으로 CAS한다.
  const { data: generation, error: generationError } = await admin
    .from("ai_generations")
    .select("status, refunded_at, version, candidate_urls, gen_params")
    .eq("id", genId)
    .eq("owner_id", ownerId)
    .eq("cost_preflight_pending", false)
    .maybeSingle();
  if (generationError) {
    log.warn("gen.recover_guard_fail", { genId, ...errInfo(generationError) });
    return { status: "pending", candidateUrls: [] };
  }
  if (
    !generation ||
    !isRecoverableGeneration(generation.status, generation.refunded_at)
  ) {
    return { status: "terminal", candidateUrls: [] };
  }

  // fal status/result 같은 외부 조회 전에 deleted owner를 fail-closed로 배제한다.
  // unavailable도 provider 호출을 하지 않고 다음 cron/poll에서 재시도한다.
  const initialOwnerState = await readGenerationOwnerState(
    admin,
    ownerId,
    genId,
  );
  if (initialOwnerState === "deleted") {
    return { status: "owner_deleted", candidateUrls: [] };
  }
  if (initialOwnerState === "unavailable") {
    return { status: "pending", candidateUrls: [] };
  }

  const requests = candidateRequests(requestSlots, generation.gen_params);
  if (hasUnresolvedSubmitAcknowledgement(generation.gen_params)) {
    return { status: "pending", candidateUrls: [] };
  }
  if (requests.length === 0)
    return { status: "failed", candidateUrls: [], definitive: true, reason: "no_requests" };

  // Store-IO is disabled at submission time. A verified webhook therefore
  // persists the exact canonical output before provider retention can expire.
  // Fail closed before any provider call when that durable evidence cannot be
  // read; otherwise a transient database outage could hide a completed result.
  const { data: persistedData, error: persistedError } = await admin.rpc(
    "list_generation_submit_provider_outputs",
    {
      p_gen_id: genId,
      p_owner_id: ownerId,
    },
  );
  const persistedEnvelope =
    persistedData &&
    typeof persistedData === "object" &&
    !Array.isArray(persistedData)
      ? (persistedData as Record<string, unknown>)
      : null;
  const persistedOutputs =
    !persistedError &&
    persistedEnvelope?.ok === true &&
    persistedEnvelope.outcome === "listed" &&
    Object.keys(persistedEnvelope).sort().join(",") ===
      "ok,outcome,outputs"
      ? parsePersistedFluxPulidResults(persistedEnvelope.outputs)
      : null;
  if (persistedOutputs === null) {
    log.warn("gen.recover_persisted_outputs_unavailable", {
      genId,
      ...(persistedError ? errInfo(persistedError) : {}),
    });
    return { status: "pending", candidateUrls: [] };
  }
  const persistedByIndex = new Map(
    persistedOutputs.map((item) => [item.candidateIndex, item]),
  );
  const requestByIndex = new Map(
    requests.map((request) => [request.index, request.requestId]),
  );
  if (
    persistedOutputs.some(
      (item) => requestByIndex.get(item.candidateIndex) !== item.requestId,
    )
  ) {
    log.error("gen.recover_persisted_output_binding_conflict", { genId });
    return { status: "pending", candidateUrls: [] };
  }

  // 1) Durable webhook output wins. Only unresolved slots query provider state.
  // A result endpoint may disappear immediately because X-Fal-Store-IO=0.
  const statuses = await Sentry.startSpan(
    {
      name: "gen.fal_status",
      op: "fal.queue.status",
      attributes: { genId, requests: requests.length },
    },
    () =>
      Promise.all(
        requests.map(async ({ requestId, index }) => {
          if (persistedByIndex.has(index)) return "COMPLETED_PERSISTED";
          try {
            const s = await fal.queue.status(FLUX_PULID, { requestId });
            return s.status as string;
          } catch (e) {
            log.warn("gen.recover_status_fail", {
              genId,
              requestId,
              ...errInfo(e),
            });
            return "UNKNOWN";
          }
        })
      )
  );
  const completedIdx = statuses
    .map((s, i) =>
      s === "COMPLETED" || s === "COMPLETED_PERSISTED" ? i : -1,
    )
    .filter((i) => i >= 0);
  const stillRunning = statuses.some(
    (s) => s === "IN_PROGRESS" || s === "IN_QUEUE"
  );
  const hasUnknown = statuses.some((status) => status === "UNKNOWN");

  // 아직 도는 request 가 있고 마감 전이면 — 완료분이 있어도 더 기다린다.
  // (성급히 done 마킹하면 곧 끝날 나머지 후보를 영구히 잃음)
  if ((stillRunning || hasUnknown) && !forceFinalize) {
    return { status: "pending", candidateUrls: [] };
  }

  // 여기 도달 = 전부 멈췄거나(완료/에러) 마감 도달 → 완료분으로 확정.
  if (completedIdx.length === 0) {
    // status API 예외는 provider 실패와 구분할 수 없는 transient다. 마감 전에는
    // 절대 환급하지 않고, 30분 마감에서만 timeout으로 종결한다.
    return {
      status: "failed",
      candidateUrls: [],
      definitive: forceFinalize || (!stillRunning && !hasUnknown),
      reason:
        stillRunning || hasUnknown
          ? forceFinalize
            ? "timeout"
            : undefined
          : "fal_error",
    };
  }

  const resultOwnerState = await readGenerationOwnerState(
    admin,
    ownerId,
    genId,
  );
  if (resultOwnerState === "deleted") {
    return { status: "owner_deleted", candidateUrls: [] };
  }
  if (resultOwnerState === "unavailable") {
    return { status: "pending", candidateUrls: [] };
  }

  // 2) 완료분 결과 fetch — **원 candidate index 보존**(재번호화 금지). flux-pulid 는
  //    request 당 1장. URL·크기·JPEG·seed·NSFW verdict가 모두 정확한 공식
  //    output만 채택한다. NSFW=true는 완료된 결과지만 저장/노출 대상에서는 제외한다.
  type CandResult = {
    index: number;
    image: SrcImage;
    seed: number;
    nsfw: boolean;
  };
  const results = (
    await Sentry.startSpan(
      {
        name: "gen.fal_result",
        op: "fal.queue.result",
        attributes: { genId, completed: completedIdx.length },
      },
      () =>
        Promise.all(
          completedIdx.map(async (position): Promise<CandResult | null> => {
            const request = requests[position];
            const persisted = persistedByIndex.get(request.index)?.result;
            if (persisted) {
              return {
                index: request.index,
                image: persisted.image,
                seed: persisted.seed,
                nsfw: persisted.nsfw,
              };
            }
            try {
              const res = await fal.queue.result(FLUX_PULID, {
                requestId: request.requestId,
              });
              const parsed = parseFluxPulidResult(res.data);
              if (!parsed) return null;
              return {
                index: request.index,
                image: parsed.image,
                seed: parsed.seed,
                nsfw: parsed.nsfw,
              };
            } catch (e) {
              log.warn("gen.recover_result_fail", {
                genId,
                requestId: request.requestId,
                ...errInfo(e),
              });
              return null;
            }
          })
        )
    )
  ).filter((r): r is CandResult => r !== null);
  const safeResults = results.filter((result) => !result.nsfw);
  const unsafeResults = results.filter((result) => result.nsfw);

  const rawExistingUrls = Array.isArray(generation.candidate_urls)
    ? generation.candidate_urls.filter(
        (url): url is string => typeof url === "string" && url.length > 0
      )
    : [];
  const unsafeIndexes = new Set(
    unsafeResults.map((result) => result.index),
  );
  const quarantinedUrls = rawExistingUrls.filter((url) => {
    const index = candidateIndexFromPath(url);
    return index !== null && unsafeIndexes.has(index);
  });
  if (quarantinedUrls.length > 0) {
    try {
      await removeStorageObjects(
        "gen.unsafe_candidate_quarantine",
        quarantinedUrls,
        (paths) => admin.storage.from(DOLLS_BUCKET).remove(paths),
        (path) => admin.storage.from(DOLLS_BUCKET).exists(path),
      );
    } catch (error) {
      log.error("gen.unsafe_candidate_quarantine_fail", {
        genId,
        indexes: [...unsafeIndexes],
        ...errInfo(error),
      });
      return { status: "pending", candidateUrls: [] };
    }
  }
  const existingUrls = rawExistingUrls.filter(
    (url) => !quarantinedUrls.includes(url),
  );
  const existingIndexes = new Set(
    existingUrls
      .map(candidateIndexFromPath)
      .filter((index): index is number => index !== null)
  );
  // Unsafe is a resolved provider result, not an indefinitely retryable
  // malformed result. It therefore closes this completed slot without storage.
  const resultIndexes = new Set(results.map((result) => result.index));
  const unresolvedCompleted = completedIdx.some((position) => {
    const index = requests[position].index;
    return !existingIndexes.has(index) && !resultIndexes.has(index);
  });

  // COMPLETED 뒤 result fetch도 네트워크/공급자 오류가 날 수 있다. 마감 전에는 재시도하고,
  // 마감에서도 기존에 영속한 후보가 없을 때만 결정적 실패로 종결한다.
  if (unresolvedCompleted && !forceFinalize) {
    return { status: "pending", candidateUrls: [] };
  }
  if (safeResults.length === 0 && existingUrls.length === 0) {
    if (unsafeResults.length > 0 && !unresolvedCompleted) {
      return {
        status: "failed",
        candidateUrls: [],
        definitive: true,
        reason: "unsafe_content",
      };
    }
    return forceFinalize
      ? { status: "failed", candidateUrls: [], definitive: true, reason: "no_face" }
      : { status: "pending", candidateUrls: [] };
  }

  // 3) 후보 복사 — **원 candidate index 로 저장**({prefix}/{index}.jpg). 이미 DB에
  // 기록된 canonical index는 다시 upsert하지 않아 lifecycle race 보상삭제가 기존 후보를
  // 지우지 않게 한다. copy 직전·직후 owner를 재확인하고 탈퇴가 이기면 prefix를 정리한다.
  const missingResults = safeResults.filter(
    (result) => !existingIndexes.has(result.index),
  );
  let writeLeaseToken: string | null = null;
  if (missingResults.length > 0) {
    const claim = await claimGenerationArtifactWrite(() =>
      admin.rpc("claim_generation_artifact_write", {
        p_gen_id: genId,
        p_expected_version: generation.version,
        p_lease_seconds: 600,
      }),
    );
    if (!claim.ok) {
      log.info("gen.recover_write_lease_blocked", {
        ownerId,
        genId,
        outcome: claim.outcome,
        ...(claim.error ? errInfo(claim.error) : {}),
      });
      return {
        status:
          claim.outcome === "conflict" || claim.outcome === "not_found"
            ? "terminal"
            : "pending",
        candidateUrls: [],
      };
    }
    writeLeaseToken = claim.leaseToken;
  }

  let guardedCopy: OwnerGuardedCopyResult<CopiedCandidate[]>;
  try {
    guardedCopy = await runOwnerGuardedCopy({
      readOwnerState: () => readGenerationOwnerState(admin, ownerId, genId),
      copy: () =>
        missingResults.length > 0
          ? Sentry.startSpan(
              {
                name: "gen.copy_candidates",
                op: "storage.copy",
                attributes: { genId, images: missingResults.length },
              },
              () =>
                copyCandidatesToStorage(
                  admin,
                  ownerId,
                  genId,
                  missingResults.map((r) => ({
                    index: r.index,
                    image: r.image,
                  })),
                ),
            )
          : Promise.resolve([]),
      cleanupCopied: () => cleanupCandidateStorage(admin, ownerId, genId),
    });
  } finally {
    if (writeLeaseToken) {
      const released = await releaseGenerationArtifactWrite(() =>
        admin.rpc("release_generation_artifact_write", {
          p_gen_id: genId,
          p_lease_token: writeLeaseToken,
        }),
      );
      if (!released.ok) {
        log.warn("gen.recover_write_lease_release_fail", {
          ownerId,
          genId,
          outcome: released.outcome,
          ...errInfo(released.error),
        });
      }
    }
  }
  if (guardedCopy.kind === "blocked") {
    if (guardedCopy.cleanupError) {
      log.error("gen.recover_deleted_owner_cleanup_fail", {
        ownerId,
        genId,
        ...errInfo(guardedCopy.cleanupError),
      });
    }
    return {
      status:
        guardedCopy.ownerState === "deleted" ? "owner_deleted" : "pending",
      candidateUrls: [],
    };
  }
  const copied = guardedCopy.value;
  const stored = copied.filter((c) => c.copied);
  if (stored.length === 0 && existingUrls.length === 0) {
    return { status: "failed", candidateUrls: [] };
  }
  if (stored.length < safeResults.length) {
    log.warn("gen.recover_candidate_copy_partial", {
      genId,
      copied: stored.length,
      total: safeResults.length,
    });
  }

  // candidate index 순 정렬 — **누락분 앞당김 없음**(path 가 실 index 보유, pick 이 path 로 판단).
  const urls = mergeCandidatePaths(
    existingUrls,
    stored.slice().sort((a, b) => a.index - b.index).map((c) => c.url)
  );
  const completedCandidateIndexes = new Set(
    safeResults.map((result) => result.index),
  );
  const durableIndexes = new Set(
    urls
      .map(candidateIndexFromPath)
      .filter((index): index is number => index !== null)
  );
  const copyIncomplete = [...completedCandidateIndexes].some(
    (index) => !durableIndexes.has(index)
  );
  if (copyIncomplete && !forceFinalize) {
    return { status: "pending", candidateUrls: [] };
  }

  // provenance 후보별 seed/status 단조 병합(completed 는 유지 — 동시 복구가 수렴).
  // guard에서 읽은 동일 version 스냅샷을 사용해 TOCTOU를 피한다.
  const storedIdx = new Set(stored.map((c) => c.index));
  let mergedGenParams: unknown | undefined = undefined;
  try {
    const gp = structuredClone(generation.gen_params) as
      | { generation?: { candidates?: unknown[] } }
      | null
      | undefined;
    const cands = gp?.generation?.candidates;
    if (gp && Array.isArray(cands)) {
      const byIdx = new Map(results.map((r) => [r.index, r]));
      (gp.generation as { candidates: unknown[] }).candidates = cands.map((raw) => {
        const c = raw as { index?: number; status?: string };
        const r = typeof c.index === "number" ? byIdx.get(c.index) : undefined;
        if (r?.nsfw) {
          return {
            ...c,
            status: "failed",
            seed: r.seed,
            hasNsfw: true,
          };
        }
        if (r && storedIdx.has(c.index as number) && c.status !== "completed") {
          return { ...c, status: "completed", seed: r.seed, hasNsfw: r.nsfw };
        }
        return c;
      });
      mergedGenParams = gp;
    }
  } catch (e) {
    log.warn("gen.recover_provenance_merge_fail", { genId, ...errInfo(e) });
  }

  // 4) done 마킹 — status/cost_cents/fal_request_id/candidate_urls(+gen_params) 전부 operational(§13 0063+0070).
  //    **영속 성공 전 ready 반환 금지**(DB 실패=transient → pending 재시도, ready 위장 X). 리터럴 payload(eslint 정적검증).
  const billedIndexes = new Set([
    ...existingIndexes,
    ...results.map((result) => result.index),
  ]);
  const doneCostCents = COST_CENTS_PER_IMAGE * billedIndexes.size;
  const doneFalRequestId = `flux-pulid:${genId}:recovered`;
  const doneResult =
    mergedGenParams !== undefined
      ? await admin
          .from("ai_generations")
          .update({
            status: "done",
            cost_cents: doneCostCents,
            fal_request_id: doneFalRequestId,
            candidate_urls: urls,
            gen_params: mergedGenParams,
          })
          .eq("id", genId)
          .eq("version", generation.version)
          .eq("cost_preflight_pending", false)
          .in("status", ["queued", "done"])
          .is("refunded_at", null)
          .select("id")
      : await admin
          .from("ai_generations")
          .update({
            status: "done",
            cost_cents: doneCostCents,
            fal_request_id: doneFalRequestId,
            candidate_urls: urls,
          })
          .eq("id", genId)
          .eq("version", generation.version)
          .eq("cost_preflight_pending", false)
          .in("status", ["queued", "done"])
          .is("refunded_at", null)
          .select("id");
  if (doneResult.error) {
    log.error("gen.recover_done_update_fail", {
      genId,
      ...errInfo(doneResult.error),
    });
    return { status: "pending", candidateUrls: [] };
  }
  if ((doneResult.data?.length ?? 0) === 0) {
    log.info("gen.recover_cas_lost", { genId, expectedVersion: generation.version });
    const [ownerState, currentResult] = await Promise.all([
      readGenerationOwnerState(admin, ownerId, genId),
      admin
        .from("ai_generations")
        .select("status, refunded_at")
        .eq("id", genId)
        .eq("owner_id", ownerId)
        .maybeSingle(),
    ]);
    const currentStatus = currentResult.data?.status;
    const currentTerminal =
      !currentResult.error &&
      (!currentResult.data ||
        !isRecoverableGeneration(
          currentStatus,
          currentResult.data.refunded_at,
        ));
    if (ownerState === "deleted" || currentTerminal) {
      try {
        await cleanupCandidateStorage(admin, ownerId, genId);
      } catch (cleanupError) {
        // legacy/in-flight marker가 이미 완료였어도 NULL로 재개방해 terminal
        // artifact cron이 보상삭제를 다시 시도하게 한다.
        const { data: reopened, error: reopenError } = await admin.rpc(
          "reopen_generation_artifact_cleanup",
          { p_gen_id: genId },
        );
        const reopenOutcome = (
          reopened as { outcome?: string } | null
        )?.outcome;
        log.error("gen.recover_cas_cleanup_fail", {
          ownerId,
          genId,
          currentStatus,
          reopenOutcome: reopenOutcome ?? "unknown",
          ...(reopenError
            ? { reopenError: errInfo(reopenError) }
            : {}),
          ...errInfo(cleanupError),
        });
      }
    }
    if (ownerState === "deleted") {
      return { status: "owner_deleted", candidateUrls: [] };
    }
    if (currentTerminal) {
      return { status: "terminal", candidateUrls: [] };
    }
    return { status: "pending", candidateUrls: [] };
  }

  // The durable app copy is now canonical. Seal all three bindings so a late
  // duplicate webhook cannot put a private-CDN URL back into the database.
  // The bounded maintenance pruner retries and reports any failed scrub.
  await scrubGenerationProviderOutputs(admin, ownerId, genId);

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
 * 비동기 생성 실패 처리 — failed 마킹 + 생성권 환급(v2 RPC).
 * **원자성 정본은 DB RPC** — `mark_generation_failed_and_refund` 가 queued/generating(및 미환급 failed)
 * row 를 한 트랜잭션에서 status='failed' 전이 + 환급을 수행하고 `refunded_at` 으로 멱등(이중환불 방어·
 * 소비 없던 row 는 no_consume). done/picked/expired 같은 terminal row는 절대 failed로 되돌리지 않는다.
 * ops(테스트 계정)는 소비가 없어 queued→failed 조건부 전이만 수행.
 * (generations 폴링 + gen-recover cron 공용 — 동시 호출은 RPC 멱등으로 안전.)
 */
export async function failGeneration(
  admin: SupabaseClient,
  genId: string,
  userId: string,
  reason?: string,
  expectedVersion?: number,
): Promise<boolean> {
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
  ) {
    log.error("gen.fail_invalid_expected_version", {
      genId,
      userId,
      expectedVersion,
    });
    return false;
  }

  // 원자성 우선: RPC 가 flip+환급을 한 트랜잭션에 수행(queued/generating·미환급 failed).
  const { data, error: rErr } = await admin.rpc("mark_generation_failed_and_refund", {
    p_gen_id: genId,
    p_fail_reason: reason ?? "unknown",
    p_expected_version: expectedVersion ?? null,
  });
  if (!rErr) {
    const result = parseGenerationFailureRpcResult(data);
    if (result?.ok) {
      log.info("gen.fail_refunded", {
        genId,
        userId,
        outcome: result.outcome,
      });
      await scrubGenerationProviderOutputs(admin, userId, genId);
      return true;
    }
    if (result?.outcome === "version_conflict") {
      log.info("gen.fail_version_conflict", {
        genId,
        userId,
        expectedVersion,
      });
      return false;
    }
    log.error("gen.fail_refund_invalid_result", {
      genId,
      userId,
      dataType: data === null ? "null" : typeof data,
    });
    return false;
  }
  if (!rErr.message.includes("invalid_state")) {
    // generation_not_found 등 — 환급 불가, 로그만.
    log.error("gen.fail_refund_error", { genId, userId, ...errInfo(rErr) });
    return false;
  }

  log.info("gen.fail_terminal_noop", { genId, userId });
  return false;
}
