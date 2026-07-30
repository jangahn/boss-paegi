export type LegacyUploadOrphanSweep = {
  enabled: boolean;
  examined: number;
  enqueued: number;
  protected: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The maintenance route treats this RPC as deletion authority, so accepting a
 * partial or widened acknowledgement would be a false-green cleanup result.
 */
export function parseLegacyUploadOrphanSweep(
  value: unknown,
  limit: number,
): LegacyUploadOrphanSweep | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "enabled",
    "enqueued",
    "examined",
    "ok",
    "protected",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    value.ok !== true ||
    typeof value.enabled !== "boolean" ||
    !isCount(value.examined) ||
    !isCount(value.enqueued) ||
    !isCount(value.protected)
  ) {
    return null;
  }

  const examined = value.examined as number;
  const enqueued = value.enqueued as number;
  const protectedCount = value.protected as number;
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  if (
    examined > boundedLimit ||
    enqueued > examined ||
    protectedCount > examined ||
    enqueued + protectedCount > examined ||
    (!value.enabled &&
      (examined !== 0 || enqueued !== 0 || protectedCount !== 0))
  ) {
    return null;
  }
  return {
    enabled: value.enabled,
    examined,
    enqueued,
    protected: protectedCount,
  };
}
