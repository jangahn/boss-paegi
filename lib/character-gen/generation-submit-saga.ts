import type { GenerationPlan } from "./plan.ts";
import { buildFluxPulidInputs } from "./flux-pulid-input.ts";
import { createHmac } from "node:crypto";
import {
  buildFalCallbackUrl,
  hashFalCallbackToken,
  hashFalSubmitPayload,
} from "./fal-submit-once.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GenerationSubmitIntent = {
  index: number;
  input: Readonly<Record<string, unknown>>;
  payloadHash: string;
  callbackTokenHash: string;
  callbackToken: string;
  webhookUrl: string;
};

export function deriveGenerationCallbackToken(args: {
  credentials: string;
  generationId: string;
  candidateIndex: number;
  payloadHash: string;
}): string {
  if (
    args.credentials.length < 1 ||
    !UUID_RE.test(args.generationId) ||
    !Number.isInteger(args.candidateIndex) ||
    args.candidateIndex < 0 ||
    args.candidateIndex > 2 ||
    !/^[0-9a-f]{64}$/.test(args.payloadHash)
  ) {
    throw new Error("invalid_generation_callback_binding");
  }
  return createHmac("sha256", args.credentials)
    .update(
      `boss-paegi:generation-submit:v1:${args.generationId}:${args.candidateIndex}:${args.payloadHash}`,
      "utf8",
    )
    .digest("base64url");
}

export function publicFalWebhookOrigin(siteUrl: string): string | null {
  try {
    const url = new URL(siteUrl);
    const hostname = url.hostname.toLowerCase();
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
      hostname,
    );
    const privateIpv4 =
      !!ipv4 &&
      (() => {
        const octets = ipv4.slice(1).map(Number);
        return (
          octets.some((octet) => octet < 0 || octet > 255) ||
          octets[0] === 10 ||
          octets[0] === 127 ||
          (octets[0] === 169 && octets[1] === 254) ||
          (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
          (octets[0] === 192 && octets[1] === 168)
        );
      })();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      privateIpv4
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function createGenerationSubmitIntents(args: {
  generationId: string;
  siteOrigin: string;
  faceImageUrl: string;
  plan: GenerationPlan;
  credentials: string;
}): GenerationSubmitIntent[] {
  if (!UUID_RE.test(args.generationId)) {
    throw new Error("invalid_generation_submit_id");
  }
  return buildFluxPulidInputs(args.faceImageUrl, args.plan).map(
    ({ index, input }) => {
      const payloadHash = hashFalSubmitPayload(input);
      const callbackToken = deriveGenerationCallbackToken({
        credentials: args.credentials,
        generationId: args.generationId,
        candidateIndex: index,
        payloadHash,
      });
      return {
        index,
        input,
        payloadHash,
        callbackTokenHash: hashFalCallbackToken(callbackToken),
        callbackToken,
        webhookUrl: buildFalCallbackUrl({
          siteUrl: args.siteOrigin,
          generationId: args.generationId,
          candidateIndex: index,
          token: callbackToken,
          payloadHash,
        }),
      };
    },
  );
}

export function generationSubmitIntentRpcPayload(
  intents: readonly GenerationSubmitIntent[],
): {
  candidateIndex: number;
  input: Readonly<Record<string, unknown>>;
  payloadHash: string;
  callbackTokenHash: string;
}[] {
  return intents.map((intent) => ({
    candidateIndex: intent.index,
    input: intent.input,
    payloadHash: intent.payloadHash,
    callbackTokenHash: intent.callbackTokenHash,
  }));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isPreparedSubmitSagaResult(value: unknown): boolean {
  const result = record(value);
  return result?.ok === true && result.outcome === "prepared";
}

export type PersistedGenerationSubmitIntent = {
  index: number;
  input: Readonly<Record<string, unknown>>;
  payloadHash: string;
  callbackTokenHash: string;
  state: string;
};

export function parseGenerationSubmitPreparation(
  value: unknown,
):
  | { kind: "missing" }
  | { kind: "prepared"; intents: PersistedGenerationSubmitIntent[] }
  | { kind: "invalid" } {
  const row = record(value);
  if (row?.ok === true && row.outcome === "missing") {
    return { kind: "missing" };
  }
  if (
    row?.ok !== true ||
    row.outcome !== "prepared" ||
    !Array.isArray(row.intents) ||
    row.intents.length !== 3
  ) {
    return { kind: "invalid" };
  }
  const intents: PersistedGenerationSubmitIntent[] = [];
  for (let index = 0; index < 3; index += 1) {
    const intent = record(row.intents[index]);
    const input = record(intent?.input);
    if (
      !intent ||
      intent.candidate_index !== index ||
      !input ||
      typeof intent.payload_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(intent.payload_hash) ||
      typeof intent.callback_token_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(intent.callback_token_hash) ||
      typeof intent.state !== "string"
    ) {
      return { kind: "invalid" };
    }
    intents.push({
      index,
      input,
      payloadHash: intent.payload_hash,
      callbackTokenHash: intent.callback_token_hash,
      state: intent.state,
    });
  }
  return { kind: "prepared", intents };
}

export type SubmitClaimResult =
  | { kind: "claimed" }
  | { kind: "already_acknowledged"; requestId: string }
  | { kind: "blocked"; outcome: string };

export function parseSubmitClaimResult(value: unknown): SubmitClaimResult {
  const result = record(value);
  if (result?.ok === true && result.outcome === "claimed") {
    return { kind: "claimed" };
  }
  if (
    result?.ok === true &&
    result.outcome === "already_acknowledged" &&
    typeof result.requestId === "string" &&
    result.requestId.length > 0
  ) {
    return {
      kind: "already_acknowledged",
      requestId: result.requestId,
    };
  }
  return {
    kind: "blocked",
    outcome:
      typeof result?.outcome === "string" ? result.outcome : "malformed",
  };
}

export type GenerationSubmitWork =
  | {
      kind: "claimed";
      input: Readonly<Record<string, unknown>>;
      payloadHash: string;
      callbackTokenHash: string;
    }
  | { kind: "acknowledged"; requestId: string }
  | { kind: "in_flight"; state: string }
  | { kind: "manual_review" }
  | { kind: "rejected" }
  | { kind: "invalid" };

export function parseGenerationSubmitWork(
  value: unknown,
): GenerationSubmitWork {
  const result = record(value);
  if (!result || typeof result.outcome !== "string") {
    return { kind: "invalid" };
  }
  if (result.ok === true && result.outcome === "claimed") {
    const input = record(result.input);
    if (
      !input ||
      typeof result.payload_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(result.payload_hash) ||
      typeof result.callback_token_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(result.callback_token_hash)
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "claimed",
      input,
      payloadHash: result.payload_hash,
      callbackTokenHash: result.callback_token_hash,
    };
  }
  if (
    result.ok === true &&
    result.outcome === "acknowledged" &&
    typeof result.request_id === "string" &&
    result.request_id.length >= 1
  ) {
    return { kind: "acknowledged", requestId: result.request_id };
  }
  if (
    result.ok === true &&
    result.outcome === "in_flight" &&
    typeof result.state === "string"
  ) {
    return { kind: "in_flight", state: result.state };
  }
  if (result.outcome === "manual_review") {
    return { kind: "manual_review" };
  }
  if (result.outcome === "rejected") return { kind: "rejected" };
  return { kind: "invalid" };
}

export type SubmitRecordResult =
  | "acknowledged"
  | "already_acknowledged"
  | "uncertain"
  | "rejected"
  | "request_id_conflict"
  | "late_acknowledged"
  | "blocked";

export function parseSubmitRecordResult(value: unknown): SubmitRecordResult {
  const result = record(value);
  const outcome = result?.outcome;
  if (
    outcome === "acknowledged" ||
    outcome === "already_acknowledged" ||
    outcome === "uncertain" ||
    outcome === "rejected"
  ) {
    return result?.ok === true ? outcome : "blocked";
  }
  if (outcome === "request_id_conflict" || outcome === "late_acknowledged") {
    return result?.ok === false ? outcome : "blocked";
  }
  return "blocked";
}
