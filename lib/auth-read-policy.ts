import type {
  ConsentItem,
  ConsentMember,
  LegalVersions,
} from "@/lib/consent";
import { isAuthSessionMissingError } from "@supabase/supabase-js";

/**
 * Supabase/PostgREST read 결과의 최소 계약.
 * SDK는 DB 실패를 reject 대신 `{ error }`로 resolve할 수 있으므로 data만 보면 안 된다.
 */
export type DbReadResult<T> = {
  data: T | null;
  error: unknown | null;
};

export type AuthReadSource = "auth" | "profile" | "member" | "legal";

const INVALID_SESSION_CODES = new Set([
  "bad_jwt",
  "invalid_jwt",
  "session_not_found",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "user_banned",
  "user_not_found",
]);

export type StrictAuthUserRead<T> =
  | { ok: true; user: T }
  | { ok: false; kind: "unauthorized"; error: unknown | null }
  | { ok: false; kind: "unavailable"; error: unknown };

/** Only explicit missing/invalid-session errors are client 401s. */
export function isInvalidSessionReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const shape = error as {
    name?: unknown;
    code?: unknown;
    error_code?: unknown;
    status?: unknown;
  };
  if (shape.status !== undefined) {
    if (
      typeof shape.status !== "number" ||
      !Number.isSafeInteger(shape.status) ||
      shape.status < 400 ||
      shape.status >= 500 ||
      shape.status === 408 ||
      shape.status === 425 ||
      shape.status === 429
    ) {
      return false;
    }
  }
  if (isAuthSessionMissingError(error)) return true;
  if (shape.name === "AuthInvalidJwtError") return true;
  return [shape.code, shape.error_code].some(
    (code) =>
      typeof code === "string" &&
      INVALID_SESSION_CODES.has(code),
  );
}

/**
 * auth.getUser resolves transport/service faults in `{ error }`; they must not
 * be collapsed into a logged-out state. A successful null user is no session.
 */
export function resolveAuthUserRead<T>(result: {
  data: { user: T | null };
  error: unknown | null;
}): StrictAuthUserRead<T> {
  if (result.error != null) {
    return isInvalidSessionReadError(result.error)
      ? { ok: false, kind: "unauthorized", error: result.error }
      : { ok: false, kind: "unavailable", error: result.error };
  }
  if (result.data.user === null) {
    return { ok: false, kind: "unauthorized", error: null };
  }
  return { ok: true, user: result.data.user };
}

export type StrictRead<T> =
  | { ok: true; data: T | null }
  | { ok: false; source: AuthReadSource; error: unknown };

/** 성공한 no-row(`data:null`)와 실제 DB 오류(`error`)를 구분한다. */
export function resolveDbRead<T>(
  source: AuthReadSource,
  result: DbReadResult<T>,
): StrictRead<T> {
  if (result.error != null) {
    return { ok: false, source, error: result.error };
  }
  return { ok: true, data: result.data };
}

export type StrictRequiredRead<T> =
  | { ok: true; data: T }
  | { ok: false; source: AuthReadSource; error: unknown };

/** profiles처럼 반드시 존재해야 하는 row는 성공+no-row도 불변식 실패로 차단한다. */
export function resolveRequiredDbRead<T>(
  source: AuthReadSource,
  result: DbReadResult<T>,
): StrictRequiredRead<T> {
  const read = resolveDbRead(source, result);
  if (!read.ok) return read;
  if (read.data === null) {
    return {
      ok: false,
      source,
      error: new Error(`${source}_row_missing`),
    };
  }
  return { ok: true, data: read.data };
}

export type StrictAdminAuthorityRead =
  | { ok: true; isAdmin: boolean }
  | { ok: false; source: "member"; error: unknown };

/**
 * `requireMember` already proved that the membership row exists. The second
 * authority read must therefore distinguish a real `false` flag from a
 * resolved dependency error, a vanished row, or a malformed PostgREST value.
 */
export function resolveAdminAuthorityRead(
  result: DbReadResult<{ is_admin?: unknown }>,
): StrictAdminAuthorityRead {
  const read = resolveRequiredDbRead("member", result);
  if (!read.ok) {
    return { ok: false, source: "member", error: read.error };
  }
  if (typeof read.data.is_admin !== "boolean") {
    return {
      ok: false,
      source: "member",
      error: new Error("invalid_admin_authority_response"),
    };
  }
  return { ok: true, isAdmin: read.data.is_admin };
}

export type LegalVersionRow = {
  doc_type: string;
  version: number;
};

export type StrictLegalVersions =
  | { ok: true; data: LegalVersions }
  | { ok: false; source: "legal"; error: unknown };

/**
 * effective_date/version 내림차순으로 읽은 발행본에서 문서별 첫 행을 현재 버전으로 투영한다.
 * 성공+빈 결과는 "발행본 없음"이라 null 버전이고, `{ error }`/손상 버전은 fail-closed다.
 */
export function resolveLegalVersionsRead(
  result: DbReadResult<LegalVersionRow[]>,
): StrictLegalVersions {
  const read = resolveDbRead("legal", result);
  if (!read.ok) {
    return { ok: false, source: "legal", error: read.error };
  }
  if (!Array.isArray(read.data)) {
    return {
      ok: false,
      source: "legal",
      error: new Error("invalid_legal_versions_response"),
    };
  }

  let terms: number | null = null;
  let privacy: number | null = null;
  for (const row of read.data) {
    if (
      typeof row !== "object" ||
      row === null ||
      (row.doc_type !== "terms" && row.doc_type !== "privacy")
    ) {
      return {
        ok: false,
        source: "legal",
        error: new Error("invalid_legal_version_document_type"),
      };
    }
    if (!Number.isSafeInteger(row.version) || row.version <= 0) {
      return {
        ok: false,
        source: "legal",
        error: new Error("invalid_legal_version"),
      };
    }
    if (row.doc_type === "terms" && terms === null) terms = row.version;
    if (row.doc_type === "privacy" && privacy === null) privacy = row.version;
  }
  return { ok: true, data: { terms, privacy } };
}

export type ConsentLegalDocumentShape = {
  doc_type: string;
  status: string;
  version: number;
  effective_date: string | null;
  title: string;
  sections: unknown;
};

function validLegalSections(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      (section) =>
        typeof section === "object" &&
        section !== null &&
        typeof (section as { heading?: unknown }).heading === "string" &&
        (section as { heading: string }).heading.trim().length > 0 &&
        typeof (section as { body?: unknown }).body === "string" &&
        (section as { body: string }).body.trim().length > 0,
    )
  );
}

/**
 * 동의 UI에 표시할 전문은 현재 버전 조회와 같은 doc/version이어야 한다.
 * 성공한 no-row, publish 경합으로 인한 버전 불일치, 손상된 표시 데이터도 읽지 않은 채 동의하는
 * 상태가 되지 않도록 모두 legal read 실패로 승격한다.
 */
export function resolveCurrentLegalDocumentRead<
  T extends ConsentLegalDocumentShape,
>(
  docType: "terms" | "privacy",
  expectedVersion: number,
  result: DbReadResult<T>,
): StrictRequiredRead<T> {
  const read = resolveRequiredDbRead("legal", result);
  if (!read.ok) return read;
  const doc = read.data;
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion <= 0 ||
    doc.doc_type !== docType ||
    doc.status !== "published" ||
    doc.version !== expectedVersion ||
    typeof doc.effective_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(doc.effective_date) ||
    typeof doc.title !== "string" ||
    doc.title.trim().length === 0 ||
    !validLegalSections(doc.sections)
  ) {
    return {
      ok: false,
      source: "legal",
      error: new Error("legal_document_missing_changed_or_invalid"),
    };
  }
  return { ok: true, data: doc };
}

export type AnonMigrationResult = "migrated" | "skipped" | "failed";

export type AnonMigrationPreparation =
  | {
      ok: true;
      attempted: boolean;
      result: "not_applicable" | Exclude<AnonMigrationResult, "failed">;
    }
  | { ok: false; attempted: true; result: "failed"; error?: unknown };

/**
 * 익명 데이터 이전은 strict member read가 no-row인 신규 후보에서 member INSERT 전에 수행한다.
 * 다만 flow ledger가 아직 미종결이면 concurrent member 생성 뒤의 재시도에서도 callback을 실행해
 * exact no-transfer receipt를 먼저 확정한다. 이 경로는 기존 member 소유권을 병합하지 않는다.
 */
export async function prepareAnonMigration(
  member: ConsentMember,
  migrate: () => Promise<AnonMigrationResult>,
  flowRequiresConvergence = false,
): Promise<AnonMigrationPreparation> {
  if (member !== null && !flowRequiresConvergence) {
    return { ok: true, attempted: false, result: "not_applicable" };
  }
  try {
    const result = await migrate();
    if (result === "failed") {
      return { ok: false, attempted: true, result };
    }
    return { ok: true, attempted: true, result };
  } catch (error) {
    return { ok: false, attempted: true, result: "failed", error };
  }
}

export type ConsentMutationResolution =
  | { ok: true; isNew: boolean }
  | { ok: false; error: unknown };

/**
 * The consent RPC returns an exact boolean (`true` new member, `false`
 * existing member). PostgREST can resolve a transport/database failure in
 * `{ error }`, reject, or return a malformed/null payload, none of which proves
 * that the legal stamps committed.
 */
export async function resolveConsentMutation(
  mutate: () => PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<ConsentMutationResolution> {
  try {
    const result = await mutate();
    if (result.error != null) return { ok: false, error: result.error };
    if (typeof result.data !== "boolean") {
      return {
        ok: false,
        error: new Error("invalid_consent_mutation_response"),
      };
    }
    return { ok: true, isNew: result.data };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Required legal stamps must be exactly the documents rendered to the user. */
export function displayedLegalVersionsMatch(
  required: readonly ConsentItem[],
  current: LegalVersions,
  displayed: { terms?: unknown; privacy?: unknown },
): boolean {
  for (const item of ["terms", "privacy"] as const) {
    if (
      required.includes(item) &&
      (!Number.isSafeInteger(displayed[item]) ||
        displayed[item] !== current[item])
    ) {
      return false;
    }
  }
  return true;
}
