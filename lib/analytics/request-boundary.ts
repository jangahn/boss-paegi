// Public analytics request-size boundary. Keep this module dependency-free so
// the exact wire limit can be exhaustively unit tested outside Next runtime.
import { readBoundedResponseBytes } from "../http/bounded-response.ts";

export const TRACK_BODY_MAX_BYTES = 4096;

/**
 * A present Content-Length must be one canonical, non-negative decimal value
 * within the endpoint limit. Missing is allowed for sendBeacon/chunked bodies;
 * the decoded body is checked again after reading.
 */
export function trackContentLengthAllowed(value: string | null): boolean {
  if (value === null) return true;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
  const length = Number(value);
  return (
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= TRACK_BODY_MAX_BYTES
  );
}

/** Exact UTF-8 wire-size check; JavaScript string length is UTF-16 code units. */
export function trackBodyBytesAllowed(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= TRACK_BODY_MAX_BYTES;
}

/** Stream, decode, and parse without ever allocating beyond the wire limit. */
export async function readTrackJsonRequest(request: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<unknown | null> {
  const bounded = await readBoundedResponseBytes(
    request,
    TRACK_BODY_MAX_BYTES,
  );
  if (!bounded.ok) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bounded.bytes,
    );
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
