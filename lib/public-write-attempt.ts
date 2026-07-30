const ERROR_CODE_RE = /^[a-z0-9_]{1,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export type PublicWriteAttemptReservation =
  | { kind: "reserved" }
  | { kind: "replay"; result: unknown }
  | {
      kind: "error";
      outcome: "failed" | "quota" | "busy";
      errorCode: string;
    };

/** Strict parser for the pre-core durable reservation RPC contract. */
export function parsePublicWriteAttemptReservation(
  value: unknown,
): PublicWriteAttemptReservation | null {
  const row = record(value);
  if (!row || typeof row.outcome !== "string") return null;
  if (
    row.ok === true &&
    row.outcome === "reserved" &&
    exactKeys(row, ["ok", "outcome"])
  ) {
    return { kind: "reserved" };
  }
  if (
    row.ok === true &&
    row.outcome === "replay" &&
    exactKeys(row, ["ok", "outcome", "result"])
  ) {
    return { kind: "replay", result: row.result };
  }
  if (
    row.ok === false &&
    (row.outcome === "failed" ||
      row.outcome === "quota" ||
      row.outcome === "busy") &&
    typeof row.error_code === "string" &&
    ERROR_CODE_RE.test(row.error_code) &&
    exactKeys(row, ["ok", "outcome", "error_code"])
  ) {
    return {
      kind: "error",
      outcome: row.outcome,
      errorCode: row.error_code,
    };
  }
  return null;
}

/** A caught core failure commits as a 2xx envelope so its attempt row survives. */
export function parsePublicWriteAttemptFailure(value: unknown): string | null {
  const row = record(value);
  if (
    !row ||
    row.ok !== false ||
    typeof row.writeAttemptError !== "string" ||
    !ERROR_CODE_RE.test(row.writeAttemptError) ||
    !exactKeys(row, ["ok", "writeAttemptError"])
  ) {
    return null;
  }
  return row.writeAttemptError;
}
