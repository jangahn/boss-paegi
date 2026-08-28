import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * GoTrue admin 사용자 삭제 계약 — 단일 정본.
 *
 * pre-ledger 익명 데이터 이전 러너(runAnonDataMigration)는 v1.03 에서 legacy 경로와 함께
 * 제거됐다 — 프로덕션 legacy 영수증 0건(단 한 번도 실행되지 않음)을 확인하고 소멸.
 * 이 모듈은 auth 사용자 삭제의 판정 계약만 남긴다. deps 없는 경량 모듈이라 node 단위
 * 테스트가 직접 import 한다.
 */

/**
 * Auth admin API 가 "이미 없는 사용자"를 알리는 두 형태(user_not_found 코드·Not Found 문구)를
 * 흡수한다. 멱등 재시도(삭제 재실행·정리 잡)의 성공 판정 근거이므로 형태가 늘면 여기에만 더한다.
 */
export function isMissingAuthUserError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === "user_not_found") return true;
  return (
    typeof value.message === "string" &&
    /^user(?: with id .+)? not found$/i.test(value.message.trim())
  );
}

/**
 * GoTrue admin 삭제 — **오류로만 판정한다.**
 * 성공 응답은 user 를 되돌려주지 않으므로(auth-js `{ data: { user: {} } }` — 빈 응답 승격)
 * 응답 형태 재검증은 성공을 전부 실패로 오판한다(2026-08-28 신규가입 6/6 실측, v1.00).
 * user_not_found 는 이미 삭제된 멱등 성공. 삭제를 응답보다 강하게 확정해야 하는 saga 는
 * oauth-anon-auth-cleanup-job 처럼 **삭제 후 재조회**를 쓴다(응답 자체는 계약상 신뢰 불가).
 */
export async function deleteAuthUserAcceptingMissing(
  admin: SupabaseClient,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const result = await admin.auth.admin.deleteUser(userId);
  if (result.error === null || isMissingAuthUserError(result.error)) {
    return { ok: true };
  }
  return { ok: false, error: result.error };
}
