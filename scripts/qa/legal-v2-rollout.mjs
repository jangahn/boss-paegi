#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { LEGAL_V2 } from "../../legal/v2-documents.mjs";
import { LEGAL_V1_PRODUCTION_SNAPSHOT } from "../../legal/v1-production-snapshot.mjs";

const API_HOST = "https://api.supabase.com";
const MAX_MANAGEMENT_BODY_BYTES = 2 * 1024 * 1024;
const DOC_TYPES = Object.freeze(["privacy", "terms"]);
const STAGE_CONFIRM = "STAGE-BOSS-PAEGI-LEGAL-V2";
const REPLACE_STAGE_CONFIRM =
  "REPLACE-DRAFT-AND-STAGE-BOSS-PAEGI-LEGAL-V2";
const PUBLISH_CONFIRM = "PUBLISH-BOSS-PAEGI-LEGAL-V2";
const CANCEL_CONFIRM = "CANCEL-BOSS-PAEGI-LEGAL-V2";
// Supabase project refs are public deployment identifiers, not credentials.
// Binding the Management API target to the KB-approved production ref prevents
// a same-shaped dummy project from satisfying only the business-data checks.
const APPROVED_PRODUCTION_PROJECT_REF = "jxnzolkmeqjvrnzikcmb";
const REQUIRED_MIGRATIONS = Object.freeze([
  "0081_legal_state_machine_idempotency",
  "008904_privacy_retention_controls",
  "008905_legal_commerce_generation_compliance",
]);
const STRICT_RPCS = Object.freeze([
  Object.freeze({
    slot: "save",
    signature:
      "public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)",
    startMarker: "-- ── Strict save overload",
    endMarker: "-- ── Strict publish overload",
  }),
  Object.freeze({
    slot: "publish",
    signature:
      "public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)",
    startMarker: "-- ── Strict publish overload",
    endMarker: "-- ── Strict unpublish overload",
  }),
  Object.freeze({
    slot: "unpublish",
    signature:
      "public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)",
    startMarker: "-- ── Strict unpublish overload",
    endMarker: "-- ── Rolling-deploy legacy wrappers",
  }),
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function civilDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() + 1 === month &&
    instant.getUTCDate() === day
  );
}

/** @param {Date | number | string} [instant] */
export function kstDateAt(instant = new Date()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new RangeError("invalid_instant");
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) throw new Error("kst_date_format_failed");
  return `${year}-${month}-${day}`;
}

export function validateFutureEffectiveDate(effectiveDate, todayKst) {
  return civilDate(effectiveDate) && civilDate(todayKst) && effectiveDate > todayKst;
}

function civilDayNumber(value) {
  if (!civilDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function noticeCalendarDays(effectiveDate, noticeDateKst) {
  const effective = civilDayNumber(effectiveDate);
  const notice = civilDayNumber(noticeDateKst);
  return effective === null || notice === null ? null : effective - notice;
}

export function validateNoticePeriod(
  effectiveDate,
  noticeDateKst,
  minimumDays = LEGAL_V2.rollout.minimumNoticeKstCalendarDays,
) {
  const days = noticeCalendarDays(effectiveDate, noticeDateKst);
  return Number.isSafeInteger(minimumDays) && minimumDays >= 1
    ? days !== null && days >= minimumDays
    : false;
}

export function validateFullNoticePeriod(
  effectiveDate,
  noticeInstant,
  minimumDays = LEGAL_V2.rollout.minimumNoticeKstCalendarDays,
) {
  if (
    !civilDate(effectiveDate) ||
    !Number.isSafeInteger(minimumDays) ||
    minimumDays < 1
  ) {
    return false;
  }
  const notice =
    noticeInstant instanceof Date
      ? noticeInstant.getTime()
      : new Date(noticeInstant).getTime();
  const effectiveMidnight = Date.parse(
    `${effectiveDate}T00:00:00+09:00`,
  );
  return (
    Number.isFinite(notice) &&
    Number.isFinite(effectiveMidnight) &&
    effectiveMidnight - notice >= minimumDays * 86_400_000
  );
}

export function parseLegalV2Args(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, reason: "invalid_arguments" };
  }
  const value = {
    mode: "dry-run",
    apply: false,
    confirm: null,
    effectiveDate: null,
    adminEmail: LEGAL_V2.operator.adminEmail,
    replaceExistingDraft: false,
  };
  const seen = new Set();
  const take = (name, index) => {
    if (seen.has(name) || index + 1 >= argv.length) return null;
    seen.add(name);
    return argv[index + 1];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      const candidate = take("mode", index);
      if (
        candidate !== "dry-run" &&
        candidate !== "stage" &&
        candidate !== "publish" &&
        candidate !== "cancel"
      ) {
        return { ok: false, reason: "invalid_mode" };
      }
      value.mode = candidate;
      index += 1;
    } else if (arg === "--effective-date") {
      const candidate = take("effective-date", index);
      if (!civilDate(candidate)) {
        return { ok: false, reason: "effective_date_invalid" };
      }
      value.effectiveDate = candidate;
      index += 1;
    } else if (arg === "--admin-email") {
      const candidate = take("admin-email", index);
      if (typeof candidate !== "string" || !EMAIL_RE.test(candidate)) {
        return { ok: false, reason: "admin_email_invalid" };
      }
      value.adminEmail = candidate;
      index += 1;
    } else if (arg === "--confirm") {
      const candidate = take("confirm", index);
      if (typeof candidate !== "string" || candidate.length === 0) {
        return { ok: false, reason: "confirmation_invalid" };
      }
      value.confirm = candidate;
      index += 1;
    } else if (arg === "--apply" && !seen.has("apply")) {
      seen.add("apply");
      value.apply = true;
    } else if (
      arg === "--replace-existing-draft" &&
      !seen.has("replace-existing-draft")
    ) {
      seen.add("replace-existing-draft");
      value.replaceExistingDraft = true;
    } else {
      return { ok: false, reason: "unsupported_or_duplicate_argument" };
    }
  }

  if (value.mode === "dry-run") {
    if (
      value.apply ||
      value.confirm !== null ||
      value.replaceExistingDraft
    ) {
      return { ok: false, reason: "dry_run_must_be_read_only" };
    }
  } else if (!value.apply) {
    return { ok: false, reason: "apply_required" };
  } else if (value.mode === "stage") {
    if (value.effectiveDate !== null) {
      return { ok: false, reason: "stage_does_not_accept_effective_date" };
    }
    const expected = value.replaceExistingDraft
      ? REPLACE_STAGE_CONFIRM
      : STAGE_CONFIRM;
    if (value.confirm !== expected) {
      return { ok: false, reason: "stage_confirmation_mismatch" };
    }
  } else if (value.mode === "publish") {
    if (value.replaceExistingDraft) {
      return { ok: false, reason: "publish_cannot_replace_draft" };
    }
    if (value.effectiveDate === null) {
      return { ok: false, reason: "effective_date_required" };
    }
    if (value.confirm !== PUBLISH_CONFIRM) {
      return { ok: false, reason: "publish_confirmation_mismatch" };
    }
  } else {
    if (value.replaceExistingDraft) {
      return { ok: false, reason: "cancel_cannot_replace_draft" };
    }
    if (value.effectiveDate === null) {
      return { ok: false, reason: "effective_date_required" };
    }
    if (value.confirm !== CANCEL_CONFIRM) {
      return { ok: false, reason: "cancel_confirmation_mismatch" };
    }
  }
  return { ok: true, value };
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const row = value;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`)
    .join(",")}}`;
}

export function canonicalDigest(source = LEGAL_V2) {
  return createHash("sha256").update(stableStringify(source), "utf8").digest("hex");
}

function operationUuid(seed) {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(
    13,
    16,
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function characterLength(value) {
  return [...value].length;
}

export function validateLegalV2Source(source = LEGAL_V2) {
  const root = exactObject(source);
  if (
    !root ||
    root.schemaVersion !== 2 ||
    root.expectedPreviousVersion !== 1 ||
    root.targetVersion !== 2 ||
    !civilDate(root.sourceAsOf)
  ) {
    throw new Error("canonical_metadata_invalid");
  }
  const rollout = exactObject(root.rollout);
  if (
    !rollout ||
    rollout.classification !== "material_adverse" ||
    rollout.minimumNoticeKstCalendarDays !==
      LEGAL_V1_PRODUCTION_SNAPSHOT.noticeRights
        .adverseOrMaterialMinimumKstCalendarDays ||
    !Array.isArray(rollout.publicationBlockers) ||
    rollout.publicationBlockers.some(
      (item) =>
        typeof item !== "string" ||
        !/^[a-z0-9_]+$/.test(item) ||
        item.length > 120,
    ) ||
    new Set(rollout.publicationBlockers).size !==
      rollout.publicationBlockers.length
  ) {
    throw new Error("canonical_rollout_contract_invalid");
  }
  const operator = exactObject(root.operator);
  if (
    !operator ||
    operator.companyName !== "제이엔에이" ||
    operator.ownerName !== "안병욱" ||
    operator.adminEmail !== "emfoa23@gmail.com" ||
    operator.privacyEmail !== "dev.jangahn@gmail.com" ||
    operator.bizRegNo !== "220-11-70445"
  ) {
    throw new Error("canonical_operator_invalid");
  }
  const documents = exactObject(root.documents);
  if (
    !documents ||
    stableStringify(Object.keys(documents).sort()) !==
      stableStringify([...DOC_TYPES].sort())
  ) {
    throw new Error("canonical_document_set_invalid");
  }

  for (const docType of DOC_TYPES) {
    const document = exactObject(documents[docType]);
    if (
      !document ||
      document.docType !== docType ||
      typeof document.title !== "string" ||
      characterLength(document.title.trim()) < 1 ||
      characterLength(document.title.trim()) > 200 ||
      typeof document.publicNote !== "string" ||
      characterLength(document.publicNote) > 1000 ||
      typeof document.adminNote !== "string" ||
      characterLength(document.adminNote) > 2000 ||
      !Array.isArray(document.sections) ||
      document.sections.length < 1 ||
      document.sections.length > 50
    ) {
      throw new Error(`canonical_${docType}_shape_invalid`);
    }
    const headings = new Set();
    for (const sectionValue of document.sections) {
      const section = exactObject(sectionValue);
      if (
        !section ||
        Object.keys(section).sort().join(",") !== "body,heading" ||
        typeof section.heading !== "string" ||
        typeof section.body !== "string" ||
        characterLength(section.heading.trim()) < 1 ||
        characterLength(section.heading.trim()) > 120 ||
        characterLength(section.body.trim()) < 1 ||
        characterLength(section.body.trim()) > 20_000 ||
        headings.has(section.heading)
      ) {
        throw new Error(`canonical_${docType}_section_invalid`);
      }
      headings.add(section.heading);
    }
    if (
      Buffer.byteLength(JSON.stringify(document.sections), "utf8") > 200_000
    ) {
      throw new Error(`canonical_${docType}_sections_too_large`);
    }
  }
  return source;
}

export function documentsMatch(
  rowValue,
  document,
  { includeAdminNote = false } = {},
) {
  const row = exactObject(rowValue);
  return Boolean(
    row &&
      row.title === document.title &&
      stableStringify(row.sections) === stableStringify(document.sections) &&
      (row.public_note ?? null) === document.publicNote &&
      (!includeAdminNote ||
        (row.admin_note ?? null) === document.adminNote),
  );
}

function readManagementEnvironment(env = process.env) {
  const token = env.BOSS_PAEGI_SUPABASE_ACCESS_TOKEN;
  const ref = env.BOSS_PAEGI_SUPABASE_PROJECT_REF;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("management_access_token_missing");
  }
  if (ref !== APPROVED_PRODUCTION_PROJECT_REF) {
    throw new Error("management_project_ref_not_approved_production");
  }
  return { token, ref };
}

async function readBoundedJson(response, maxBytes) {
  if (!response?.body || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("management_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("management_response_invalid");
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("management_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("management_response_json_invalid");
  }
}

async function managementQuery(sql, management, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(
      `${API_HOST}/v1/projects/${encodeURIComponent(
        management.ref,
      )}/database/query`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${management.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error("management_request_failed");
  }
  if (!response.ok) {
    throw new Error(`management_request_failed_${response.status}`);
  }
  return readBoundedJson(response, MAX_MANAGEMENT_BODY_BYTES);
}

function sqlLiteral(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("sql_literal_invalid");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullableTimestamp(value) {
  if (value === null) return "null::timestamptz";
  if (
    typeof value !== "string" ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error("draft_timestamp_invalid");
  }
  return `${sqlLiteral(value)}::timestamptz`;
}

function normalizeLegalRows(value) {
  if (!Array.isArray(value)) throw new Error("legal_rows_invalid");
  return value.map((rowValue) => {
    const row = exactObject(rowValue);
    if (
      !row ||
      !UUID_RE.test(String(row.id ?? "")) ||
      !DOC_TYPES.includes(row.doc_type) ||
      (row.status !== "draft" && row.status !== "published") ||
      !Number.isSafeInteger(row.version) ||
      row.version < 0 ||
      (row.status === "draft" && row.version !== 0) ||
      (row.status === "published" && row.version < 1) ||
      (row.effective_date !== null && !civilDate(row.effective_date)) ||
      typeof row.title !== "string" ||
      !Array.isArray(row.sections) ||
      (row.public_note !== null && typeof row.public_note !== "string") ||
      (row.admin_note !== null && typeof row.admin_note !== "string") ||
      typeof row.updated_at !== "string" ||
      !Number.isFinite(new Date(row.updated_at).getTime()) ||
      (row.version === LEGAL_V2.expectedPreviousVersion &&
        !/^[0-9a-f]{64}$/.test(String(row.normalized_v1_sha256 ?? "")))
    ) {
      throw new Error("legal_row_invalid");
    }
    return row;
  });
}

export function expectedStrictRpcSourceHashes() {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/0081_legal_state_machine_idempotency.sql",
      import.meta.url,
    ),
    "utf8",
  );
  return Object.fromEntries(
    STRICT_RPCS.map((contract) => {
      const start = migration.indexOf(contract.startMarker);
      const end = migration.indexOf(contract.endMarker);
      if (start < 0 || end <= start) {
        throw new Error("strict_rpc_source_contract_missing");
      }
      const segment = migration.slice(start, end);
      const body = /\bas \$\$([\s\S]*?)\$\$;/.exec(segment)?.[1];
      if (body === undefined) {
        throw new Error("strict_rpc_source_contract_missing");
      }
      return [
        contract.slot,
        createHash("sha256").update(body, "utf8").digest("hex"),
      ];
    }),
  );
}

function strictRpcFingerprintSql() {
  const values = STRICT_RPCS.map(
    ({ slot, signature }) =>
      `(${sqlLiteral(slot)}::text, ${sqlLiteral(signature)}::text)`,
  ).join(",\n      ");
  return `(
    with expected(slot, signature) as (
      values
      ${values}
    )
    select jsonb_object_agg(
      expected.slot,
      jsonb_build_object(
        'exists', p.oid is not null,
        'owner', pg_catalog.pg_get_userbyid(p.proowner),
        'security_definer', p.prosecdef,
        'empty_search_path',
          coalesce(
            p.proconfig @> array['search_path=""']::text[],
            false
          ),
        'source_sha256',
          case
            when p.oid is null then null
            else pg_catalog.encode(
              extensions.digest(
                pg_catalog.convert_to(p.prosrc, 'UTF8'),
                'sha256'
              ),
              'hex'
            )
          end,
        'service_execute',
          coalesce(
            pg_catalog.has_function_privilege(
              'service_role',
              p.oid,
              'EXECUTE'
            ),
            false
          ),
        'anon_execute',
          coalesce(
            pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'),
            false
          ),
        'authenticated_execute',
          coalesce(
            pg_catalog.has_function_privilege(
              'authenticated',
              p.oid,
              'EXECUTE'
            ),
            false
          ),
        'public_execute',
          coalesce(
            exists (
              select 1
                from pg_catalog.aclexplode(
                  coalesce(
                    p.proacl,
                    pg_catalog.acldefault('f', p.proowner)
                  )
                ) acl
               where acl.grantee = 0
                 and acl.privilege_type = 'EXECUTE'
            ),
            false
          )
      )
      order by expected.slot
    )
      from expected
      left join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(expected.signature)
  )`;
}

async function readProductionState(management, adminEmail, fetchImpl = fetch) {
  const strictRpcSql = strictRpcFingerprintSql();
  const requiredMigrationsSql = REQUIRED_MIGRATIONS.map(sqlLiteral).join(", ");
  const fingerprintSql = `
select
  to_regprocedure(
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)'
  ) is not null
  and to_regprocedure(
    'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)'
  ) is not null
  and to_regprocedure(
    'public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)'
  ) is not null
  and to_regclass('public.legal_operation_receipts') is not null
    as strict_legal_rpc_ready,
  ${strictRpcSql} as strict_rpc_contracts,
  array(
    select j.version
      from public.schema_migration_journal j
     where j.version in (${requiredMigrationsSql})
     order by j.version
  ) as migration_versions,
  (
    select count(*)::int
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
     where m.email = ${sqlLiteral(adminEmail)}
       and m.is_admin = true
       and p.deleted_at is null
  ) as admin_count,
  (
    select m.user_id::text
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
     where m.email = ${sqlLiteral(adminEmail)}
       and m.is_admin = true
       and p.deleted_at is null
     order by m.user_id
     limit 1
  ) as admin_user_id,
  (
    select value
      from public.app_settings
     where key = 'business_info'
  ) as business_info
`;
  const rowsSql = `
select
  id,
  doc_type,
  status,
  version,
  effective_date,
  title,
  sections,
  public_note,
  admin_note,
  updated_at,
  case
    when version = ${LEGAL_V2.expectedPreviousVersion} then
      pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            pg_catalog.jsonb_build_object(
              'docType', doc_type,
              'version', version,
              'effectiveDate', effective_date,
              'title', title,
              'sections', sections,
              'publicNote', public_note
            )::text,
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
    else null
  end as normalized_v1_sha256
from public.legal_documents
where doc_type in ('privacy', 'terms')
order by doc_type, version desc, id desc
`;
  const [fingerprintRows, legalRows] = await Promise.all([
    managementQuery(fingerprintSql, management, fetchImpl),
    managementQuery(rowsSql, management, fetchImpl),
  ]);
  if (
    !Array.isArray(fingerprintRows) ||
    fingerprintRows.length !== 1
  ) {
    throw new Error("production_fingerprint_invalid");
  }
  const fingerprint = exactObject(fingerprintRows[0]);
  if (!fingerprint) throw new Error("production_fingerprint_invalid");
  return {
    fingerprint,
    rows: normalizeLegalRows(legalRows),
  };
}

function verifyProductionFingerprint(state) {
  const { fingerprint } = state;
  const business = exactObject(fingerprint.business_info);
  const info = exactObject(business?.info);
  const rpcContracts = exactObject(fingerprint.strict_rpc_contracts);
  const expectedHashes = expectedStrictRpcSourceHashes();
  const migrations = Array.isArray(fingerprint.migration_versions)
    ? fingerprint.migration_versions
    : [];
  const rpcReady =
    rpcContracts &&
    STRICT_RPCS.every(({ slot }) => {
      const contract = exactObject(rpcContracts[slot]);
      return (
        contract?.exists === true &&
        contract.owner === "postgres" &&
        contract.security_definer === true &&
        contract.empty_search_path === true &&
        contract.source_sha256 === expectedHashes[slot] &&
        contract.service_execute === true &&
        contract.anon_execute === false &&
        contract.authenticated_execute === false &&
        contract.public_execute === false
      );
    });
  if (
    fingerprint.strict_legal_rpc_ready !== true ||
    !rpcReady ||
    stableStringify([...migrations].sort()) !==
      stableStringify([...REQUIRED_MIGRATIONS].sort()) ||
    fingerprint.admin_count !== 1 ||
    !UUID_RE.test(String(fingerprint.admin_user_id ?? "")) ||
    !info ||
    info.companyName !== LEGAL_V2.operator.companyName ||
    info.ownerName !== LEGAL_V2.operator.ownerName ||
    info.bizRegNo !== LEGAL_V2.operator.bizRegNo
  ) {
    throw new Error("production_target_fingerprint_mismatch");
  }
}

export function verifyProductionV1Snapshot(state) {
  for (const docType of DOC_TYPES) {
    const rows = state.rows.filter(
      (row) =>
        row.doc_type === docType &&
        row.status === "published" &&
        row.version === LEGAL_V2.expectedPreviousVersion,
    );
    const expected = LEGAL_V1_PRODUCTION_SNAPSHOT.documents[docType];
    if (
      rows.length !== 1 ||
      rows[0].effective_date !==
        LEGAL_V1_PRODUCTION_SNAPSHOT.effectiveDate ||
      rows[0].sections.length !== expected.sectionCount ||
      rows[0].normalized_v1_sha256 !== expected.postgresJsonbSha256
    ) {
      throw new Error("production_v1_snapshot_mismatch");
    }
  }
}

function inspectDocumentState(state, docType, todayKst) {
  const document = LEGAL_V2.documents[docType];
  const rows = state.rows.filter((row) => row.doc_type === docType);
  const drafts = rows.filter((row) => row.status === "draft");
  const published = rows
    .filter((row) => row.status === "published")
    .sort((left, right) => right.version - left.version);
  if (drafts.length > 1) throw new Error(`${docType}_multiple_drafts`);
  if (published.length === 0) {
    throw new Error(`${docType}_published_v1_missing`);
  }
  if (
    published.some(
      (row) =>
        row.version > LEGAL_V2.targetVersion ||
        (row.version === LEGAL_V2.targetVersion &&
          !documentsMatch(row, document)),
    )
  ) {
    throw new Error(`${docType}_unexpected_legal_history`);
  }
  const targetRows = published.filter(
    (row) => row.version === LEGAL_V2.targetVersion,
  );
  if (targetRows.length > 1) {
    throw new Error(`${docType}_duplicate_v2`);
  }
  const futureRows = published.filter(
    (row) =>
      typeof row.effective_date === "string" &&
      row.effective_date > todayKst,
  );
  if (
    futureRows.some(
      (row) =>
        row.version !== LEGAL_V2.targetVersion ||
        !documentsMatch(row, document),
    )
  ) {
    throw new Error(`${docType}_unrelated_reservation_exists`);
  }

  const target = targetRows[0] ?? null;
  if (target) {
    if (drafts.length !== 0) {
      throw new Error(`${docType}_post_v2_draft_exists`);
    }
    return {
      docType,
      document,
      draft: null,
      latest: published[0],
      target,
      done: true,
    };
  }
  const latest = published[0];
  if (latest.version !== LEGAL_V2.expectedPreviousVersion) {
    throw new Error(`${docType}_expected_v1_missing`);
  }
  return {
    docType,
    document,
    draft: drafts[0] ?? null,
    latest,
    target: null,
    done: false,
  };
}

function inspectState(state, todayKst) {
  return Object.fromEntries(
    DOC_TYPES.map((docType) => [
      docType,
      inspectDocumentState(state, docType, todayKst),
    ]),
  );
}

export function planStage(
  inspected,
  { replaceExistingDraft = false } = {},
) {
  const items = [];
  for (const docType of DOC_TYPES) {
    const item = inspected[docType];
    if (item.done) continue;
    if (
      item.draft &&
      documentsMatch(item.draft, item.document, { includeAdminNote: true })
    ) {
      continue;
    }
    if (item.draft && !replaceExistingDraft) {
      throw new Error(`${docType}_unrelated_draft_exists`);
    }
    items.push({
      ...item,
      baseUpdatedAt: item.draft?.updated_at ?? null,
    });
  }
  return items;
}

export function planPublish(
  inspected,
  effectiveDate,
  todayKst,
  {
    publicationBlockers = LEGAL_V2.rollout.publicationBlockers,
    minimumNoticeDays = LEGAL_V2.rollout.minimumNoticeKstCalendarDays,
    noticeInstant = new Date(Number.NaN),
  } = {},
) {
  if (!Array.isArray(publicationBlockers) || publicationBlockers.length > 0) {
    throw new Error("publication_blockers_unresolved");
  }
  if (
    !validateNoticePeriod(effectiveDate, todayKst, minimumNoticeDays) ||
    !validateFullNoticePeriod(
      effectiveDate,
      noticeInstant,
      minimumNoticeDays,
    )
  ) {
    throw new Error("effective_date_notice_period_too_short");
  }
  const items = [];
  const doneDates = new Set();
  for (const docType of DOC_TYPES) {
    const item = inspected[docType];
    if (item.done) {
      doneDates.add(item.target.effective_date);
      continue;
    }
    if (
      !item.draft ||
      !documentsMatch(item.draft, item.document, { includeAdminNote: true })
    ) {
      throw new Error(`${docType}_canonical_draft_missing`);
    }
    items.push(item);
  }
  if (items.length === 0) {
    if (
      doneDates.size !== 1 ||
      !doneDates.has(effectiveDate)
    ) {
      throw new Error("published_effective_date_mismatch");
    }
    return items;
  }
  if (
    doneDates.size > 1 ||
    (doneDates.size === 1 && !doneDates.has(effectiveDate))
  ) {
    throw new Error("partial_v2_effective_date_mismatch");
  }
  return items;
}

function adminCte(adminEmail) {
  return `admin as (
  select m.user_id
    from public.member_accounts m
    join public.profiles p on p.id = m.user_id
   where m.email = ${sqlLiteral(adminEmail)}
     and m.is_admin = true
     and p.deleted_at is null
   order by m.user_id
   limit 1
)`;
}

function buildAtomicOperationsSql(adminEmail, operations) {
  if (!Array.isArray(operations) || operations.length < 1) {
    throw new Error("operations_required");
  }
  const ctes = [adminCte(adminEmail)];
  const resultPairs = [];
  operations.forEach((operation, index) => {
    const name = `op_${index}`;
    const dependency =
      index === 0 ? "admin" : `admin cross join op_${index - 1}`;
    ctes.push(`${name} as (
  select ${operation.sql} as result
    from ${dependency}
)`);
    resultPairs.push(`${sqlLiteral(operation.docType)}, (select result from ${name})`);
  });
  return `with ${ctes.join(",\n")}
select jsonb_build_object(${resultPairs.join(", ")}) as result
`;
}

export function buildStageSql(items, adminEmail, digest = canonicalDigest()) {
  const operations = items.map((item) => {
    const operationId = operationUuid(
      `legal-v2|stage|${digest}|${item.docType}|${
        item.baseUpdatedAt ?? "null"
      }|${adminEmail}`,
    );
    return {
      docType: item.docType,
      sql: `public.admin_save_legal_draft(
    ${sqlLiteral(item.docType)}::text,
    ${sqlLiteral(item.document.title)}::text,
    ${sqlLiteral(JSON.stringify(item.document.sections))}::jsonb,
    ${sqlLiteral(item.document.publicNote)}::text,
    ${sqlLiteral(item.document.adminNote)}::text,
    admin.user_id,
    ${sqlLiteral(operationId)}::uuid,
    ${sqlNullableTimestamp(item.baseUpdatedAt)}
  )`,
    };
  });
  return buildAtomicOperationsSql(adminEmail, operations);
}

export function buildPublishSql(
  items,
  adminEmail,
  effectiveDate,
  digest = canonicalDigest(),
) {
  const operations = items.map((item) => {
    const operationId = operationUuid(
      `legal-v2|publish|${digest}|${item.docType}|${item.draft.id}|${item.draft.updated_at}|${effectiveDate}|${adminEmail}`,
    );
    return {
      docType: item.docType,
      sql: `public.admin_publish_legal(
    ${sqlLiteral(item.docType)}::text,
    ${sqlLiteral(effectiveDate)}::date,
    admin.user_id,
    ${sqlLiteral(operationId)}::uuid,
    ${sqlLiteral(item.draft.id)}::uuid,
    ${sqlLiteral(item.draft.updated_at)}::timestamptz
  )`,
    };
  });
  return buildAtomicOperationsSql(adminEmail, operations);
}

export function cancelOperationIds(
  adminEmail,
  effectiveDate,
  digest = canonicalDigest(),
) {
  return Object.fromEntries(
    DOC_TYPES.map((docType) => [
      docType,
      operationUuid(
        `legal-v2|cancel|${digest}|${docType}|${effectiveDate}|${adminEmail}`,
      ),
    ]),
  );
}

async function readCancelReceipts(
  management,
  adminEmail,
  effectiveDate,
  digest,
  fetchImpl = fetch,
) {
  const ids = cancelOperationIds(adminEmail, effectiveDate, digest);
  const sql = `
select
  operation_id,
  doc_type,
  action,
  request_payload,
  response,
  admin_user_id
from public.legal_operation_receipts
where operation_id in (
  ${DOC_TYPES.map((docType) => `${sqlLiteral(ids[docType])}::uuid`).join(",\n  ")}
)
order by doc_type
`;
  const rows = await managementQuery(sql, management, fetchImpl);
  if (!Array.isArray(rows)) throw new Error("cancel_receipts_invalid");
  const receipts = {};
  for (const rowValue of rows) {
    const row = exactObject(rowValue);
    const request = exactObject(row?.request_payload);
    const response = exactObject(row?.response);
    if (
      !row ||
      !DOC_TYPES.includes(row.doc_type) ||
      row.operation_id !== ids[row.doc_type] ||
      row.action !== "unpublish" ||
      !UUID_RE.test(String(row.admin_user_id ?? "")) ||
      !request ||
      !UUID_RE.test(String(request.expected_reservation_id ?? "")) ||
      !Number.isSafeInteger(request.expected_reservation_version) ||
      request.expected_reservation_version !== LEGAL_V2.targetVersion ||
      !response ||
      response.ok !== true ||
      response.version !== LEGAL_V2.targetVersion ||
      typeof response.restored_draft !== "boolean" ||
      receipts[row.doc_type]
    ) {
      throw new Error("cancel_receipts_invalid");
    }
    receipts[row.doc_type] = row;
  }
  return receipts;
}

export function planCancel(
  inspected,
  effectiveDate,
  todayKst,
  receipts = {},
) {
  if (
    !civilDate(effectiveDate) ||
    !civilDate(todayKst) ||
    effectiveDate <= todayKst
  ) {
    throw new Error("reservation_no_longer_cancelable");
  }
  const items = [];
  let alreadyCanceled = 0;
  for (const docType of DOC_TYPES) {
    const item = inspected[docType];
    if (item.done) {
      if (
        item.target.version !== LEGAL_V2.targetVersion ||
        item.target.effective_date !== effectiveDate ||
        item.target.effective_date <= todayKst ||
        !documentsMatch(item.target, item.document)
      ) {
        throw new Error(`${docType}_cancel_target_mismatch`);
      }
      items.push({
        ...item,
        expectedReservationId: item.target.id,
        expectedReservationVersion: item.target.version,
        alreadyCanceled: false,
      });
      continue;
    }
    if (
      !item.draft ||
      !documentsMatch(item.draft, item.document, { includeAdminNote: true })
    ) {
      throw new Error(`${docType}_cancel_poststate_missing`);
    }
    const receipt = exactObject(receipts[docType]);
    const request = exactObject(receipt?.request_payload);
    if (
      !receipt ||
      !request ||
      receipt.doc_type !== docType ||
      receipt.action !== "unpublish" ||
      !UUID_RE.test(String(request.expected_reservation_id ?? "")) ||
      request.expected_reservation_version !== LEGAL_V2.targetVersion
    ) {
      throw new Error("cancel_split_brain_without_receipt");
    }
    alreadyCanceled += 1;
    items.push({
      ...item,
      expectedReservationId: request.expected_reservation_id,
      expectedReservationVersion: request.expected_reservation_version,
      alreadyCanceled: true,
    });
  }
  return alreadyCanceled === DOC_TYPES.length ? [] : items;
}

export function buildCancelSql(
  items,
  adminEmail,
  effectiveDate,
  digest = canonicalDigest(),
) {
  if (!Array.isArray(items) || items.length !== DOC_TYPES.length) {
    throw new Error("cancel_requires_both_documents");
  }
  const ids = cancelOperationIds(adminEmail, effectiveDate, digest);
  const operations = items.map((item) => ({
    docType: item.docType,
    sql: `public.admin_unpublish_legal(
    ${sqlLiteral(item.docType)}::text,
    admin.user_id,
    ${sqlLiteral(ids[item.docType])}::uuid,
    ${sqlLiteral(item.expectedReservationId)}::uuid,
    ${item.expectedReservationVersion}::integer
  )`,
  }));
  return buildAtomicOperationsSql(adminEmail, operations);
}

function verifyCancelReceipts(
  receipts,
  inspected,
  adminUserId,
  plannedItems = [],
) {
  const planned = Object.fromEntries(
    plannedItems.map((item) => [item.docType, item]),
  );
  for (const docType of DOC_TYPES) {
    const receipt = exactObject(receipts[docType]);
    const request = exactObject(receipt?.request_payload);
    const response = exactObject(receipt?.response);
    const item = inspected[docType];
    if (
      !receipt ||
      receipt.admin_user_id !== adminUserId ||
      receipt.action !== "unpublish" ||
      receipt.doc_type !== docType ||
      !request ||
      !UUID_RE.test(String(request.expected_reservation_id ?? "")) ||
      request.expected_reservation_version !== LEGAL_V2.targetVersion ||
      (planned[docType] &&
        request.expected_reservation_id !==
          planned[docType].expectedReservationId) ||
      !response ||
      response.ok !== true ||
      response.version !== LEGAL_V2.targetVersion ||
      typeof response.restored_draft !== "boolean" ||
      !item.draft ||
      !documentsMatch(item.draft, item.document, { includeAdminNote: true }) ||
      item.done
    ) {
      throw new Error("cancel_receipt_postcondition_failed");
    }
  }
}

function parseMutationResult(value, expectedDocTypes) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("legal_mutation_response_invalid");
  }
  const row = exactObject(value[0]);
  const result = exactObject(row?.result);
  if (!result) throw new Error("legal_mutation_response_invalid");
  for (const docType of expectedDocTypes) {
    const receipt = exactObject(result[docType]);
    if (!receipt || receipt.ok !== true) {
      throw new Error("legal_mutation_response_invalid");
    }
  }
  return result;
}

function summarize(inspected, todayKst) {
  return Object.fromEntries(
    DOC_TYPES.map((docType) => {
      const item = inspected[docType];
      return [
        docType,
        {
          latestPublishedVersion: item.latest.version,
          v2Status: item.done
            ? item.target.effective_date > todayKst
              ? "scheduled"
              : "effective"
            : "absent",
          v2EffectiveDate: item.target?.effective_date ?? null,
          draft: item.done
            ? "none"
            : item.draft
              ? documentsMatch(item.draft, item.document, {
                  includeAdminNote: true,
                })
                ? "canonical"
                : "different"
              : "none",
        },
      ];
    }),
  );
}

function dryRunPlan(
  inspected,
  args,
  todayKst,
  noticeInstant,
  cancelReceipts = {},
) {
  let stage;
  let publish;
  let cancel;
  try {
    const items = planStage(inspected);
    stage = {
      ready: true,
      mutationsRequired: items.map((item) => item.docType),
    };
  } catch (error) {
    stage = { ready: false, blocker: error.message };
  }
  if (args.effectiveDate === null) {
    publish = { ready: false, blocker: "effective_date_required_for_plan" };
    cancel = { ready: false, blocker: "effective_date_required_for_plan" };
  } else {
    try {
      const items = planPublish(
        inspected,
        args.effectiveDate,
        todayKst,
        { noticeInstant },
      );
      publish = {
        ready: true,
        mutationsRequired: items.map((item) => item.docType),
      };
    } catch (error) {
      publish = { ready: false, blocker: error.message };
    }
    try {
      const items = planCancel(
        inspected,
        args.effectiveDate,
        todayKst,
        cancelReceipts,
      );
      cancel = {
        ready: true,
        mutationsRequired: items.map((item) => item.docType),
      };
    } catch (error) {
      cancel = { ready: false, blocker: error.message };
    }
  }
  return {
    stage,
    publish,
    cancel,
    publicationBlockers: [...LEGAL_V2.rollout.publicationBlockers],
    requiredNoticeKstCalendarDays:
      LEGAL_V2.rollout.minimumNoticeKstCalendarDays,
  };
}

export async function runLegalV2Rollout({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  validateLegalV2Source();
  const parsed = parseLegalV2Args(argv);
  if (!parsed.ok) throw new Error(parsed.reason);
  const args = parsed.value;
  const management = readManagementEnvironment(env);
  const todayKst = kstDateAt(now);
  const digest = canonicalDigest();
  let state = await readProductionState(
    management,
    args.adminEmail,
    fetchImpl,
  );
  verifyProductionFingerprint(state);
  verifyProductionV1Snapshot(state);
  let inspected = inspectState(state, todayKst);
  let cancelReceipts = {};
  if (
    args.effectiveDate !== null &&
    (args.mode === "dry-run" || args.mode === "cancel")
  ) {
    cancelReceipts = await readCancelReceipts(
      management,
      args.adminEmail,
      args.effectiveDate,
      digest,
      fetchImpl,
    );
  }

  if (args.mode === "dry-run") {
    return {
      ok: true,
      mode: "dry-run",
      mutated: false,
      sourceDigest: digest,
      sourceAsOf: LEGAL_V2.sourceAsOf,
      todayKst,
      requestedEffectiveDate: args.effectiveDate,
      documents: summarize(inspected, todayKst),
      plan: dryRunPlan(
        inspected,
        args,
        todayKst,
        now,
        cancelReceipts,
      ),
    };
  }

  if (args.mode === "stage") {
    const items = planStage(inspected, {
      replaceExistingDraft: args.replaceExistingDraft,
    });
    if (items.length > 0) {
      const sql = buildStageSql(items, args.adminEmail, digest);
      const result = await managementQuery(sql, management, fetchImpl);
      parseMutationResult(
        result,
        items.map((item) => item.docType),
      );
    }
    state = await readProductionState(management, args.adminEmail, fetchImpl);
    verifyProductionFingerprint(state);
    verifyProductionV1Snapshot(state);
    inspected = inspectState(state, todayKst);
    for (const docType of DOC_TYPES) {
      const item = inspected[docType];
      if (
        !item.done &&
        (!item.draft ||
          !documentsMatch(item.draft, item.document, {
            includeAdminNote: true,
          }))
      ) {
        throw new Error("stage_postcondition_failed");
      }
    }
    return {
      ok: true,
      mode: "stage",
      mutated: items.length > 0,
      sourceDigest: digest,
      documents: summarize(inspected, todayKst),
    };
  }

  if (args.mode === "cancel") {
    const items = planCancel(
      inspected,
      args.effectiveDate,
      todayKst,
      cancelReceipts,
    );
    if (items.length > 0) {
      const sql = buildCancelSql(
        items,
        args.adminEmail,
        args.effectiveDate,
        digest,
      );
      const result = await managementQuery(sql, management, fetchImpl);
      parseMutationResult(result, DOC_TYPES);
    }
    state = await readProductionState(management, args.adminEmail, fetchImpl);
    verifyProductionFingerprint(state);
    verifyProductionV1Snapshot(state);
    inspected = inspectState(state, todayKst);
    cancelReceipts = await readCancelReceipts(
      management,
      args.adminEmail,
      args.effectiveDate,
      digest,
      fetchImpl,
    );
    verifyCancelReceipts(
      cancelReceipts,
      inspected,
      state.fingerprint.admin_user_id,
      items,
    );
    return {
      ok: true,
      mode: "cancel",
      mutated: items.length > 0,
      sourceDigest: digest,
      effectiveDate: args.effectiveDate,
      documents: summarize(inspected, todayKst),
    };
  }

  const items = planPublish(
    inspected,
    args.effectiveDate,
    todayKst,
    { noticeInstant: now },
  );
  if (items.length > 0) {
    const sql = buildPublishSql(
      items,
      args.adminEmail,
      args.effectiveDate,
      digest,
    );
    const result = await managementQuery(sql, management, fetchImpl);
    parseMutationResult(
      result,
      items.map((item) => item.docType),
    );
  }
  state = await readProductionState(management, args.adminEmail, fetchImpl);
  verifyProductionFingerprint(state);
  verifyProductionV1Snapshot(state);
  inspected = inspectState(state, todayKst);
  for (const docType of DOC_TYPES) {
    const item = inspected[docType];
    if (
      !item.done ||
      item.target.version !== LEGAL_V2.targetVersion ||
      item.target.effective_date !== args.effectiveDate ||
      !documentsMatch(item.target, item.document)
    ) {
      throw new Error("publish_postcondition_failed");
    }
  }
  return {
    ok: true,
    mode: "publish",
    mutated: items.length > 0,
    sourceDigest: digest,
    effectiveDate: args.effectiveDate,
    documents: summarize(inspected, todayKst),
  };
}

async function main() {
  try {
    const result = await runLegalV2Rollout();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9_]+(?:_\d{3})?$/.test(error.message)
        ? error.message
        : "legal_v2_rollout_failed";
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
