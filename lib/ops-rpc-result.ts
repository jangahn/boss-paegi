type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonObject,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export type OpsRpcResolution =
  | { ok: true; data: unknown }
  | { ok: false; error: unknown };

/** Normalize PostgREST resolved errors and client/transport rejections. */
export async function resolveOpsRpc(
  run: () => PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<OpsRpcResolution> {
  try {
    const result = await run();
    return result.error != null
      ? { ok: false, error: result.error }
      : { ok: true, data: result.data };
  } catch (error) {
    return { ok: false, error };
  }
}

export type RollupMaintenanceAck = {
  ok: true;
  days: number;
};

export function parseRollupMaintenanceAck(
  value: unknown,
  expectedDays: number,
): RollupMaintenanceAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["ok", "days"]) ||
    value.ok !== true ||
    !Number.isSafeInteger(expectedDays) ||
    expectedDays < 1 ||
    value.days !== expectedDays
  ) {
    return null;
  }
  return { ok: true, days: expectedDays };
}

export type AnalyticsPruneAck = {
  ok: true;
  deleted: number;
  cutoff: string;
};

export function parseAnalyticsPruneAck(
  value: unknown,
): AnalyticsPruneAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["ok", "deleted", "cutoff"]) ||
    value.ok !== true ||
    !isCount(value.deleted) ||
    typeof value.cutoff !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.cutoff) ||
    Number.isNaN(Date.parse(`${value.cutoff}T00:00:00.000Z`))
  ) {
    return null;
  }
  return { ok: true, deleted: value.deleted, cutoff: value.cutoff };
}

export type TelemetryPruneAck = {
  ok: true;
  timeline_nulled: number;
  anon_deleted: number;
  over_budget_deleted: number;
  bytes: number;
};

export function parseTelemetryPruneAck(
  value: unknown,
): TelemetryPruneAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "ok",
      "timeline_nulled",
      "anon_deleted",
      "over_budget_deleted",
      "bytes",
    ]) ||
    value.ok !== true ||
    !isCount(value.timeline_nulled) ||
    !isCount(value.anon_deleted) ||
    !isCount(value.over_budget_deleted) ||
    !isCount(value.bytes)
  ) {
    return null;
  }
  return {
    ok: true,
    timeline_nulled: value.timeline_nulled,
    anon_deleted: value.anon_deleted,
    over_budget_deleted: value.over_budget_deleted,
    bytes: value.bytes,
  };
}

export type TelemetryBudgetAck = {
  ok: true;
  bytes: number;
  degrade_mode: "full" | "summary" | "off";
};

export function parseTelemetryBudgetAck(
  value: unknown,
): TelemetryBudgetAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["ok", "bytes", "degrade_mode"]) ||
    value.ok !== true ||
    !isCount(value.bytes) ||
    (value.degrade_mode !== "full" &&
      value.degrade_mode !== "summary" &&
      value.degrade_mode !== "off")
  ) {
    return null;
  }
  return {
    ok: true,
    bytes: value.bytes,
    degrade_mode: value.degrade_mode,
  };
}

export type PublicWriteQuotaPruneAck = {
  ok: true;
  deleted: number;
  done: boolean;
  cutoff: string;
};

export function parsePublicWriteQuotaPruneAck(
  value: unknown,
  requestedLimit: number,
): PublicWriteQuotaPruneAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["ok", "deleted", "done", "cutoff"]) ||
    value.ok !== true ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    !isCount(value.deleted) ||
    value.deleted > requestedLimit ||
    typeof value.done !== "boolean" ||
    typeof value.cutoff !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.cutoff) ||
    Number.isNaN(Date.parse(`${value.cutoff}T00:00:00.000Z`))
  ) {
    return null;
  }
  return {
    ok: true,
    deleted: value.deleted,
    done: value.done,
    cutoff: value.cutoff,
  };
}

export type IntegrityScanAck = {
  scanned: number;
  flagged: number;
};

export function parseIntegrityScanAck(
  value: unknown,
): IntegrityScanAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["scanned", "flagged"]) ||
    !isCount(value.scanned) ||
    !isCount(value.flagged) ||
    value.flagged > value.scanned
  ) {
    return null;
  }
  return { scanned: value.scanned, flagged: value.flagged };
}

export type CreditSweepAck = {
  ok: true;
  expired: number;
};

export function parseCreditSweepAck(
  value: unknown,
  limit: number,
): CreditSweepAck | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["ok", "expired"]) ||
    value.ok !== true ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !isCount(value.expired) ||
    value.expired > limit
  ) {
    return null;
  }
  return { ok: true, expired: value.expired };
}
