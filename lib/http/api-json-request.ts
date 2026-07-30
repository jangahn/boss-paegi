import { readBoundedJsonRequest } from "./bounded-json-request.ts";

export const DEFAULT_API_JSON_BODY_MAX_BYTES = 64 * 1024;

export type ApiJsonObjectRequestResult =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      error: "payload_too_large" | "invalid_body";
      status: 413 | 400;
    };

/**
 * JSON-object API body boundary shared by member/public route handlers.
 *
 * Authentication/rate-limit checks stay at each route. Once authorized, this
 * reader rejects non-canonical/oversized Content-Length before reading and
 * enforces the same cap while consuming chunked bodies. Only strict UTF-8 JSON
 * objects pass; arrays, scalars and null are invalid request bodies.
 */
export async function readApiJsonObjectRequest(
  request: {
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  },
  maxBytes = DEFAULT_API_JSON_BODY_MAX_BYTES,
): Promise<ApiJsonObjectRequestResult> {
  const parsed = await readBoundedJsonRequest(request, maxBytes);
  if (!parsed.ok) {
    return parsed.error === "too_large"
      ? { ok: false, error: "payload_too_large", status: 413 }
      : { ok: false, error: "invalid_body", status: 400 };
  }
  if (
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  return {
    ok: true,
    value: parsed.value as Record<string, unknown>,
  };
}
