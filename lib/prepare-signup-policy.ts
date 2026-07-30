import { resolveAuthUserRead } from "./auth-read-policy.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrepareSignupUser = {
  id: string;
  isAnonymous: boolean;
};

export type PrepareSignupDecision =
  | { ok: true; user: PrepareSignupUser }
  | {
      ok: false;
      kind: "unauthorized" | "unavailable";
      error: unknown | null;
    };

/**
 * OAuth 직전 쿠키 발급은 Auth dependency 오류/무세션/손상 user를 성공으로 축소하지 않는다.
 * `is_anonymous`도 exact boolean이어야 익명 이전을 건너뛸지 안전하게 결정할 수 있다.
 */
export function decidePrepareSignupUser(result: {
  data: { user: unknown | null };
  error: unknown | null;
}): PrepareSignupDecision {
  const authRead = resolveAuthUserRead(result);
  if (!authRead.ok) return authRead;
  const user = authRead.user;
  if (
    !user ||
    typeof user !== "object" ||
    typeof (user as { id?: unknown }).id !== "string" ||
    !UUID_RE.test((user as { id: string }).id) ||
    typeof (user as { is_anonymous?: unknown }).is_anonymous !== "boolean"
  ) {
    return {
      ok: false,
      kind: "unavailable",
      error: new Error("invalid_prepare_signup_user"),
    };
  }
  return {
    ok: true,
    user: {
      id: (user as { id: string }).id,
      isAnonymous: (user as { is_anonymous: boolean }).is_anonymous,
    },
  };
}
