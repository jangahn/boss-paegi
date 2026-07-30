import { createHmac } from "node:crypto";
import {
  buildFalCallbackUrl,
  hashFalCallbackToken,
  hashFalSubmitPayload,
  submitFalQueueOnce,
  type FalQueueSubmitOutcome,
} from "./fal-submit-once.ts";
import { parseBirefnetOutput } from "./birefnet-contract.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type DollPickSubmitIntent = {
  input: Readonly<{ image_url: string; output_format: "png" }>;
  payloadHash: string;
  callbackToken: string;
  callbackTokenHash: string;
  webhookUrl: string;
};

export function deriveDollPickCallbackToken(args: {
  credentials: string;
  generationId: string;
  attemptId: string;
  payloadHash: string;
}): string {
  if (
    args.credentials.length < 1 ||
    !UUID_RE.test(args.generationId) ||
    !UUID_RE.test(args.attemptId) ||
    !HASH_RE.test(args.payloadHash)
  ) {
    throw new Error("invalid_doll_pick_callback_binding");
  }
  return createHmac("sha256", args.credentials)
    .update(
      `boss-paegi:doll-pick:v1:${args.generationId}:${args.attemptId}:${args.payloadHash}`,
      "utf8",
    )
    .digest("base64url");
}

export function createDollPickSubmitIntent(args: {
  siteOrigin: string;
  generationId: string;
  attemptId: string;
  imageUrl: string;
  credentials: string;
}): DollPickSubmitIntent {
  if (
    !UUID_RE.test(args.generationId) ||
    !UUID_RE.test(args.attemptId) ||
    typeof args.imageUrl !== "string" ||
    args.imageUrl.length === 0
  ) {
    throw new Error("invalid_doll_pick_submit_input");
  }
  const input = {
    image_url: args.imageUrl,
    output_format: "png" as const,
  };
  const payloadHash = hashFalSubmitPayload(input);
  const callbackToken = deriveDollPickCallbackToken({
    credentials: args.credentials,
    generationId: args.generationId,
    attemptId: args.attemptId,
    payloadHash,
  });
  const callbackTokenHash = hashFalCallbackToken(callbackToken);
  const webhookUrl = buildFalCallbackUrl({
    siteUrl: args.siteOrigin,
    generationId: args.generationId,
    candidateIndex: 0,
    token: callbackToken,
    payloadHash,
  });
  const url = new URL(webhookUrl);
  url.pathname = "/api/fal/pick-webhook";
  url.searchParams.delete("c");
  url.searchParams.set("a", args.attemptId);
  return {
    input,
    payloadHash,
    callbackToken,
    callbackTokenHash,
    webhookUrl: url.toString(),
  };
}

export function dollPickSubmitIntentRpcPayload(
  intent: DollPickSubmitIntent,
) {
  return {
    p_input_payload: intent.input,
    p_payload_hash: intent.payloadHash,
    p_callback_token_hash: intent.callbackTokenHash,
  };
}

export function submitDollPickOnce(args: {
  intent: DollPickSubmitIntent;
  credentials: string;
  fetchImpl?: typeof fetch;
}): Promise<FalQueueSubmitOutcome> {
  return submitFalQueueOnce({
    endpoint: "fal-ai/birefnet",
    input: args.intent.input,
    webhookUrl: args.intent.webhookUrl,
    credentials: args.credentials,
    fetchImpl: args.fetchImpl,
  });
}

export type DollPickClaim =
  | { kind: "claimed"; attemptId: string }
  | { kind: "processing"; attemptId: string }
  | { kind: "resume"; attemptId: string; requestId: string }
  | {
      kind: "provider_done";
      attemptId: string;
      requestId: string;
      resultUrl: string;
    }
  | { kind: "already_picked"; dollId: string }
  | {
      kind: "blocked";
      outcome:
        | "not_found"
        | "not_selectable"
        | "candidate_not_found"
        | "candidate_conflict"
        | "rejected"
        | "expired"
        | "manual_review"
        | "account_deleted";
    }
  | { kind: "invalid" };

export function parseDollPickClaim(value: unknown): DollPickClaim {
  const row = exactObject(value);
  if (!row || typeof row.outcome !== "string") return { kind: "invalid" };
  if (
    (row.outcome === "claimed" || row.outcome === "processing") &&
    row.ok === true &&
    typeof row.attempt_id === "string" &&
    UUID_RE.test(row.attempt_id)
  ) {
    return {
      kind: row.outcome,
      attemptId: row.attempt_id,
    };
  }
  if (
    row.outcome === "resume" &&
    row.ok === true &&
    typeof row.attempt_id === "string" &&
    UUID_RE.test(row.attempt_id) &&
    typeof row.request_id === "string" &&
    REQUEST_ID_RE.test(row.request_id)
  ) {
    return {
      kind: "resume",
      attemptId: row.attempt_id,
      requestId: row.request_id,
    };
  }
  if (
    row.outcome === "provider_done" &&
    row.ok === true &&
    typeof row.attempt_id === "string" &&
    UUID_RE.test(row.attempt_id) &&
    typeof row.request_id === "string" &&
    REQUEST_ID_RE.test(row.request_id) &&
    typeof row.result_url === "string" &&
    parseBirefnetOutput({
      image: {
        url: row.result_url,
        width: 1,
        height: 1,
        content_type: "image/png",
      },
    })
  ) {
    return {
      kind: "provider_done",
      attemptId: row.attempt_id,
      requestId: row.request_id,
      resultUrl: row.result_url,
    };
  }
  if (
    row.outcome === "already_picked" &&
    row.ok === true &&
    typeof row.doll_id === "string" &&
    UUID_RE.test(row.doll_id)
  ) {
    return { kind: "already_picked", dollId: row.doll_id };
  }
  if (
    [
      "not_found",
      "not_selectable",
      "candidate_not_found",
      "candidate_conflict",
      "rejected",
      "expired",
      "manual_review",
      "account_deleted",
    ].includes(row.outcome)
  ) {
    return {
      kind: "blocked",
      outcome: row.outcome as DollPickClaim extends {
        kind: "blocked";
        outcome: infer T;
      }
        ? T
        : never,
    };
  }
  return { kind: "invalid" };
}

export function validDollPickPrepare(value: unknown): boolean {
  const row = exactObject(value);
  return (
    row?.ok === true &&
    (row.outcome === "prepared" || row.outcome === "submitting")
  );
}

export function parseDollPickSubmitRecord(
  value: unknown,
): "acknowledged" | "uncertain" | "rejected" | "blocked" {
  const row = exactObject(value);
  return row?.ok === true &&
    (row.outcome === "acknowledged" ||
      row.outcome === "already_acknowledged" ||
      row.outcome === "uncertain" ||
      row.outcome === "rejected")
    ? row.outcome === "already_acknowledged"
      ? "acknowledged"
      : row.outcome
    : "blocked";
}

export type DollPickMaterializationClaim =
  | {
      kind: "claimed";
      ownerId: string;
      candidateIndex: number;
      attemptId: string;
      resultUrl: string;
    }
  | { kind: "processing" }
  | { kind: "committed"; dollId: string }
  | { kind: "blocked"; outcome: string }
  | { kind: "invalid" };

export function parseDollPickMaterializationClaim(
  value: unknown,
): DollPickMaterializationClaim {
  const row = exactObject(value);
  if (row?.ok !== true || typeof row.outcome !== "string") {
    return row && typeof row.outcome === "string"
      ? { kind: "blocked", outcome: row.outcome }
      : { kind: "invalid" };
  }
  if (row.outcome === "processing") return { kind: "processing" };
  if (
    row.outcome === "committed" &&
    typeof row.doll_id === "string" &&
    UUID_RE.test(row.doll_id)
  ) {
    return { kind: "committed", dollId: row.doll_id };
  }
  if (
    row.outcome !== "claimed" ||
    typeof row.owner_id !== "string" ||
    !UUID_RE.test(row.owner_id) ||
    !Number.isInteger(row.candidate_index) ||
    (row.candidate_index as number) < 0 ||
    (row.candidate_index as number) > 2 ||
    typeof row.attempt_id !== "string" ||
    !UUID_RE.test(row.attempt_id) ||
    typeof row.result_url !== "string" ||
    !parseBirefnetOutput({
      image: {
        url: row.result_url,
        width: 1,
        height: 1,
        content_type: "image/png",
      },
    })
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "claimed",
    ownerId: row.owner_id,
    candidateIndex: row.candidate_index as number,
    attemptId: row.attempt_id,
    resultUrl: row.result_url,
  };
}

export function parseDollPickCommit(value: unknown):
  | { ok: true; doll: Record<string, unknown> & { id: string } }
  | { ok: false } {
  const row = exactObject(value);
  const doll = exactObject(row?.doll);
  if (
    row?.ok !== true ||
    (row.outcome !== "committed" &&
      row.outcome !== "already_committed") ||
    !doll ||
    typeof doll.id !== "string" ||
    !UUID_RE.test(doll.id)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    doll: doll as Record<string, unknown> & { id: string },
  };
}

export function parseDollPickWebhookPayload(
  rawBody: Uint8Array,
  signedRequestId: string,
):
  | { status: "OK"; requestId: string; resultUrl: string }
  | { status: "ERROR"; requestId: string; resultUrl: null }
  | null {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    ) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.request_id !== signedRequestId ||
      (value.status !== "OK" && value.status !== "ERROR")
    ) {
      return null;
    }
    if (value.status === "ERROR") {
      return { status: "ERROR", requestId: signedRequestId, resultUrl: null };
    }
    const output = parseBirefnetOutput(value.payload);
    return output
      ? {
          status: "OK",
          requestId: signedRequestId,
          resultUrl: output.url,
        }
      : null;
  } catch {
    return null;
  }
}

export function validDollPickBinding(args: {
  generationId: string | null;
  attemptId: string | null;
  token: string | null;
  payloadHash: string | null;
}): args is {
  generationId: string;
  attemptId: string;
  token: string;
  payloadHash: string;
} {
  return (
    typeof args.generationId === "string" &&
    UUID_RE.test(args.generationId) &&
    typeof args.attemptId === "string" &&
    UUID_RE.test(args.attemptId) &&
    typeof args.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(args.token) &&
    typeof args.payloadHash === "string" &&
    HASH_RE.test(args.payloadHash)
  );
}
