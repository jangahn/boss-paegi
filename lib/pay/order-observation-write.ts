import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  parsePaidOrderPostcondition,
  type PaidOrderPostcondition,
} from "@/lib/pay/order-mutation-result";

type AdminClient = ReturnType<typeof createAdminClient>;

type ObservationFence = {
  orderUuid: string;
  expectedStatus: string;
  expectedErrorMessage: string | null;
};

export type OrderObservationWriteResult =
  | {
      ok: true;
      outcome: "recorded";
      status: "pending" | "failed";
    }
  | {
      ok: true;
      outcome: "terminal";
      status: "paid" | "canceled";
      paidState: PaidOrderPostcondition | null;
    }
  | {
      ok: false;
      error: unknown;
    };

type ObservationPostcondition =
  | { kind: "marker"; errorMessage: string }
  | { kind: "provider_state"; pgStatus: string };

function isObservationAck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  return (
    keys.length === 2 &&
    keys.includes("ok") &&
    keys.includes("outcome") &&
    row.ok === true &&
    (row.outcome === "recorded" || row.outcome === "terminal" || row.outcome === "skipped")
  );
}

async function writeUnsettledOrderObservation(
  admin: AdminClient,
  fence: ObservationFence,
  patch: Record<string, unknown>,
  postcondition: ObservationPostcondition,
): Promise<OrderObservationWriteResult> {
  const { data: ack, error: updateError } = await admin.rpc(
    "record_unsettled_order_observation",
    {
      p_order_uuid: fence.orderUuid,
      p_expected_status: fence.expectedStatus,
      p_expected_error_message: fence.expectedErrorMessage,
      p_kind: postcondition.kind,
      p_error_message:
        postcondition.kind === "marker" ? postcondition.errorMessage : null,
      p_pg_status:
        postcondition.kind === "provider_state" ? postcondition.pgStatus : null,
      p_raw: postcondition.kind === "provider_state" ? patch.raw : null,
    },
  );
  if (updateError) return { ok: false, error: updateError };
  if (!isObservationAck(ack)) {
    return { ok: false, error: new Error("observation_ack_invalid") };
  }

  // A zero-row conditional UPDATE is ambiguous: a concurrent finalizer may
  // have won, or the expected marker may have changed. Re-read and accept only
  // a durable exact write postcondition or a fully proved terminal state.
  const { data: current, error: readError } = await admin
    .from("orders")
    .select("status, paid_at, error_message, pg_status, raw")
    .eq("order_uuid", fence.orderUuid)
    .maybeSingle();
  if (readError || !current) {
    return { ok: false, error: readError ?? new Error("order_not_found") };
  }

  const paid = parsePaidOrderPostcondition(current);
  if (paid) {
    return {
      ok: true,
      outcome: "terminal",
      status: "paid",
      paidState: paid,
    };
  }
  if (current.status === "canceled") {
    return {
      ok: true,
      outcome: "terminal",
      status: "canceled",
      paidState: null,
    };
  }
  if (
    (current.status !== "pending" && current.status !== "failed") ||
    current.paid_at !== null
  ) {
    return { ok: false, error: new Error("observation_postcondition_invalid") };
  }

  if (postcondition.kind === "marker") {
    return current.error_message === postcondition.errorMessage
      ? { ok: true, outcome: "recorded", status: current.status }
      : { ok: false, error: new Error("observation_marker_not_recorded") };
  }

  const raw =
    current.raw && typeof current.raw === "object" && !Array.isArray(current.raw)
      ? (current.raw as Record<string, unknown>)
      : null;
  return current.pg_status === postcondition.pgStatus &&
    raw?.verified_status === postcondition.pgStatus
    ? { ok: true, outcome: "recorded", status: current.status }
    : { ok: false, error: new Error("provider_state_not_recorded") };
}

export function recordOrderEvidenceMarkerIfUnsettled(
  admin: AdminClient,
  fence: ObservationFence & { marker: string },
): Promise<OrderObservationWriteResult> {
  return writeUnsettledOrderObservation(
    admin,
    fence,
    { error_message: fence.marker },
    { kind: "marker", errorMessage: fence.marker },
  );
}

export function recordOrderProviderStateIfUnsettled(
  admin: AdminClient,
  fence: ObservationFence & {
    pgStatus: string;
    raw: Record<string, unknown>;
  },
): Promise<OrderObservationWriteResult> {
  return writeUnsettledOrderObservation(
    admin,
    fence,
    { pg_status: fence.pgStatus, raw: fence.raw },
    { kind: "provider_state", pgStatus: fence.pgStatus },
  );
}
