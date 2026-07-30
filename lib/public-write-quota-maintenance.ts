import {
  parsePublicWriteQuotaPruneAck,
  type PublicWriteQuotaPruneAck,
} from "./ops-rpc-result.ts";

export const TELEMETRY_QUOTA_DAILY_ROW_CEILING = 50_000 + 1;
export const TRACK_QUOTA_DAILY_ROW_CEILING = 2_000 + 1;
export const SCORE_QUOTA_DAILY_ROW_CEILING = 5_000 * 2 + 1;
export const REPORT_QUOTA_DAILY_ROW_CEILING = 500 + 1;
export const DOLL_SIGNED_URL_QUOTA_DAILY_ROW_CEILING = 10_000 + 1;
export const SCORE_ATTEMPT_DAILY_ROW_CEILING = 5_000;
export const REPORT_ATTEMPT_DAILY_ROW_CEILING = 500;
export const PUBLIC_WRITE_ATTEMPT_DAILY_ROW_CEILING =
  SCORE_ATTEMPT_DAILY_ROW_CEILING + REPORT_ATTEMPT_DAILY_ROW_CEILING;
export const PUBLIC_WRITE_QUOTA_DAILY_ROW_CEILING =
  TELEMETRY_QUOTA_DAILY_ROW_CEILING +
  TRACK_QUOTA_DAILY_ROW_CEILING +
  SCORE_QUOTA_DAILY_ROW_CEILING +
  REPORT_QUOTA_DAILY_ROW_CEILING +
  DOLL_SIGNED_URL_QUOTA_DAILY_ROW_CEILING +
  PUBLIC_WRITE_ATTEMPT_DAILY_ROW_CEILING;
// One indexed batch alone exceeds a mathematically maximal day. The second is
// bounded catch-up capacity after a missed invocation; the 10s sub-budget may
// stop after the first without allowing sustained maximum-load backlog growth.
export const PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT = 80_000;
export const PUBLIC_WRITE_QUOTA_PRUNE_MAX_BATCHES = 2;
// Leave at least 15s of the 25s ops-route ceiling for telemetry
// rollup/prune/budget stages and response serialization.
export const PUBLIC_WRITE_QUOTA_PRUNE_TIME_BUDGET_MS = 10_000;
export const PUBLIC_WRITE_QUOTA_PRUNE_CAPACITY =
  PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT * PUBLIC_WRITE_QUOTA_PRUNE_MAX_BATCHES;

if (PUBLIC_WRITE_QUOTA_PRUNE_CAPACITY < PUBLIC_WRITE_QUOTA_DAILY_ROW_CEILING) {
  throw new Error("public_write_quota_prune_capacity_below_daily_ceiling");
}

type RpcResult = { data: unknown; error: unknown | null };

export type PublicWriteQuotaPruneSummary = PublicWriteQuotaPruneAck & {
  batches: number;
  capacity: number;
};

export type PublicWriteQuotaPruneRun =
  | { ok: true; summary: PublicWriteQuotaPruneSummary }
  | {
      ok: false;
      reason: "rpc_error" | "rpc_throw" | "invalid_result";
      cause?: unknown;
    };

/**
 * Drain at least one mathematically maximal day in one scheduled invocation:
 * telemetry <= 50,001 rows, track <= 2,001, score buckets <= 10,001,
 * report buckets <= 501, 008901 doll signed URLs <= 10,001, and accepted
 * score/report attempt reservations <= 5,500. One indexed 80k batch exceeds
 * the exact 78,005-row daily ceiling; the optional second batch catches up a
 * missed run. A time-budget or lock backlog remains done=false and visible.
 */
export async function runPublicWriteQuotaPrune(
  rpc: (limit: number) => PromiseLike<RpcResult>,
  now: () => number = Date.now,
): Promise<PublicWriteQuotaPruneRun> {
  const startedAt = now();
  let totalDeleted = 0;
  let batches = 0;
  let latest: PublicWriteQuotaPruneAck | null = null;

  while (batches < PUBLIC_WRITE_QUOTA_PRUNE_MAX_BATCHES) {
    if (
      batches > 0 &&
      now() - startedAt >= PUBLIC_WRITE_QUOTA_PRUNE_TIME_BUDGET_MS
    ) {
      break;
    }
    let result: RpcResult;
    try {
      result = await rpc(PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT);
    } catch (cause) {
      return { ok: false, reason: "rpc_throw", cause };
    }
    if (result.error !== null && result.error !== undefined) {
      return { ok: false, reason: "rpc_error", cause: result.error };
    }
    const ack = parsePublicWriteQuotaPruneAck(
      result.data,
      PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT,
    );
    if (!ack) return { ok: false, reason: "invalid_result" };

    latest = ack;
    totalDeleted += ack.deleted;
    batches += 1;
    if (ack.done || ack.deleted === 0) break;
  }

  if (!latest) return { ok: false, reason: "invalid_result" };
  return {
    ok: true,
    summary: {
      ok: true,
      deleted: totalDeleted,
      done: latest.done,
      cutoff: latest.cutoff,
      batches,
      capacity: PUBLIC_WRITE_QUOTA_PRUNE_CAPACITY,
    },
  };
}
