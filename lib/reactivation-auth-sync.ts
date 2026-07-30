/**
 * 계정 재활성 DB RPC 뒤 GoTrue auth.users.email 동기화는 외부 경계라 같은 DB
 * 트랜잭션에 묶을 수 없다. Supabase SDK의 resolved `{ error }`와 throw를 모두
 * 잡고 짧게 재시도해, 부분 성공을 완전 성공으로 오인하지 않게 한다.
 */
export type AuthEmailUpdateResult = { error?: unknown };

export type AuthEmailRestoreOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; error: unknown };

export const AUTH_EMAIL_RESTORE_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [0, 50, 150] as const;

export async function restoreAuthEmailWithRetry(
  update: () => PromiseLike<AuthEmailUpdateResult>,
  opts?: {
    maxAttempts?: number;
    delay?: (milliseconds: number) => Promise<void>;
  },
): Promise<AuthEmailRestoreOutcome> {
  const maxAttempts = Math.max(
    1,
    Math.min(
      Math.trunc(opts?.maxAttempts ?? AUTH_EMAIL_RESTORE_MAX_ATTEMPTS),
      5,
    ),
  );
  const delay =
    opts?.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown = new Error("auth_email_restore_not_attempted");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await update();
      if (result.error === null || result.error === undefined) {
        return { ok: true, attempts: attempt };
      }
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) {
      await delay(RETRY_DELAY_MS[Math.min(attempt, RETRY_DELAY_MS.length - 1)]);
    }
  }

  return { ok: false, attempts: maxAttempts, error: lastError };
}
