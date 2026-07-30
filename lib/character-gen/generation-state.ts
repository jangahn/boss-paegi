import type { SubmitResult } from "./types.ts";

export const GENERATION_CANDIDATE_COUNT = 3;

export type GenerationState =
  | "queued"
  | "done"
  | "picked"
  | "failed"
  | "expired";

export type GenerationEvent =
  | "recover"
  | "pick"
  | "fail"
  | "expire";

export type CandidateRequest = {
  index: number;
  requestId: string;
};

type ProvenanceCandidate = {
  index?: unknown;
  requestId?: unknown;
  submitState?: unknown;
};

/**
 * DB text[]에는 후보 0..2와 같은 위치를 유지한다. 부분 제출 성공을 압축하면
 * 원래 후보 index가 바뀌므로 실패 칸은 null로 보존한다.
 */
export function requestSlotsFromSubmissions(
  submissions: readonly SubmitResult[],
): (string | null)[] {
  const slots: (string | null)[] = Array(GENERATION_CANDIDATE_COUNT).fill(null);
  for (const submission of submissions) {
    if (
      Number.isInteger(submission.index) &&
      submission.index >= 0 &&
      submission.index < GENERATION_CANDIDATE_COUNT &&
      submission.status === "submitted" &&
      typeof submission.requestId === "string" &&
      submission.requestId.length > 0
    ) {
      slots[submission.index] = submission.requestId;
    }
  }
  return slots;
}

/**
 * 최신 provenance가 있으면 그것을 index 정본으로 사용한다. 없으면 text[] 위치를
 * index로 보는 레거시 계약으로 폴백한다.
 */
export function candidateRequests(
  requestSlots: unknown,
  genParams?: unknown,
): CandidateRequest[] {
  const candidates = (
    genParams as { generation?: { candidates?: unknown } } | null | undefined
  )?.generation?.candidates;
  if (Array.isArray(candidates)) {
    const indexed = candidates
      .map((raw): CandidateRequest | null => {
        const candidate = raw as ProvenanceCandidate;
        if (
          !Number.isInteger(candidate.index) ||
          (candidate.index as number) < 0 ||
          (candidate.index as number) >= GENERATION_CANDIDATE_COUNT ||
          typeof candidate.requestId !== "string" ||
          candidate.requestId.length === 0
        ) {
          return null;
        }
        return {
          index: candidate.index as number,
          requestId: candidate.requestId,
        };
      })
      .filter((candidate): candidate is CandidateRequest => candidate !== null);
    if (indexed.length > 0) {
      return dedupeRequests(indexed);
    }
  }

  if (!Array.isArray(requestSlots)) return [];
  return dedupeRequests(
    requestSlots
      .map((requestId, index): CandidateRequest | null =>
        index < GENERATION_CANDIDATE_COUNT &&
        typeof requestId === "string" &&
        requestId.length > 0
          ? { index, requestId }
          : null,
      )
      .filter((candidate): candidate is CandidateRequest => candidate !== null),
  );
}

function dedupeRequests(requests: readonly CandidateRequest[]): CandidateRequest[] {
  const byIndex = new Map<number, CandidateRequest>();
  const seenIds = new Set<string>();
  for (const request of requests.slice().sort((a, b) => a.index - b.index)) {
    if (byIndex.has(request.index) || seenIds.has(request.requestId)) continue;
    byIndex.set(request.index, request);
    seenIds.add(request.requestId);
  }
  return [...byIndex.values()];
}

export function hasIncompleteCandidates(
  candidateUrls: unknown,
  requestSlots: unknown,
  genParams?: unknown,
): boolean {
  const storedCount = Array.isArray(candidateUrls)
    ? new Set(candidateUrls.filter((url): url is string => typeof url === "string")).size
    : 0;
  return (
    candidateRequests(requestSlots, genParams).length > storedCount ||
    hasUnresolvedSubmitAcknowledgement(genParams)
  );
}

/**
 * A confirmed single-attempt claim without a request id may already exist at
 * fal. It must wait for the signed webhook; neither a retry nor a 30-minute
 * refund is safe while acknowledgement is unresolved.
 */
export function hasUnresolvedSubmitAcknowledgement(
  genParams: unknown,
): boolean {
  const candidates = (
    genParams as { generation?: { candidates?: unknown } } | null | undefined
  )?.generation?.candidates;
  if (!Array.isArray(candidates)) return false;
  return candidates.some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const candidate = raw as ProvenanceCandidate;
    return (
      (candidate.submitState === "submitting" ||
        candidate.submitState === "uncertain") &&
      !(typeof candidate.requestId === "string" && candidate.requestId.length > 0)
    );
  });
}

export function candidateIndexFromPath(path: string): number | null {
  const match = /\/candidates\/[^/]+\/([0-2])\.jpg(?:[?#].*)?$/.exec(path);
  return match ? Number(match[1]) : null;
}

export function mergeCandidatePaths(
  existing: readonly string[],
  recovered: readonly string[],
): string[] {
  const byIndex = new Map<number, string>();
  for (const path of [...existing, ...recovered]) {
    const index = candidateIndexFromPath(path);
    if (index !== null) byIndex.set(index, path);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, path]) => path);
}

export function isRecoverableGeneration(
  status: unknown,
  refundedAt: unknown,
): boolean {
  return (status === "queued" || status === "done") && refundedAt == null;
}

/** 유한 상태 모델의 허용 전이. null은 거부/no-op이며 terminal 상태는 되살아나지 않는다. */
export function nextGenerationState(
  state: GenerationState,
  event: GenerationEvent,
): GenerationState | null {
  if (state === "queued") {
    if (event === "recover") return "done";
    if (event === "fail") return "failed";
    return null;
  }
  if (state === "done") {
    if (event === "recover") return "done";
    if (event === "pick") return "picked";
    if (event === "expire") return "expired";
    return null;
  }
  return null;
}
