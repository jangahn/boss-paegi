const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PermanentDeleteHttpOutcome =
  | { kind: "completed" }
  | { kind: "pending"; jobId: string };

/**
 * A 202 response is successful HTTP delivery, not completed artifact removal.
 * Only the two exact route contracts are accepted; malformed 2xx responses
 * stay visible as failures instead of optimistically closing the operator UI.
 */
export function parsePermanentDeleteHttpOutcome(
  status: number,
  value: unknown,
): PermanentDeleteHttpOutcome | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (status === 202) {
    return body.accepted === true &&
      body.purge === "pending" &&
      typeof body.jobId === "string" &&
      UUID_RE.test(body.jobId)
      ? { kind: "pending", jobId: body.jobId.toLowerCase() }
      : null;
  }
  if (status !== 200 || body.ok !== true) return null;
  if (body.already_purged === true) {
    return body.purged === undefined && body.failed === undefined
      ? { kind: "completed" }
      : null;
  }
  return body.purged === true && body.failed === 0
    ? { kind: "completed" }
    : null;
}
