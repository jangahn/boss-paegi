/**
 * SessionBootstrap 의 로컬 재시도 일정 — discovery/익명 로그인 부트스트랩이 실패했을 때
 * 다음 시도까지의 대기(ms). 순수 함수(테스트 직접 import).
 *
 * 2026-09-03 실관측: supabase.co 에 닿지 못하는 클라이언트 1대가 5초 고정·무상한
 * 재시도로 35분간 120건(분당 3건)의 로그를 만들었다. 처음 두 번은 종전처럼 짧게
 * (일시적 끊김은 여기서 복구), 이후 지수 backoff(상한 60초), 8회 뒤엔 자동 재시도를
 * 멈춘다(사용자 재로드가 새 시도). 화면 요소는 바뀌지 않는다.
 */
export const BOOTSTRAP_RETRY_DELAYS_MS = [
  5_000, 10_000, 20_000, 40_000, 60_000,
] as const;
export const BOOTSTRAP_RETRY_MAX_ATTEMPTS = 8;

/**
 * failedAttempts = 지금까지 실패한 시도 수(1부터). 다음 재시도까지 대기 ms,
 * 상한을 넘겼으면 null(자동 재시도 중단).
 */
export function bootstrapRetryDelayMs(failedAttempts: number): number | null {
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 1) return null;
  if (failedAttempts >= BOOTSTRAP_RETRY_MAX_ATTEMPTS) return null;
  const index = Math.min(
    failedAttempts - 1,
    BOOTSTRAP_RETRY_DELAYS_MS.length - 1,
  );
  return BOOTSTRAP_RETRY_DELAYS_MS[index];
}
