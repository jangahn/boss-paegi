import { createHash } from "node:crypto";
import {
  parsePersistedFaceAnalysis,
  type FaceAnalysis,
  type InputRejectReason,
} from "./face-analysis.ts";
import {
  generationConfigSchema,
  type GenerationConfig,
} from "../config/domains/generation.ts";
import {
  parsePersistedGenerationPlan,
  type GenerationPlan,
} from "./plan.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_RE = /^[a-z0-9_]{1,100}$/;

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type GenerationPreflightClaim =
  | { kind: "claimed" }
  | { kind: "processing" }
  | {
      kind: "accepted";
      analysis: FaceAnalysis;
      config: PersistedGenerationConfig;
    }
  | { kind: "committed"; generationId: string }
  | { kind: "rejected"; reason: InputRejectReason }
  | {
      kind: "blocked";
      outcome:
        | "no_credits"
        | "user_day_quota"
        | "global_day_quota"
        | "user_inflight_quota"
        | "global_inflight_quota"
        | "released"
        | "failed"
        | "expired";
    }
  | { kind: "invalid" };

const BLOCKED_PREFLIGHT_OUTCOMES = new Set([
  "no_credits",
  "user_day_quota",
  "global_day_quota",
  "user_inflight_quota",
  "global_inflight_quota",
  "released",
  "failed",
  "expired",
]);
const INPUT_REJECTIONS = new Set([
  "no_face",
  "multiple_people",
  "face_obstructed",
]);

export type PersistedGenerationConfig = {
  value: GenerationConfig;
  source: "db" | "default";
  version: number | null;
  invalid: boolean;
};

function parsePersistedGenerationConfig(
  row: Record<string, unknown>,
): PersistedGenerationConfig | null {
  const parsed = generationConfigSchema.safeParse(row.generation_config);
  if (
    !parsed.success ||
    (row.config_source !== "db" && row.config_source !== "default") ||
    !(
      row.config_version === null ||
      (Number.isSafeInteger(row.config_version) &&
        (row.config_version as number) >= 1)
    ) ||
    (row.config_source === "db" && row.config_version === null) ||
    (row.config_source === "default" && row.config_version !== null) ||
    typeof row.config_invalid !== "boolean"
  ) {
    return null;
  }
  return {
    value: parsed.data,
    source: row.config_source,
    version: row.config_version as number | null,
    invalid: row.config_invalid,
  };
}

export function parseGenerationPreflightClaim(
  value: unknown,
): GenerationPreflightClaim {
  const row = exactObject(value);
  if (!row || typeof row.outcome !== "string") return { kind: "invalid" };
  if (row.outcome === "claimed" && row.ok === true) return { kind: "claimed" };
  if (row.outcome === "processing" && row.ok === true) {
    return { kind: "processing" };
  }
  if (row.outcome === "accepted" && row.ok === true) {
    const analysis = parsePersistedFaceAnalysis(row.analysis);
    const config = parsePersistedGenerationConfig(row);
    return analysis && config
      ? { kind: "accepted", analysis, config }
      : { kind: "invalid" };
  }
  if (
    row.outcome === "committed" &&
    row.ok === true &&
    typeof row.generation_id === "string" &&
    UUID_RE.test(row.generation_id)
  ) {
    return { kind: "committed", generationId: row.generation_id };
  }
  if (
    row.outcome === "rejected" &&
    row.ok === true &&
    typeof row.reason === "string" &&
    INPUT_REJECTIONS.has(row.reason)
  ) {
    return {
      kind: "rejected",
      reason: row.reason as InputRejectReason,
    };
  }
  if (BLOCKED_PREFLIGHT_OUTCOMES.has(row.outcome)) {
    return {
      kind: "blocked",
      outcome: row.outcome as Exclude<
        GenerationPreflightClaim,
        { kind: "claimed" | "processing" | "accepted" | "committed" | "rejected" | "invalid" }
      >["outcome"],
    };
  }
  return { kind: "invalid" };
}

export function validPreflightMutationAck(
  value: unknown,
  outcome: "accepted" | "rejected" | "failed" | "released",
): boolean {
  const row = exactObject(value);
  return row?.ok === true && row.outcome === outcome;
}

export type GenerationPreflightCommit =
  | {
      ok: true;
      generationId: string;
      remaining: number | null;
      analysis: FaceAnalysis;
      config: PersistedGenerationConfig;
      plan: GenerationPlan;
    }
  | { ok: false };

export function parseGenerationPreflightCommit(
  value: unknown,
): GenerationPreflightCommit {
  const row = exactObject(value);
  if (
    row?.ok !== true ||
    row.outcome !== "committed" ||
    typeof row.generation_id !== "string" ||
    !UUID_RE.test(row.generation_id) ||
    !(
      row.remaining === null ||
      (Number.isSafeInteger(row.remaining) && (row.remaining as number) >= 0)
    )
  ) {
    return { ok: false };
  }
  const analysis = parsePersistedFaceAnalysis(row.analysis);
  const config = parsePersistedGenerationConfig(row);
  const plan = parsePersistedGenerationPlan(row.generation_plan);
  if (!analysis || !config || !plan) return { ok: false };
  return {
    ok: true,
    generationId: row.generation_id,
    remaining: row.remaining as number | null,
    analysis,
    config,
    plan,
  };
}

export function validTerminalReason(value: unknown): value is string {
  return typeof value === "string" && REASON_RE.test(value);
}

export type GenerationContinuationClaim =
  | {
      kind: "claimed";
      generationId: string;
      analysis: FaceAnalysis;
      config: PersistedGenerationConfig;
      plan: GenerationPlan;
    }
  | { kind: "processing"; generationId: string }
  | { kind: "submitted"; generationId: string }
  | { kind: "invalid" };

export function parseGenerationContinuationClaim(
  value: unknown,
): GenerationContinuationClaim {
  const row = exactObject(value);
  if (
    row?.ok !== true ||
    typeof row.generation_id !== "string" ||
    !UUID_RE.test(row.generation_id)
  ) {
    return { kind: "invalid" };
  }
  if (row.outcome === "processing") {
    return { kind: "processing", generationId: row.generation_id };
  }
  if (row.outcome === "submitted") {
    return { kind: "submitted", generationId: row.generation_id };
  }
  if (row.outcome === "claimed") {
    const analysis = parsePersistedFaceAnalysis(row.analysis);
    const config = parsePersistedGenerationConfig(row);
    const plan = parsePersistedGenerationPlan(row.generation_plan);
    return analysis && config && plan
      ? {
          kind: "claimed",
          generationId: row.generation_id,
          analysis,
          config,
          plan,
        }
      : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

export function validGenerationContinuationComplete(value: unknown): boolean {
  const row = exactObject(value);
  return row?.ok === true && row.outcome === "submitted";
}
