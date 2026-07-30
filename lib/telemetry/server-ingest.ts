import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseTelemetryIngestAck,
  type TelemetryIngestAck,
} from "@/lib/telemetry/validate";
import type { TelemetryPayload } from "@/lib/telemetry/types";

export type TelemetryIngestArgs = {
  sessionId: string;
  submitterId: string | null;
  isMember: boolean;
  actorKey: string;
  payload: TelemetryPayload;
};

type RpcResult = { data: unknown; error: unknown | null };
export type TelemetryIngestDependencies = {
  rpc: (args: Record<string, unknown>) => Promise<RpcResult>;
};

export type TelemetryIngestResult =
  | { ok: true; ack: TelemetryIngestAck }
  | {
      ok: false;
      reason: "rpc_error" | "rpc_throw" | "invalid_result";
      cause?: unknown;
    };

const TERMINAL_TELEMETRY_REASONS = new Set([
  "no_session",
  "invalid_payload",
  "account_not_found",
  "account_deleted",
  "account_migrated",
  "member_mismatch",
  "budget",
  "owner_mismatch",
  "already_finalized",
  "pending",
  "session_quota",
  "global_request_quota",
  "actor_request_quota",
  "global_new_session_quota",
  "actor_new_session_quota",
]);

/**
 * Call the five-argument, DB-authoritative quota wrapper. Dependency injection
 * keeps resolved-error, throw, and malformed-success paths directly testable.
 */
export async function ingestTelemetryBounded(
  args: TelemetryIngestArgs,
  dependencies?: TelemetryIngestDependencies,
): Promise<TelemetryIngestResult> {
  const rpc =
    dependencies?.rpc ??
    (async (rpcArgs: Record<string, unknown>): Promise<RpcResult> => {
      const admin = createAdminClient();
      return admin.rpc("ingest_telemetry_delta", rpcArgs);
    });

  let result: RpcResult;
  try {
    result = await rpc({
      p_session_id: args.sessionId,
      p_owner_id: args.submitterId,
      p_is_member: args.isMember,
      p_actor_key: args.actorKey,
      p_payload: args.payload,
    });
  } catch (cause) {
    return { ok: false, reason: "rpc_throw", cause };
  }
  if (result.error !== null && result.error !== undefined) {
    return { ok: false, reason: "rpc_error", cause: result.error };
  }
  const ack = parseTelemetryIngestAck(result.data);
  if (!ack) return { ok: false, reason: "invalid_result" };
  return { ok: true, ack };
}

/**
 * Only an authoritative, durable DB rejection is terminal. Dependency faults,
 * malformed responses, and quota lock contention must remain unacknowledged
 * so the browser preserves its delta for a bounded retry.
 */
export function telemetryDropAck(
  lastSeq: number,
  reason: string,
): TelemetryIngestAck {
  return {
    ok: true,
    mode: "off",
    reason,
    lastSeq,
  };
}

export function isTerminalTelemetryAck(
  ack: TelemetryIngestAck,
): boolean {
  if (ack.reason === "quota_busy") return false;
  if (ack.ok) {
    return (
      typeof ack.lastSeq === "number" &&
      Number.isSafeInteger(ack.lastSeq)
    );
  }
  return (
    typeof ack.reason === "string" &&
    TERMINAL_TELEMETRY_REASONS.has(ack.reason)
  );
}
