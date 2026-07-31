export type CurrentAuthSessionState =
  | { kind: "live" }
  | { kind: "revoked" }
  | { kind: "unavailable"; error: unknown };

type SessionLiveRpcResult = {
  data: unknown;
  error: unknown | null;
};

/**
 * Classifies the DB-authoritative session-existence proof. Supabase access
 * JWTs can remain cryptographically valid until `exp` after `auth.sessions`
 * is deleted, so `auth.getUser()` alone is not a revocation boundary.
 */
export async function readCurrentAuthSessionState(
  operation: () => PromiseLike<SessionLiveRpcResult>,
): Promise<CurrentAuthSessionState> {
  let result: SessionLiveRpcResult;
  try {
    result = await operation();
  } catch (error) {
    return { kind: "unavailable", error };
  }
  if (result.error !== null && result.error !== undefined) {
    return { kind: "unavailable", error: result.error };
  }
  if (result.data === true) return { kind: "live" };
  if (result.data === false) return { kind: "revoked" };
  return {
    kind: "unavailable",
    error: new Error("current_auth_session_state_invalid"),
  };
}
