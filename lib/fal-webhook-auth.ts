import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { readBoundedResponseBytes } from "./http/bounded-response.ts";

export const FAL_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;
export const FAL_WEBHOOK_CLOCK_SKEW_SECONDS = 300;
export const FAL_WEBHOOK_JWKS_URL =
  "https://rest.fal.ai/.well-known/jwks.json";
export const FAL_WEBHOOK_JWKS_MAX_BODY_BYTES = 64 * 1024;
const JWKS_CACHE_MS = 23 * 60 * 60 * 1000;
const JWKS_FORCED_REFRESH_MIN_AGE_MS = 60 * 1000;
const MAX_KEYS = 20;

export type FalWebhookJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  use?: string;
  kid?: string;
};

export type FalWebhookVerification =
  | { ok: true; requestId: string; userId: string }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "invalid_header"
        | "stale_timestamp"
        | "body_too_large"
        | "invalid_signature"
        | "no_keys";
    };

let jwksCache:
  | { keys: FalWebhookJwk[]; fetchedAt: number }
  | undefined;
let jwksRefreshPromise: Promise<FalWebhookJwk[]> | undefined;

function validSignedHeader(value: string | null): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\r\n\u0000]/.test(value)
  );
}

function parseJwk(value: unknown): FalWebhookJwk | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = value as Record<string, unknown>;
  // fal's live JWKS publishes the Ed25519 x coordinate WITH base64url
  // padding (44 chars ending in "="), while RFC 7518 exporters emit the
  // unpadded 43-char form. Accept both and normalize to the unpadded form
  // so signature verification sees one canonical key encoding.
  const rawX = typeof key.x === "string" ? key.x : null;
  const normalizedX =
    rawX !== null && /^[A-Za-z0-9_-]{43}={0,1}$/.test(rawX)
      ? rawX.replace(/=+$/u, "")
      : null;
  if (normalizedX !== null) {
    key.x = normalizedX;
  }
  if (
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    typeof key.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
    !(key.use === undefined || key.use === "sig") ||
    !(
      key.kid === undefined ||
      (typeof key.kid === "string" &&
        key.kid.length <= 256 &&
        !/[\r\n\u0000]/.test(key.kid))
    )
  ) {
    return null;
  }
  return key as FalWebhookJwk;
}

async function fetchFalWebhookKeys(
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<FalWebhookJwk[]> {
  const response = await fetchImpl(FAL_WEBHOOK_JWKS_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("fal_jwks_unavailable");
  const bounded = await readBoundedResponseBytes(
    response,
    FAL_WEBHOOK_JWKS_MAX_BODY_BYTES,
  );
  if (!bounded.ok) {
    throw new Error(
      bounded.error === "too_large"
        ? "fal_jwks_too_large"
        : "fal_jwks_unavailable",
    );
  }
  const rawBody = bounded.bytes;
  let payload: { keys?: unknown };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    payload = JSON.parse(text) as { keys?: unknown };
  } catch {
    throw new Error("fal_jwks_malformed");
  }
  if (!payload || !Array.isArray(payload.keys) || payload.keys.length > MAX_KEYS) {
    throw new Error("fal_jwks_malformed");
  }
  const keys = payload.keys
    .map(parseJwk)
    .filter((key): key is FalWebhookJwk => key !== null);
  if (keys.length === 0) throw new Error("fal_jwks_empty");
  jwksCache = { keys, fetchedAt: nowMs };
  return keys;
}

function fetchAndCacheFalWebhookKeys(
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<FalWebhookJwk[]> {
  if (!jwksRefreshPromise) {
    jwksRefreshPromise = fetchFalWebhookKeys(fetchImpl, nowMs).finally(() => {
      jwksRefreshPromise = undefined;
    });
  }
  return jwksRefreshPromise;
}

export async function getFalWebhookKeys(
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<FalWebhookJwk[]> {
  if (jwksCache && nowMs - jwksCache.fetchedAt < JWKS_CACHE_MS) {
    return jwksCache.keys;
  }
  return fetchAndCacheFalWebhookKeys(fetchImpl, nowMs);
}

/**
 * A valid webhook signed by a newly rotated key would otherwise be rejected
 * for the rest of the 23-hour cache. On signature failure, refresh at most
 * once per minute per runtime instance and verify the exact request again.
 */
export async function refreshFalWebhookKeys(
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<FalWebhookJwk[]> {
  if (
    jwksCache &&
    nowMs - jwksCache.fetchedAt < JWKS_FORCED_REFRESH_MIN_AGE_MS
  ) {
    return jwksCache.keys;
  }
  return fetchAndCacheFalWebhookKeys(fetchImpl, nowMs);
}

export function verifyFalWebhookSignature(args: {
  headers: Headers;
  rawBody: Uint8Array;
  keys: readonly FalWebhookJwk[];
  nowMs?: number;
}): FalWebhookVerification {
  if (args.rawBody.byteLength > FAL_WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, reason: "body_too_large" };
  }
  const requestId = args.headers.get("x-fal-webhook-request-id");
  const userId = args.headers.get("x-fal-webhook-user-id");
  const timestamp = args.headers.get("x-fal-webhook-timestamp");
  const signatureHex = args.headers.get("x-fal-webhook-signature");
  if (
    requestId === null ||
    userId === null ||
    timestamp === null ||
    signatureHex === null
  ) {
    return { ok: false, reason: "missing_headers" };
  }
  if (
    !validSignedHeader(requestId) ||
    !validSignedHeader(userId) ||
    !/^(?:0|[1-9]\d{0,12})$/.test(timestamp) ||
    !/^[0-9a-fA-F]{128}$/.test(signatureHex)
  ) {
    return { ok: false, reason: "invalid_header" };
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) >
      FAL_WEBHOOK_CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (args.keys.length === 0) return { ok: false, reason: "no_keys" };

  const bodyHash = createHash("sha256")
    .update(args.rawBody)
    .digest("hex");
  const message = Buffer.from(
    `${requestId}\n${userId}\n${timestamp}\n${bodyHash}`,
    "utf8",
  );
  const signature = Buffer.from(signatureHex, "hex");
  for (const jwk of args.keys.slice(0, MAX_KEYS)) {
    try {
      const key = createPublicKey({
        key: jwk,
        format: "jwk",
      });
      if (verify(null, message, key, signature)) {
        return { ok: true, requestId, userId };
      }
    } catch {
      // A malformed/unsupported key never weakens verification; try rotation
      // siblings and fail closed if none verify.
    }
  }
  return { ok: false, reason: "invalid_signature" };
}

export type FalWebhookPayload = {
  requestId: string;
  status: "OK" | "ERROR";
};

export function parseFalWebhookPayload(
  rawBody: Uint8Array,
  signedRequestId: string,
): FalWebhookPayload | null {
  if (rawBody.byteLength > FAL_WEBHOOK_MAX_BODY_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.request_id !== signedRequestId ||
      (value.status !== "OK" && value.status !== "ERROR")
    ) {
      return null;
    }
    return {
      requestId: signedRequestId,
      status: value.status,
    };
  } catch {
    return null;
  }
}
