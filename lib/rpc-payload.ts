const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidRpcPayload(): Error {
  return new Error("invalid_rpc_response");
}

/** json/jsonb RPC가 `{ ok:true }` 객체를 반환한다는 계약을 검증한다. */
export function requireOkRpcPayload(
  data: unknown,
): Record<string, unknown> & { ok: true } {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    (data as { ok?: unknown }).ok !== true
  ) {
    throw invalidRpcPayload();
  }
  return data as Record<string, unknown> & { ok: true };
}

/** UUID scalar RPC가 null/임의 문자열을 성공으로 위장하지 못하게 한다. */
export function requireUuidRpcPayload(data: unknown): string {
  if (typeof data !== "string" || !UUID_RE.test(data)) {
    throw invalidRpcPayload();
  }
  return data;
}
