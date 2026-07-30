// Public PortOne webhook request-size boundary. This module deliberately has
// no Next/server-only dependency so the wire contract can be exhaustively
// tested without loading credentials or payment infrastructure.
import { readBoundedResponseBytes } from "../http/bounded-response.ts";

export const PORTONE_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/**
 * A missing Content-Length is valid for chunked requests. When the header is
 * present, require one canonical non-negative decimal within our application
 * limit. The decoded body is checked again because clients can lie or omit it.
 */
export function portoneWebhookContentLengthAllowed(
  value: string | null,
): boolean {
  if (value === null) return true;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) <= BigInt(PORTONE_WEBHOOK_MAX_BODY_BYTES);
  } catch {
    return false;
  }
}

/** Exact UTF-8 wire-size check; JavaScript string length counts UTF-16 units. */
export function portoneWebhookBodyBytesAllowed(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= PORTONE_WEBHOOK_MAX_BODY_BYTES
  );
}

export type PortoneWebhookBodyResult =
  | { ok: true; rawBody: string }
  | {
      ok: false;
      error: "body_too_large" | "invalid_body";
    };

/**
 * Preserve the exact signed UTF-8 text while enforcing the cap during stream
 * consumption. In particular, a chunked request never gets an unbounded
 * req.text() allocation before the application limit is checked.
 */
export async function readPortoneWebhookBody(request: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<PortoneWebhookBodyResult> {
  const bounded = await readBoundedResponseBytes(
    request,
    PORTONE_WEBHOOK_MAX_BODY_BYTES,
  );
  if (!bounded.ok) {
    return {
      ok: false,
      error:
        bounded.error === "too_large"
          ? "body_too_large"
          : "invalid_body",
    };
  }
  try {
    return {
      ok: true,
      rawBody: new TextDecoder("utf-8", { fatal: true }).decode(
        bounded.bytes,
      ),
    };
  } catch {
    return { ok: false, error: "invalid_body" };
  }
}
