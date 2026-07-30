export const GENERATION_FAILURE_SUCCESS_OUTCOMES = [
  "no_op",
  "no_consume",
  "refunded",
  "shortfall_absorbed",
] as const;

export type GenerationFailureSuccessOutcome =
  (typeof GENERATION_FAILURE_SUCCESS_OUTCOMES)[number];

export type GenerationFailureRpcResult =
  | {
      ok: true;
      outcome: GenerationFailureSuccessOutcome;
    }
  | {
      ok: false;
      outcome: "version_conflict";
    };

/**
 * Failure/refund is a financial state transition. A resolved Supabase RPC is
 * only success when its JSON contract explicitly says so; malformed or future
 * unknown outcomes stay retryable instead of being reported as refunded.
 */
export function parseGenerationFailureRpcResult(
  value: unknown,
): GenerationFailureRpcResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false && record.outcome === "version_conflict") {
    return { ok: false, outcome: "version_conflict" };
  }
  if (
    record.ok !== true ||
    typeof record.outcome !== "string" ||
    !GENERATION_FAILURE_SUCCESS_OUTCOMES.includes(
      record.outcome as GenerationFailureSuccessOutcome,
    )
  ) {
    return null;
  }
  return {
    ok: true,
    outcome: record.outcome as GenerationFailureSuccessOutcome,
  };
}
