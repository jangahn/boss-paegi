import type { PendingGeneration } from "./generation.ts";
import type { RoleId } from "./roles/index.ts";

export class InvalidPendingGenerationsResponseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidPendingGenerationsResponseError";
  }
}

const KINDS = new Set(["generating", "ready", "interrupted"]);
const ROLES = new Set(["boss", "exec", "teamlead", "client", "coworker"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const ROOT_KEYS = new Set(["pending"]);
const ROW_KEYS = new Set([
  "id",
  "kind",
  "candidateUrls",
  "createdAt",
  "role",
  "reason",
  "phase",
  "candidatesReady",
]);
const PHASES = new Set(["analyzing", "drawing"]);
const REASONS = new Set(["photo", "provider"]);

export type ParsedPendingGeneration = Omit<PendingGeneration, "role"> & {
  role: RoleId;
};

function validHttpUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

export function parsePendingGenerationsResponse(
  value: unknown,
): ParsedPendingGeneration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidPendingGenerationsResponseError("invalid_response");
  }
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).length !== 1 ||
    !Object.keys(response).every((key) => ROOT_KEYS.has(key))
  ) {
    throw new InvalidPendingGenerationsResponseError("invalid_response");
  }
  const pending = response.pending;
  if (!Array.isArray(pending)) {
    throw new InvalidPendingGenerationsResponseError("invalid_pending_rows");
  }
  const ids = new Set<string>();
  return pending.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InvalidPendingGenerationsResponseError("invalid_pending_row");
    }
    const row = entry as Record<string, unknown>;
    const rowKeys = Object.keys(row);
    if (
      rowKeys.some((key) => !ROW_KEYS.has(key)) ||
      typeof row.id !== "string" ||
      !UUID_RE.test(row.id) ||
      ids.has(row.id) ||
      typeof row.kind !== "string" ||
      !KINDS.has(row.kind) ||
      !Array.isArray(row.candidateUrls) ||
      !row.candidateUrls.every(validHttpUrl) ||
      typeof row.createdAt !== "string" ||
      row.createdAt !== row.createdAt.trim() ||
      !TIMESTAMP_RE.test(row.createdAt) ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      typeof row.role !== "string" ||
      !ROLES.has(row.role) ||
      (row.kind === "ready" &&
        (row.candidateUrls.length < 1 ||
          row.candidateUrls.length > 3 ||
          new Set(row.candidateUrls).size !== row.candidateUrls.length)) ||
      (row.kind !== "ready" && row.candidateUrls.length !== 0) ||
      (row.kind !== "interrupted" && row.reason !== undefined) ||
      (row.kind === "interrupted" &&
        row.reason !== undefined &&
        !REASONS.has(row.reason as string)) ||
      (row.kind !== "generating" &&
        (row.phase !== undefined || row.candidatesReady !== undefined)) ||
      (row.phase !== undefined && !PHASES.has(row.phase as string)) ||
      (row.candidatesReady !== undefined &&
        (typeof row.candidatesReady !== "number" ||
          !Number.isInteger(row.candidatesReady) ||
          row.candidatesReady < 0 ||
          row.candidatesReady > 3))
    ) {
      throw new InvalidPendingGenerationsResponseError("invalid_pending_row");
    }
    ids.add(row.id);
    return {
      id: row.id,
      kind: row.kind,
      candidateUrls: row.candidateUrls,
      createdAt: row.createdAt,
      role: row.role,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      ...(row.candidatesReady === undefined
        ? {}
        : { candidatesReady: row.candidatesReady }),
    } as ParsedPendingGeneration;
  });
}
