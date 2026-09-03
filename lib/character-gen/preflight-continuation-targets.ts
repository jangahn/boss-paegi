/**
 * gen-recover 의 서버 주도 continuation 대상 선택 — 순수 모듈(alias import 없음, 테스트 직접 import).
 * 의미: v1.20 README. 웹훅이 놓친 accepted/committed 예약을 이어갈 나이 창과 상한.
 */
/** 웹훅 continuation 이 놓친 예약을 이어가는 나이 창(분). 1분 전엔 웹훅·클라 재요청이 주 경로. */
export const PREFLIGHT_CONTINUE_MIN_AGE_MS = 60 * 1000;
/** accepted 는 10분부터 release_stale(환불) 대상이라 9분까지만, committed 는 stuck 백스톱(30분) 전까지. */
export const PREFLIGHT_CONTINUE_MAX_AGE_ACCEPTED_MS = 9 * 60 * 1000;
export const PREFLIGHT_CONTINUE_MAX_AGE_COMMITTED_MS = 30 * 60 * 1000;
export const PREFLIGHT_STALE_RELEASE_AGE_MS = 10 * 60 * 1000;
/** 틱당 continuation 상한 — fal 제출 3건×수초라 20초 예산 안에서. */
export const PREFLIGHT_CONTINUE_LIMIT = 3;
export const PREFLIGHT_STALE_OWNER_LIMIT = 10;

export type PreflightContinuationRow = {
  id: string;
  owner_id: string;
  state: string;
  continuation_state: string;
  continuation_leased_until: string | null;
  created_at: string;
};

/** 순수 선택기(테스트 직접 import): 이어갈 예약만, 오래된 순, 상한 적용. */
export function selectContinuationTargets(
  rows: readonly PreflightContinuationRow[],
  nowMs: number,
  limit = PREFLIGHT_CONTINUE_LIMIT,
): PreflightContinuationRow[] {
  const eligible = rows.filter((row) => {
    if (row.continuation_state === "submitted") return false;
    const age = nowMs - new Date(row.created_at).getTime();
    if (!(age >= PREFLIGHT_CONTINUE_MIN_AGE_MS)) return false;
    if (row.state === "accepted") {
      return age < PREFLIGHT_CONTINUE_MAX_AGE_ACCEPTED_MS;
    }
    if (row.state === "committed") {
      const leasedUntil = row.continuation_leased_until
        ? new Date(row.continuation_leased_until).getTime()
        : 0;
      return age < PREFLIGHT_CONTINUE_MAX_AGE_COMMITTED_MS && leasedUntil <= nowMs;
    }
    return false;
  });
  eligible.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return eligible.slice(0, limit);
}

