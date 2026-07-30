function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

export type AccountConsentHttpAck = { ok: true };

export function parseAccountConsentHttpAck(
  value: unknown,
): AccountConsentHttpAck | null {
  return isExactObject(value, ["ok"]) && value.ok === true
    ? { ok: true }
    : null;
}

export type AccountDeletionHttpAck =
  | { ok: true; cleanup: "completed" }
  | { accepted: true; cleanup: "pending" };

/**
 * Account deletion commits before either response is returned. A 202 means
 * only that the durable external-asset cleanup remains queued, so both exact
 * acknowledgements authorize signing the deleted session out.
 */
export function parseAccountDeletionHttpAck(
  value: unknown,
): AccountDeletionHttpAck | null {
  if (
    isExactObject(value, ["ok", "cleanup"]) &&
    value.ok === true &&
    value.cleanup === "completed"
  ) {
    return { ok: true, cleanup: "completed" };
  }
  if (
    isExactObject(value, ["accepted", "cleanup"]) &&
    value.accepted === true &&
    value.cleanup === "pending"
  ) {
    return { accepted: true, cleanup: "pending" };
  }
  return null;
}
