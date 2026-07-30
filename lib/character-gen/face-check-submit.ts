import { createHmac } from "node:crypto";
import {
  FACE_CHECK_KEYS,
  FACE_CHECK_PROMPTS,
  MOONDREAM_MODEL,
  MOONDREAM_RAW_MAX,
  type FaceCheckKey,
} from "./face-analysis.ts";
import {
  hashFalCallbackToken,
  hashFalSubmitPayload,
  submitFalQueueOnce,
  type FalQueueSubmitOutcome,
} from "./fal-submit-once.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isFaceCheckKey(value: unknown): value is FaceCheckKey {
  return (
    typeof value === "string" &&
    (FACE_CHECK_KEYS as readonly string[]).includes(value)
  );
}

/**
 * The raw callback token must be reconstructible after a process crash, while
 * only its hash is persisted. FAL_KEY is server-only and already required for
 * every submit; rotate it only after the two-hour webhook drain documented in
 * the rollout runbook.
 */
export function deriveFaceCheckCallbackToken(args: {
  credentials: string;
  reservationId: string;
  checkKey: FaceCheckKey;
  payloadHash: string;
}): string {
  if (
    args.credentials.length < 1 ||
    !UUID_RE.test(args.reservationId) ||
    !isFaceCheckKey(args.checkKey) ||
    !HASH_RE.test(args.payloadHash)
  ) {
    throw new Error("invalid_face_check_callback_binding");
  }
  return createHmac("sha256", args.credentials)
    .update(
      `boss-paegi:face-check:v1:${args.reservationId}:${args.checkKey}:${args.payloadHash}`,
      "utf8",
    )
    .digest("base64url");
}

export type FaceCheckSubmitIntent = {
  checkKey: FaceCheckKey;
  input: Readonly<{ image_url: string; prompt: string }>;
  payloadHash: string;
  callbackToken: string;
  callbackTokenHash: string;
  webhookUrl: string;
};

function buildFaceCheckWebhookUrl(args: {
  siteOrigin: string;
  reservationId: string;
  checkKey: FaceCheckKey;
  callbackToken: string;
  payloadHash: string;
}): string {
  const url = new URL("/api/fal/face-webhook", args.siteOrigin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("invalid_face_check_webhook_origin");
  }
  url.searchParams.set("r", args.reservationId);
  url.searchParams.set("k", args.checkKey);
  url.searchParams.set("t", args.callbackToken);
  url.searchParams.set("p", args.payloadHash);
  return url.toString();
}

export function createFaceCheckSubmitIntents(args: {
  siteOrigin: string;
  reservationId: string;
  imageUrl: string;
  credentials: string;
}): FaceCheckSubmitIntent[] {
  if (
    !UUID_RE.test(args.reservationId) ||
    args.imageUrl.length < 1 ||
    args.imageUrl.length > 4096
  ) {
    throw new Error("invalid_face_check_submit_input");
  }
  return FACE_CHECK_KEYS.map((checkKey) => {
    const input = {
      image_url: args.imageUrl,
      prompt: FACE_CHECK_PROMPTS[checkKey],
    };
    const payloadHash = hashFalSubmitPayload(input);
    const callbackToken = deriveFaceCheckCallbackToken({
      credentials: args.credentials,
      reservationId: args.reservationId,
      checkKey,
      payloadHash,
    });
    return {
      checkKey,
      input,
      payloadHash,
      callbackToken,
      callbackTokenHash: hashFalCallbackToken(callbackToken),
      webhookUrl: buildFaceCheckWebhookUrl({
        siteOrigin: args.siteOrigin,
        reservationId: args.reservationId,
        checkKey,
        callbackToken,
        payloadHash,
      }),
    };
  });
}

export function faceCheckIntentRpcPayload(
  intents: readonly FaceCheckSubmitIntent[],
) {
  return intents.map((intent) => ({
    check_key: intent.checkKey,
    input: intent.input,
    payload_hash: intent.payloadHash,
    callback_token_hash: intent.callbackTokenHash,
  }));
}

export type FaceCheckWorkClaim =
  | {
      kind: "claimed";
      checkKey: FaceCheckKey;
      input: Readonly<{ image_url: string; prompt: string }>;
      payloadHash: string;
      callbackTokenHash: string;
    }
  | { kind: "blocked"; outcome: string }
  | { kind: "invalid" };

export function parseFaceCheckWorkClaim(value: unknown): FaceCheckWorkClaim {
  const row = exactObject(value);
  if (row?.ok !== true || typeof row.outcome !== "string") {
    return { kind: "invalid" };
  }
  if (row.outcome !== "claimed") {
    return { kind: "blocked", outcome: row.outcome };
  }
  const input = exactObject(row.input);
  if (
    !isFaceCheckKey(row.check_key) ||
    !input ||
    Object.keys(input).sort().join(",") !== "image_url,prompt" ||
    typeof input.image_url !== "string" ||
    input.image_url.length < 1 ||
    input.image_url.length > 4096 ||
    typeof input.prompt !== "string" ||
    input.prompt !== FACE_CHECK_PROMPTS[row.check_key] ||
    typeof row.payload_hash !== "string" ||
    !HASH_RE.test(row.payload_hash) ||
    typeof row.callback_token_hash !== "string" ||
    !HASH_RE.test(row.callback_token_hash)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "claimed",
    checkKey: row.check_key,
    input: {
      image_url: input.image_url,
      prompt: input.prompt,
    },
    payloadHash: row.payload_hash,
    callbackTokenHash: row.callback_token_hash,
  };
}

export function submitFaceCheckOnce(args: {
  siteOrigin: string;
  reservationId: string;
  claim: Extract<FaceCheckWorkClaim, { kind: "claimed" }>;
  credentials: string;
  fetchImpl?: typeof fetch;
}): Promise<FalQueueSubmitOutcome> {
  const callbackToken = deriveFaceCheckCallbackToken({
    credentials: args.credentials,
    reservationId: args.reservationId,
    checkKey: args.claim.checkKey,
    payloadHash: args.claim.payloadHash,
  });
  if (hashFalCallbackToken(callbackToken) !== args.claim.callbackTokenHash) {
    throw new Error("face_check_callback_secret_rotated");
  }
  return submitFalQueueOnce({
    endpoint: MOONDREAM_MODEL,
    input: args.claim.input,
    webhookUrl: buildFaceCheckWebhookUrl({
      siteOrigin: args.siteOrigin,
      reservationId: args.reservationId,
      checkKey: args.claim.checkKey,
      callbackToken,
      payloadHash: args.claim.payloadHash,
    }),
    credentials: args.credentials,
    fetchImpl: args.fetchImpl,
  });
}

export function validFaceCheckWebhookBinding(args: {
  reservationId: string | null;
  checkKey: string | null;
  token: string | null;
  payloadHash: string | null;
}): args is {
  reservationId: string;
  checkKey: FaceCheckKey;
  token: string;
  payloadHash: string;
} {
  return (
    typeof args.reservationId === "string" &&
    UUID_RE.test(args.reservationId) &&
    isFaceCheckKey(args.checkKey) &&
    typeof args.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(args.token) &&
    typeof args.payloadHash === "string" &&
    HASH_RE.test(args.payloadHash)
  );
}

export function parseFaceCheckWebhookPayload(
  rawBody: Uint8Array,
  signedRequestId: string,
):
  | { status: "OK"; requestId: string; rawOutput: string }
  | { status: "ERROR"; requestId: string; rawOutput: null }
  | null {
  try {
    const row = exactObject(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)),
    );
    if (
      !row ||
      row.request_id !== signedRequestId ||
      (row.status !== "OK" && row.status !== "ERROR") ||
      !REQUEST_ID_RE.test(signedRequestId)
    ) {
      return null;
    }
    if (row.status === "ERROR") {
      return {
        status: "ERROR",
        requestId: signedRequestId,
        rawOutput: null,
      };
    }
    const payload = exactObject(row.payload);
    if (
      !payload ||
      typeof payload.output !== "string" ||
      payload.output.length > MOONDREAM_RAW_MAX
    ) {
      return null;
    }
    return {
      status: "OK",
      requestId: signedRequestId,
      rawOutput: payload.output,
    };
  } catch {
    return null;
  }
}

export function parseReadyFaceCheckOutputs(
  value: unknown,
): Record<FaceCheckKey, string> | null {
  const row = exactObject(value);
  const outputs = exactObject(row?.raw_outputs);
  if (row?.ok !== true || row.outcome !== "ready" || !outputs) return null;
  const result = {} as Record<FaceCheckKey, string>;
  for (const key of FACE_CHECK_KEYS) {
    const output = outputs[key];
    if (typeof output !== "string" || output.length > MOONDREAM_RAW_MAX) {
      return null;
    }
    result[key] = output;
  }
  return Object.keys(outputs).length === FACE_CHECK_KEYS.length ? result : null;
}
