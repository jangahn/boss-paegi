export const CONTENT_REPORT_REASONS = [
  "portrait",
  "defamation",
  "obscene",
  "hate",
  "other",
] as const;

export type ContentReportReason = (typeof CONTENT_REPORT_REASONS)[number];

const REASON_SET = new Set<string>(CONTENT_REPORT_REASONS);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ContentReportInput = {
  submissionId: string;
  targetId: string;
  reason: ContentReportReason;
  detail: string | null;
  contact: string | null;
};

export type ContentReportInputResult =
  | { ok: true; value: ContentReportInput }
  | {
      ok: false;
      error:
        | "missing_fields"
        | "client_upgrade_required"
        | "submission_id_invalid"
        | "reason_invalid"
        | "detail_invalid"
        | "contact_invalid";
    };

export function createContentReportSubmissionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid !== "function") {
    throw new Error("secure random UUID unavailable");
  }
  return randomUuid.call(globalThis.crypto);
}

/** 공개 JSON 경계. 타입 오류·초과 길이를 500/묵시적 절단으로 바꾸지 않는다. */
export function parseContentReportInput(
  input: unknown,
): ContentReportInputResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "missing_fields" };
  }
  const body = input as Record<string, unknown>;
  if (
    typeof body.targetId !== "string" ||
    !UUID_RE.test(body.targetId) ||
    typeof body.reason !== "string"
  ) {
    return { ok: false, error: "missing_fields" };
  }
  if (!REASON_SET.has(body.reason)) {
    return { ok: false, error: "reason_invalid" };
  }
  if (body.submissionId === undefined || body.submissionId === null) {
    // An old request has no observable identity. Hashing IP/body/time would
    // conflate a legitimate identical report with a response-loss retry.
    return { ok: false, error: "client_upgrade_required" };
  }
  if (
    typeof body.submissionId !== "string" ||
    !UUID_RE.test(body.submissionId)
  ) {
    return { ok: false, error: "submission_id_invalid" };
  }
  if (
    body.detail !== undefined &&
    body.detail !== null &&
    typeof body.detail !== "string"
  ) {
    return { ok: false, error: "detail_invalid" };
  }
  if (
    body.contact !== undefined &&
    body.contact !== null &&
    typeof body.contact !== "string"
  ) {
    return { ok: false, error: "contact_invalid" };
  }
  const detail = (body.detail as string | null | undefined)?.trim() || null;
  const contact = (body.contact as string | null | undefined)?.trim() || null;
  if (detail !== null && detail.length > 2_000) {
    return { ok: false, error: "detail_invalid" };
  }
  if (contact !== null && contact.length > 200) {
    return { ok: false, error: "contact_invalid" };
  }
  return {
    ok: true,
    value: {
      submissionId: body.submissionId.toLowerCase(),
      targetId: body.targetId.toLowerCase(),
      reason: body.reason as ContentReportReason,
      detail,
      contact,
    },
  };
}

export type ContentReportSubmission =
  | { kind: "already_removed"; duplicate: boolean }
  | {
      kind: "inserted";
      reportId: string;
      wasFirst: boolean;
      duplicate: boolean;
    };

/** DB RPC 응답의 모든 필드를 검증해 null/malformed false-success를 막는다. */
export function parseContentReportSubmission(
  data: unknown,
): ContentReportSubmission | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const value = data as Record<string, unknown>;
  if (
    value.ok !== true ||
    typeof value.inserted !== "boolean" ||
    typeof value.duplicate !== "boolean"
  ) {
    return null;
  }
  if (value.inserted === false) {
    return value.already_removed === true &&
      value.was_first === false &&
      value.report_id === null
      ? { kind: "already_removed", duplicate: value.duplicate }
      : null;
  }
  if (
    typeof value.report_id !== "string" ||
    !UUID_RE.test(value.report_id) ||
    typeof value.was_first !== "boolean" ||
    value.already_removed !== false
  ) {
    return null;
  }
  return {
    kind: "inserted",
    reportId: value.report_id,
    wasFirst: value.was_first,
    duplicate: value.duplicate,
  };
}

export type ContentReportHttpAck = {
  ok: true;
  duplicate: boolean;
  alreadyRemoved: boolean;
};

export function parseContentReportHttpAck(
  data: unknown,
): ContentReportHttpAck | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.ok !== true || typeof value.duplicate !== "boolean") return null;
  if (value.already_removed === undefined) {
    return {
      ok: true,
      duplicate: value.duplicate,
      alreadyRemoved: false,
    };
  }
  return value.already_removed === true
    ? {
        ok: true,
        duplicate: value.duplicate,
        alreadyRemoved: true,
      }
    : null;
}

export type ContentReportRpcError =
  | "target_not_found"
  | "submission_conflict"
  | "rate_limited"
  | "quota_busy";

export function contentReportRpcErrorCode(
  error: unknown,
): ContentReportRpcError | null {
  if (error === null || typeof error !== "object") return null;
  const e = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  if (e.code !== "P0001") return null;
  for (const code of [
    "target_not_found",
    "submission_conflict",
    "rate_limited",
    "quota_busy",
  ] as const) {
    if (
      [e.message, e.details, e.hint].some(
        (value) =>
          typeof value === "string" &&
          (code === "quota_busy"
            ? value.includes("report_write_quota_busy")
            : new RegExp(`(^|[^a-z_])${code}([^a-z_]|$)`, "i").test(value)),
      )
    ) {
      return code;
    }
  }
  return null;
}

export function isContentReportTargetNotFound(error: unknown): boolean {
  return contentReportRpcErrorCode(error) === "target_not_found";
}
