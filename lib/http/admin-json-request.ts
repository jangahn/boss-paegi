import { readBoundedJsonRequest } from "./bounded-json-request.ts";

export const ADMIN_JSON_BODY_MAX_BYTES = 64 * 1024;
export const ADMIN_DOCUMENT_JSON_BODY_MAX_BYTES = 1024 * 1024;

export type AdminJsonRequestResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: "invalid_body" | "payload_too_large";
      status: 400 | 413;
    };

/**
 * Authenticated admin JSON boundary. Call only after requireAdmin so an
 * unauthenticated peer cannot spend the route's body-buffer budget.
 */
export async function readAdminJsonRequest(
  request: {
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  },
  maxBytes = ADMIN_JSON_BODY_MAX_BYTES,
): Promise<AdminJsonRequestResult> {
  const parsed = await readBoundedJsonRequest(request, maxBytes);
  if (parsed.ok) return parsed;
  return parsed.error === "too_large"
    ? { ok: false, error: "payload_too_large", status: 413 }
    : { ok: false, error: "invalid_body", status: 400 };
}
