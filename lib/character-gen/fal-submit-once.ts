import {
  createHash,
  randomBytes,
} from "node:crypto";
import { readBoundedResponseBytes } from "../http/bounded-response.ts";

const DEFINITIVE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422,
]);
const REQUEST_ID_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const CALLBACK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// Raw face URLs live for ten minutes. Stop queue admission at eight minutes so
// an accepted runner retains a two-minute input-fetch margin.
export const FAL_QUEUE_START_TIMEOUT_SECONDS = 8 * 60;
export const FAL_QUEUE_ACK_MAX_BODY_BYTES = 16 * 1024;
export const FAL_OBJECT_LIFECYCLE_PREFERENCE = JSON.stringify({
  expiration_duration_seconds: 6 * 60 * 60,
  initial_acl: { default: "forbid", rules: [] },
});

export type FalQueueSubmitOutcome =
  | { kind: "acknowledged"; requestId: string; httpStatus: number }
  | { kind: "rejected"; requestId: null; httpStatus: number }
  | { kind: "uncertain"; requestId: null; httpStatus: number | null };

export type FalQueueSubmitInput = {
  endpoint: string;
  input: Readonly<Record<string, unknown>>;
  webhookUrl: string;
  credentials: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createFalCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashFalCallbackToken(token: string): string {
  if (!CALLBACK_TOKEN_RE.test(token)) {
    throw new Error("invalid_fal_callback_token");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashFalSubmitPayload(
  input: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function buildFalCallbackUrl(args: {
  siteUrl: string;
  generationId: string;
  candidateIndex: number;
  token: string;
  payloadHash: string;
}): string {
  if (
    !Number.isInteger(args.candidateIndex) ||
    args.candidateIndex < 0 ||
    args.candidateIndex > 2 ||
    !CALLBACK_TOKEN_RE.test(args.token) ||
    !/^[0-9a-f]{64}$/.test(args.payloadHash)
  ) {
    throw new Error("invalid_fal_callback_binding");
  }
  const url = new URL("/api/fal/webhook", args.siteUrl);
  url.searchParams.set("g", args.generationId);
  url.searchParams.set("c", String(args.candidateIndex));
  url.searchParams.set("t", args.token);
  url.searchParams.set("p", args.payloadHash);
  return url.toString();
}

/**
 * A queue submission is intentionally attempted exactly once. A transport
 * error, retryable HTTP response, or malformed success is "uncertain" because
 * fal may already have accepted the paid request. Callers must wait for the
 * signed webhook instead of retrying or refunding immediately.
 */
export async function submitFalQueueOnce(
  args: FalQueueSubmitInput,
): Promise<FalQueueSubmitOutcome> {
  if (
    !/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/.test(args.endpoint) ||
    !args.credentials ||
    !Number.isSafeInteger(args.timeoutMs ?? 10_000) ||
    (args.timeoutMs ?? 10_000) < 1
  ) {
    throw new Error("invalid_fal_submit_configuration");
  }
  const webhookUrl = new URL(args.webhookUrl);
  const target = new URL(`https://queue.fal.run/${args.endpoint}`);
  target.searchParams.set("fal_webhook", webhookUrl.toString());
  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Key ${args.credentials}`,
        "Content-Type": "application/json",
        "X-Fal-No-Retry": "1",
        "X-Fal-Object-Lifecycle-Preference":
          FAL_OBJECT_LIFECYCLE_PREFERENCE,
        "X-Fal-Queue-Priority": "normal",
        "X-Fal-Request-Timeout": String(FAL_QUEUE_START_TIMEOUT_SECONDS),
        // fal otherwise retains request/response JSON (including the signed
        // raw-face URL) for 30 days. This is intentionally not caller
        // configurable.
        "X-Fal-Store-IO": "0",
        "x-app-fal-disable-fallback": "true",
      },
      body: JSON.stringify(args.input),
      signal: AbortSignal.timeout(args.timeoutMs ?? 10_000),
      redirect: "error",
    });
  } catch {
    return { kind: "uncertain", requestId: null, httpStatus: null };
  }

  if (!response.ok) {
    return DEFINITIVE_REJECTION_STATUSES.has(response.status)
      ? { kind: "rejected", requestId: null, httpStatus: response.status }
      : { kind: "uncertain", requestId: null, httpStatus: response.status };
  }

  try {
    const bounded = await readBoundedResponseBytes(
      response,
      FAL_QUEUE_ACK_MAX_BODY_BYTES,
    );
    if (!bounded.ok) {
      return {
        kind: "uncertain",
        requestId: null,
        httpStatus: response.status,
      };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bounded.bytes,
    );
    const payload = JSON.parse(text) as { request_id?: unknown };
    if (
      !payload ||
      typeof payload !== "object" ||
      !REQUEST_ID_RE.test(String(payload.request_id ?? ""))
    ) {
      return {
        kind: "uncertain",
        requestId: null,
        httpStatus: response.status,
      };
    }
    return {
      kind: "acknowledged",
      requestId: payload.request_id as string,
      httpStatus: response.status,
    };
  } catch {
    return { kind: "uncertain", requestId: null, httpStatus: response.status };
  }
}
