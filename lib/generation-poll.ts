import {
  InvalidPendingGenerationsResponseError,
  parsePendingGenerationsResponse,
} from "./pending-generations-response.ts";
import type { RoleId } from "./roles/index.ts";
import { runBoundedClientJsonFetch } from "./client-mutation.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GENERATION_POLL_REQUEST_TIMEOUT_MS = 12_000;

export type GenerationPollResult =
  | { status: "ready"; urls: string[]; role: RoleId }
  | { status: "interrupted"; reason?: "photo" }
  | { status: "unauthorized" }
  | { status: "unavailable" }
  | { status: "timeout" };

export type GenerationPollOptions = {
  fetcher?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  isVisible?: () => boolean;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxVisibleMs?: number;
  intervalMs?: number;
  consecutiveFailureLimit?: number;
};

/**
 * 한 생성의 권위 상태를 폴링한다. 성공 HTTP도 전체 응답 계약을 검증하며,
 * 연속된 HTTP/transport/JSON/shape 실패는 `unavailable`로 끝내 호출자가 새 생성
 * 요청을 막고 오류를 표시할 수 있게 한다.
 */
export async function pollGeneration(
  genId: string,
  isCancelled: () => boolean,
  options: GenerationPollOptions = {},
): Promise<GenerationPollResult> {
  if (!UUID_RE.test(genId)) return { status: "unavailable" };

  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const isVisible =
    options.isVisible ??
    (() =>
      typeof document === "undefined" ||
      document.visibilityState === "visible");
  const maxVisibleMs = options.maxVisibleMs ?? 5 * 60_000;
  const intervalMs = options.intervalMs ?? 3500;
  const failureLimit = options.consecutiveFailureLimit ?? 4;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? GENERATION_POLL_REQUEST_TIMEOUT_MS;
  if (
    !Number.isFinite(maxVisibleMs) ||
    maxVisibleMs < 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 0 ||
    !Number.isSafeInteger(failureLimit) ||
    failureLimit < 1 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 2
  ) {
    throw new Error("invalid_generation_poll_options");
  }

  let visibleElapsed = 0;
  let lastTick = now();
  let consecutiveFailures = 0;
  let consecutive401 = 0;
  const accrue = () => {
    const current = now();
    if (isVisible()) visibleElapsed += Math.max(0, current - lastTick);
    lastTick = current;
  };

  while (!isCancelled() && !options.signal?.aborted) {
    accrue();
    try {
      const delivery = await runBoundedClientJsonFetch({
        input: "/api/generations",
        init: { cache: "no-store" },
        fetcher,
        signal: options.signal,
        deadlineMs: requestTimeoutMs,
        attemptMs: requestTimeoutMs - 1,
      });
      if (delivery.kind === "aborted") return { status: "timeout" };
      if (delivery.kind !== "confirmed") {
        throw new Error("generation_poll_response_unconfirmed");
      }
      const { response, body } = delivery.value;
      if (response.ok) {
        const rows = parsePendingGenerationsResponse(body);
        consecutiveFailures = 0;
        consecutive401 = 0;
        const generation = rows.find((row) => row.id === genId);
        if (generation?.kind === "ready") {
          return {
            status: "ready",
            urls: generation.candidateUrls,
            role: generation.role,
          };
        }
        if (generation?.kind === "interrupted") {
          return {
            status: "interrupted",
            ...(generation.reason === "photo"
              ? { reason: "photo" as const }
              : {}),
          };
        }
        // generating / 아직 목록에 없음 → 계속 폴링.
      } else {
        consecutiveFailures += 1;
        if (response.status === 401) {
          consecutive401 += 1;
          if (consecutive401 >= failureLimit) {
            return { status: "unauthorized" };
          }
          if (consecutiveFailures >= failureLimit) {
            return { status: "unavailable" };
          }
        } else {
          consecutive401 = 0;
          if (consecutiveFailures >= failureLimit) {
            return { status: "unavailable" };
          }
        }
      }
    } catch (error) {
      // 파서 실패 역시 신뢰할 수 없는 성공 응답이므로 HTTP/transport 실패와 같은 경계다.
      consecutiveFailures += 1;
      consecutive401 = 0;
      if (consecutiveFailures >= failureLimit) {
        return { status: "unavailable" };
      }
      if (
        error instanceof InvalidPendingGenerationsResponseError ||
        error instanceof SyntaxError
      ) {
        // 의도적으로 아래 공통 재시도 경로로 진행한다.
      }
    }
    accrue();
    if (visibleElapsed > maxVisibleMs) return { status: "timeout" };
    await wait(intervalMs);
  }
  return { status: "timeout" };
}
