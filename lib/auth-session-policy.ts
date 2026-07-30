export type SessionReadResult<T> = {
  data: { session: T | null };
  error: unknown | null;
};

/**
 * A resolved auth error is not "no session". Callers may create an anonymous
 * identity only after a successful `{session:null,error:null}` read.
 */
export function requireSuccessfulSessionRead<T>(
  result: SessionReadResult<T>,
): T | null {
  if (result.error != null) throw result.error;
  return result.data.session;
}

export function requireAnonymousSignInSession<T>(result: {
  data: { session: T | null };
  error: unknown | null;
}): T {
  if (result.error != null) throw result.error;
  if (result.data.session === null) {
    throw new Error("anonymous_sign_in_missing_session");
  }
  return result.data.session;
}
