#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  readCanonicalSourceIdentity,
  verifyFrozenSurfaces,
} from "./apply-production-rollout.mjs";
import {
  readOAuthReceiptMigrationSource,
  verifyOAuthReceiptSourceLineage,
} from "./oauth-receipt-source-lineage.mjs";
import {
  OAUTH_CATALOG_RELATION_NAMES,
} from "./oauth-relation-fingerprints.mjs";
import {
  BOSS_PAEGI_PRODUCTION_ALIAS,
  BOSS_PAEGI_GITHUB_REPOSITORY_ID,
  BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS,
  BOSS_PAEGI_VERCEL_PROJECT_ID,
  BOSS_PAEGI_VERCEL_TEAM_ID,
  readVercelProductionAttestation,
  sameVercelProductionAttestation,
  vercelProductionEvidenceSha256,
} from "./vercel-production-attestation.mjs";

const API_HOST = "https://api.supabase.com";
const DEFAULT_PRODUCTION_ORIGIN = "https://boss-paegi.vercel.app";
const PRODUCTION_PROJECT_REF = "jxnzolkmeqjvrnzikcmb";
const MAX_MANAGEMENT_BODY_BYTES = 1024 * 1024;
const MAX_PROBE_BODY_BYTES = 4096;
// An old prepare-signup invocation can mint legacy signup_migrate authority for
// its full 300-second function lifetime. That authority then lasts 15 minutes,
// and a consent invocation that verified it just before expiry can retain the
// raw call for another 300 seconds. Add a five-second provider/DB clock margin.
const MIN_DEPLOYMENT_DRAIN_MS = (300 + 15 * 60 + 300 + 5) * 1_000;
const MAX_DEPLOYMENT_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const CONTRACT_COMMENT =
  "Internal primitive; invoke only through flow-scoped OAuth migration consumption.";
const LEGACY_BRIDGE_CONTRACT_COMMENT =
  "Expand-only pre-ledger cookie bridge; execution revoked after the full deployment drain.";
const OAUTH_CONTRACT_QUALIFICATION_MARKER =
  "-- boss_paegi_oauth_contract_qualification_injection_point";
const OAUTH_POST_CONTRACT_CATALOG_MARKER =
  "-- boss_paegi_oauth_post_contract_catalog_injection_point";
const OAUTH_POST_CONTRACT_RAW_GUARD = [
  "do $boss_paegi_raw_post_contract_guard$",
  "begin",
  "  raise exception '0095 requires the staged post-contract runner'",
  "    using errcode = 'P0001';",
  "end;",
  "$boss_paegi_raw_post_contract_guard$;",
].join("\n");
export const OAUTH_TARGET_IDENTITY_CONSTRAINT_EXPRESSION =
  "(((target_user_id IS NULL) = (target_session_id IS NULL)) AND ((target_user_id IS NULL) = (target_auth_created_at IS NULL)) AND ((target_user_id IS NULL) = (target_session_created_at IS NULL)) AND ((target_user_id IS NOT NULL) OR (target_auth_instance_id IS NULL)) AND ((target_session_id IS NULL) OR (target_session_id <> source_session_id)) AND ((target_user_id IS NULL) OR (NOT source_is_anonymous) OR (target_user_id <> source_user_id)))";
export const OAUTH_ANON_RESULT_CONSTRAINT_EXPRESSION =
  "((jsonb_typeof(result) = 'object'::text) AND (result ?& ARRAY['ok'::text, 'scores'::text, 'badges'::text, 'telemetry'::text]) AND ((result - ARRAY['ok'::text, 'scores'::text, 'badges'::text, 'telemetry'::text]) = '{}'::jsonb) AND (NOT ((result -> 'ok'::text) IS DISTINCT FROM 'true'::jsonb)) AND (jsonb_typeof((result -> 'scores'::text)) = 'number'::text) AND (jsonb_typeof((result -> 'badges'::text)) = 'number'::text) AND (jsonb_typeof((result -> 'telemetry'::text)) = 'number'::text) AND ((result ->> 'scores'::text) ~ '^(0|[1-9][0-9]{0,9})$'::text) AND ((result ->> 'badges'::text) ~ '^(0|[1-9][0-9]{0,9})$'::text) AND ((result ->> 'telemetry'::text) ~ '^(0|[1-9][0-9]{0,9})$'::text) AND ((length((result ->> 'scores'::text)) < 10) OR ((result ->> 'scores'::text) <= '2147483647'::text)) AND ((length((result ->> 'badges'::text)) < 10) OR ((result ->> 'badges'::text) <= '2147483647'::text)) AND ((length((result ->> 'telemetry'::text)) < 10) OR ((result ->> 'telemetry'::text) <= '2147483647'::text)))";
export const OAUTH_DEIDENTIFIED_REASON_CONSTRAINT_EXPRESSION =
  "(reason = ANY (ARRAY['target_withdrawn'::text, 'recovery_expired'::text, 'terminal_no_transfer'::text]))";

export const OAUTH_EXPAND_MIGRATION = "0093_oauth_flow_intents";
export const OAUTH_CONTRACT_MIGRATION =
  "0094_oauth_flow_migration_contract";
export const OAUTH_POST_CONTRACT_MIGRATION =
  "0095_analytics_maintenance_argument_bounds";
export const OAUTH_PRUNE_ACK_KEYS = Object.freeze([
  "expiredPending",
  "boundRecoveryConverged",
  "prunedTerminal",
  "targetAuthorityLossConverged",
  "targetAuthorityLossBacklog",
  "pendingExpiryBacklog",
  "terminalRetentionBacklog",
  "unconsumedMigrationBacklog",
  "unreleasedContinueBacklog",
  "unboundClaimBacklog",
  "boundRecoveryBacklog",
]);

const OAUTH_EXPAND_FUNCTION_BODY_NAMES = Object.freeze([
  "abandon_oauth_flow_intent",
  "assert_oauth_rollout_deployment_qualification",
  "begin_oauth_flow_intent",
  "bind_oauth_flow_intent_target",
  "bp_0093_consume_oauth_flow_intent_migration_impl",
  "bp_0093_legacy_migration_skip",
  "bp_0093_oauth_target_generation_matches",
  "bp_0093_quarantine_oauth_anon_source",
  "bp_0093_reassign_legacy_anon_data",
  "bp_0093_reassign_quarantined_anon_data",
  "bp_0093_scrub_oauth_quarantined_source",
  "cancel_oauth_flow_intent",
  "claim_oauth_anon_auth_cleanup",
  "claim_oauth_flow_intent",
  "clear_oauth_quarantined_score_highlight_marker",
  "complete_oauth_flow_intent_migration_without_transfer",
  "complete_oauth_flow_signout",
  "complete_recovered_oauth_flow_signout",
  "confirm_oauth_flow_signout_revoke",
  "consume_legacy_signup_migration",
  "consume_oauth_flow_intent_migration",
  "expire_oauth_flow_intent",
  "fence_oauth_anon_auth_cleanup_user",
  "fence_oauth_retained_anon_auth_delete",
  "fence_revoked_oauth_target_session_id",
  "finalize_oauth_flow_intent",
  "finish_oauth_anon_auth_cleanup",
  "guard_anon_data_reassignment_append_only",
  "guard_legacy_signup_migration_receipt",
  "guard_oauth_auth_session_id_tombstone",
  "guard_oauth_critical_relation_truncate",
  "guard_oauth_deidentified_score_owner_profile_delete",
  "guard_oauth_deidentified_score_owner_tombstone",
  "guard_oauth_rollout_deployment_qualification",
  "oauth_anon_privacy_status",
  "oauth_current_auth_session_live",
  "oauth_current_badge_owner_readable",
  "prune_oauth_flow_intents",
  "read_oauth_flow_intent_status",
  "read_oauth_flow_target_session_evidence",
  "reassign_anon_data",
  "recover_active_oauth_flow_by_observed_session",
  "recover_oauth_flow_intent_authority",
  "release_oauth_flow_intent",
  "revoke_bound_oauth_flow_target_session",
  "rotate_oauth_flow_target_session_evidence",
  "tombstone_oauth_cleanup_consumed_session_id",
  "tombstone_oauth_flow_auth_session_ids",
  "verify_oauth_anon_auth_cleanup_source",
  "verify_oauth_flow_source_session_evidence",
  "verify_oauth_flow_target_session_evidence",
]);

const ANALYTICS_MAINTENANCE_FUNCTION_NAMES = Object.freeze([
  "maintain_analytics_rollups",
  "prune_analytics_events",
  "telemetry_prune",
  "telemetry_rollup_days",
]);

const POST_CONTRACT_OWNER_ONLY_FUNCTION_SIGNATURES = Object.freeze([
  "public.admin_dismiss_report(uuid,uuid,text)",
  "public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)",
  "public.legal_sections_valid(jsonb)",
  "public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)",
  "public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)",
  "public.release_generation_preflight(uuid,uuid,uuid,text)",
]);

const OAUTH_EXTERNAL_FUNCTION_SOURCES = Object.freeze([
  Object.freeze({
    name: "bp_0084_anon_reassign_locks",
    sourceName: "bp_0084_anon_reassign_locks",
    sourceKey: "userMutationLockOrderSql",
  }),
  Object.freeze({
    name: "bp_0084_reassign_anon_data_impl",
    sourceName: "reassign_anon_data",
    sourceKey: "scoreSubmissionIntegritySql",
  }),
  Object.freeze({
    name: "bp_telemetry_submitter_binding",
    sourceName: "bp_telemetry_submitter_binding",
    sourceKey: "scoreSubmissionIntegritySql",
  }),
  Object.freeze({
    name: "bp_user_mutation_lock",
    sourceName: "bp_user_mutation_lock",
    sourceKey: "userMutationLockOrderSql",
  }),
  Object.freeze({
    name: "bp_user_mutation_lock_many",
    sourceName: "bp_user_mutation_lock_many",
    sourceKey: "userMutationLockOrderSql",
  }),
]);

const OAUTH_CATALOG_FUNCTION_NAMES = Object.freeze(
  [
    ...OAUTH_EXPAND_FUNCTION_BODY_NAMES,
    ...OAUTH_EXTERNAL_FUNCTION_SOURCES.map(({ name }) => name),
  ].sort(),
);

const OAUTH_OWNER_ONLY_FUNCTION_NAMES = new Set([
  "assert_oauth_rollout_deployment_qualification",
  "bp_0093_consume_oauth_flow_intent_migration_impl",
  "bp_0093_legacy_migration_skip",
  "bp_0093_oauth_target_generation_matches",
  "bp_0093_quarantine_oauth_anon_source",
  "bp_0093_reassign_legacy_anon_data",
  "bp_0093_reassign_quarantined_anon_data",
  "bp_0093_scrub_oauth_quarantined_source",
  "clear_oauth_quarantined_score_highlight_marker",
  "complete_oauth_flow_intent_migration_without_transfer",
  "fence_oauth_anon_auth_cleanup_user",
  "fence_oauth_retained_anon_auth_delete",
  "fence_revoked_oauth_target_session_id",
  "guard_anon_data_reassignment_append_only",
  "guard_legacy_signup_migration_receipt",
  "guard_oauth_auth_session_id_tombstone",
  "guard_oauth_critical_relation_truncate",
  "guard_oauth_deidentified_score_owner_profile_delete",
  "guard_oauth_deidentified_score_owner_tombstone",
  "guard_oauth_rollout_deployment_qualification",
  "tombstone_oauth_cleanup_consumed_session_id",
  "tombstone_oauth_flow_auth_session_ids",
]);

const OAUTH_STAGE_VARIABLE_EXECUTE_FUNCTION_NAMES = new Set([
  "consume_legacy_signup_migration",
  "reassign_anon_data",
]);

const OAUTH_AUTHENTICATED_EXECUTE_FUNCTION_NAMES = new Set([
  "oauth_current_auth_session_live",
  "oauth_current_badge_owner_readable",
]);

/** @typedef {Record<string, string | undefined>} RuntimeEnvironment */

export function parseOAuthRolloutArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, reason: "invalid_arguments" };
  }
  let stage = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stage" && stage === null) {
      const candidate = argv[index + 1];
      if (
        candidate !== "expand" &&
        candidate !== "app-postflight" &&
        candidate !== "contract" &&
        candidate !== "post-contract"
      ) {
        return { ok: false, reason: "invalid_stage" };
      }
      stage = candidate;
      index += 1;
    } else if (argument === "--apply" && !apply) {
      apply = true;
    } else {
      return { ok: false, reason: "unsupported_argument" };
    }
  }
  if (stage === null) return { ok: false, reason: "stage_required" };
  if (stage === "app-postflight" && apply) {
    return { ok: false, reason: "postflight_is_read_only" };
  }
  return { ok: true, stage, apply };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPgType(value) {
  const compact = value.trim().replace(/\s+/gu, " ").toLowerCase();
  const aliases = new Map([
    ["bool", "boolean"],
    ["int", "integer"],
    ["int4", "integer"],
    ["timestamptz", "timestamp with time zone"],
  ]);
  const canonical = aliases.get(compact) ?? compact;
  if (
    ![
      "boolean",
      "integer",
      "jsonb",
      "text",
      "timestamp with time zone",
      "trigger",
      "uuid",
      "uuid[]",
      "void",
    ].includes(canonical)
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  return canonical;
}

function canonicalFunctionArguments(rawArguments) {
  const raw = rawArguments.trim();
  if (raw === "") return "";
  return raw
    .split(",")
    .map((rawArgument) => {
      const argument = rawArgument.trim().replace(/\s+/gu, " ");
      const match = argument.match(
        /^([a-z][a-z0-9_]*)\s+([a-z][a-z0-9_]*(?:\[\])?)(?:\s+default\s+(.+))?$/u,
      );
      if (!match) {
        throw new Error("oauth_function_body_manifest_invalid");
      }
      const [, name, rawType, rawDefault] = match;
      const type = canonicalPgType(rawType);
      if (rawDefault === undefined) return `${name} ${type}`;
      const normalizedDefault = rawDefault.trim().toLowerCase();
      let canonicalDefault;
      if (normalizedDefault === "null") {
        canonicalDefault = `NULL::${type}`;
      } else if (
        type === "integer" &&
        /^(?:0|[1-9][0-9]*)$/u.test(normalizedDefault)
      ) {
        canonicalDefault = normalizedDefault;
      } else if (
        type === "boolean" &&
        (normalizedDefault === "true" || normalizedDefault === "false")
      ) {
        canonicalDefault = normalizedDefault;
      } else {
        throw new Error("oauth_function_body_manifest_invalid");
      }
      return `${name} ${type} DEFAULT ${canonicalDefault}`;
    })
    .join(", ");
}

function readFunctionDefinition(
  sql,
  sourceName,
  name = sourceName,
  executeAcl = "owner",
  searchPath = "",
) {
  if (
    typeof sql !== "string" ||
    sql.length === 0 ||
    ![
      "authenticated",
      "owner",
      "owner_or_service",
      "service",
    ].includes(executeAcl) ||
    !["", "public"].includes(searchPath)
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  const escapedSourceName = sourceName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const pattern = new RegExp(
    String.raw`create or replace function\s+(?:\n\s*)?public\.${escapedSourceName}\s*\(([\s\S]*?)\)\s*(returns[\s\S]*?)\bas (\$[a-z0-9_]*\$)([\s\S]*?)\3;`,
    "gu",
  );
  const matches = [...sql.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  const [, rawArguments, attributes, , body] = matches[0];
  const languages = [
    ...attributes.matchAll(/\blanguage\s+(plpgsql|sql)\b/gu),
  ].map((match) => match[1]);
  const volatilityAttributes = [
    ...attributes.matchAll(/\b(immutable|stable|volatile)\b/gu),
  ].map((match) => match[1]);
  const parallelAttributes = [
    ...attributes.matchAll(/\bparallel\s+(safe|restricted|unsafe)\b/gu),
  ].map((match) => match[1]);
  const resultMatch = attributes.match(
    /^returns\s+([a-z][a-z0-9_]*(?:\[\])?)\b/u,
  );
  const searchPathClause =
    searchPath === ""
      ? "set search_path = ''"
      : `set search_path = ${searchPath}`;
  if (
    languages.length !== 1 ||
    volatilityAttributes.length > 1 ||
    parallelAttributes.length > 1 ||
    (attributes.match(/\bsecurity definer\b/gu) ?? []).length > 1 ||
    (attributes.match(/\bstrict\b/gu) ?? []).length > 1 ||
    attributes.split(searchPathClause).length - 1 !== 1 ||
    (attributes.match(/\bset search_path\s*=/gu) ?? []).length !== 1 ||
    /\bsecurity invoker\b/u.test(attributes) ||
    /\breturns null on null input\b/u.test(attributes) ||
    !resultMatch ||
    typeof body !== "string" ||
    body.length === 0
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  const volatility = new Map([
    ["immutable", "i"],
    ["stable", "s"],
    ["volatile", "v"],
  ]).get(volatilityAttributes[0] ?? "volatile");
  const parallel = new Map([
    ["safe", "s"],
    ["restricted", "r"],
    ["unsafe", "u"],
  ]).get(parallelAttributes[0] ?? "unsafe");
  if (!volatility || !parallel) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  return {
    name,
    bodySha256: sha256(body),
    functionArguments: canonicalFunctionArguments(rawArguments),
    functionResult: canonicalPgType(resultMatch[1]),
    language: languages[0],
    securityDefiner: /\bsecurity definer\b/u.test(attributes),
    volatility,
    strict: /\bstrict\b/u.test(attributes),
    parallel,
    executeAcl,
  };
}

export function readOAuthExpandFunctionBodyManifest(sql) {
  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  const functionPattern =
    /create or replace function\s+(?:\n\s*)?public\.([a-z0-9_]+)\s*\([\s\S]*?\)\s*(?:returns[\s\S]*?)\bas \$\$[\s\S]*?\$\$;/gu;
  const names = [...sql.matchAll(functionPattern)].map((match) => match[1]);
  const sortedNames = [...names].sort();
  if (
    names.length !== OAUTH_EXPAND_FUNCTION_BODY_NAMES.length ||
    new Set(names).size !== names.length ||
    sortedNames.some(
      (name, index) => name !== OAUTH_EXPAND_FUNCTION_BODY_NAMES[index],
    )
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  return OAUTH_EXPAND_FUNCTION_BODY_NAMES.map((name) =>
    readFunctionDefinition(
      sql,
      name,
      name,
      OAUTH_OWNER_ONLY_FUNCTION_NAMES.has(name)
        ? "owner"
        : OAUTH_AUTHENTICATED_EXECUTE_FUNCTION_NAMES.has(name)
          ? "authenticated"
        : OAUTH_STAGE_VARIABLE_EXECUTE_FUNCTION_NAMES.has(name)
          ? "owner_or_service"
          : "service",
    ),
  );
}

export function readAnalyticsMaintenanceFunctionManifest(sql) {
  if (
    typeof sql !== "string" ||
    sql.length === 0 ||
    sql.split(OAUTH_POST_CONTRACT_CATALOG_MARKER).length - 1 !== 1 ||
    POST_CONTRACT_OWNER_ONLY_FUNCTION_SIGNATURES.some(
      (signature) =>
        sql.split(`'${signature}'`).length - 1 !== 3,
    ) ||
    !sql.includes(
      "0095 postflight: superseded RPC ACL drift (%)",
    )
  ) {
    throw new Error("analytics_maintenance_function_manifest_invalid");
  }
  const functionPattern =
    /create or replace function\s+(?:\n\s*)?public\.([a-z0-9_]+)\s*\([\s\S]*?\)\s*(?:returns[\s\S]*?)\bas (\$[a-z0-9_]*\$)[\s\S]*?\2;/gu;
  const names = [...sql.matchAll(functionPattern)].map((match) => match[1]);
  const sortedNames = [...names].sort();
  if (
    names.length !== ANALYTICS_MAINTENANCE_FUNCTION_NAMES.length ||
    new Set(names).size !== names.length ||
    sortedNames.some(
      (name, index) =>
        name !== ANALYTICS_MAINTENANCE_FUNCTION_NAMES[index],
    )
  ) {
    throw new Error("analytics_maintenance_function_manifest_invalid");
  }
  let manifest;
  try {
    manifest = ANALYTICS_MAINTENANCE_FUNCTION_NAMES.map((name) =>
      readFunctionDefinition(
        sql,
        name,
        name,
        "service",
        "public",
      ),
    );
  } catch {
    throw new Error("analytics_maintenance_function_manifest_invalid");
  }
  const expectedArguments = new Map([
    [
      "maintain_analytics_rollups",
      "p_days integer DEFAULT 7",
    ],
    [
      "prune_analytics_events",
      "p_retention_days integer DEFAULT 90",
    ],
    ["telemetry_prune", ""],
    [
      "telemetry_rollup_days",
      "p_days integer DEFAULT 3",
    ],
  ]);
  if (
    manifest.some(
      (entry) =>
        entry.functionArguments !== expectedArguments.get(entry.name) ||
        entry.functionResult !== "jsonb" ||
        entry.language !== "plpgsql" ||
        entry.securityDefiner !== true ||
        entry.volatility !== "v" ||
        entry.strict !== false ||
        entry.parallel !== "u" ||
        entry.executeAcl !== "service",
    )
  ) {
    throw new Error("analytics_maintenance_function_manifest_invalid");
  }
  const aclPattern =
    /^(revoke all|grant execute) on function\s+(?:\n\s*)?public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s+(from|to)\s+([^;]+);$/gmu;
  const aclStatements = [...sql.matchAll(aclPattern)]
    .filter((match) =>
      ANALYTICS_MAINTENANCE_FUNCTION_NAMES.includes(match[2]),
    )
    .map((match) => ({
      operation: match[1],
      name: match[2],
      identityArguments: canonicalFunctionIdentitySignature(match[3]),
      direction: match[4],
      roles: match[5].trim().replace(/\s+/gu, " "),
    }));
  if (
    aclStatements.length !==
      ANALYTICS_MAINTENANCE_FUNCTION_NAMES.length * 2 ||
    manifest.some((entry) => {
      const identityArguments = canonicalFunctionIdentityArguments(
        entry.functionArguments,
      );
      const statements = aclStatements.filter(
        ({ name }) => name === entry.name,
      );
      return !(
        statements.length === 2 &&
        statements.some(
          (statement) =>
            statement.operation === "revoke all" &&
            statement.identityArguments === identityArguments &&
            statement.direction === "from" &&
            statement.roles ===
              "public, anon, authenticated, service_role",
        ) &&
        statements.some(
          (statement) =>
            statement.operation === "grant execute" &&
            statement.identityArguments === identityArguments &&
            statement.direction === "to" &&
            statement.roles === "service_role",
        )
      );
    })
  ) {
    throw new Error("analytics_maintenance_function_manifest_invalid");
  }
  return manifest;
}

function canonicalFunctionIdentityArguments(functionArguments) {
  if (typeof functionArguments !== "string") {
    throw new Error("oauth_function_acl_manifest_invalid");
  }
  if (functionArguments === "") return "";
  return functionArguments
    .split(", ")
    .map((argument) => {
      const match = argument.match(
        /^[a-z][a-z0-9_]* (boolean|integer|jsonb|text|timestamp with time zone|trigger|uuid|uuid\[\]|void)(?: DEFAULT .+)?$/u,
      );
      if (!match) {
        throw new Error("oauth_function_acl_manifest_invalid");
      }
      return match[1];
    })
    .join(", ");
}

function canonicalFunctionIdentitySignature(rawArguments) {
  const raw = rawArguments.trim();
  if (raw === "") return "";
  return raw
    .split(",")
    .map((argument) => canonicalPgType(argument))
    .join(", ");
}

export function validateOAuthExpandFunctionAclSignatures(
  sql,
  manifest = readOAuthExpandFunctionBodyManifest(sql),
) {
  if (
    typeof sql !== "string" ||
    sql.length === 0 ||
    !Array.isArray(manifest) ||
    manifest.length !== OAUTH_EXPAND_FUNCTION_BODY_NAMES.length
  ) {
    throw new Error("oauth_function_acl_manifest_invalid");
  }
  const aclPattern =
    /^(revoke all|grant execute) on function\s+(?:\n\s*)?public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s+(from|to)\s+([^;]+);$/gmu;
  const actual = [...sql.matchAll(aclPattern)].map((match) => ({
    operation: match[1],
    name: match[2],
    identityArguments: canonicalFunctionIdentitySignature(match[3]),
    direction: match[4],
    roles: match[5].trim().replace(/\s+/gu, " "),
  }));
  const expectedNames = new Set(manifest.map(({ name }) => name));
  if (
    expectedNames.size !== manifest.length ||
    actual.some(({ name }) => !expectedNames.has(name))
  ) {
    throw new Error("oauth_function_acl_manifest_invalid");
  }
  for (const entry of manifest) {
    const identityArguments = canonicalFunctionIdentityArguments(
      entry.functionArguments,
    );
    const statements = actual.filter(({ name }) => name === entry.name);
    const revokes = statements.filter(
      ({ operation }) => operation === "revoke all",
    );
    const grants = statements.filter(
      ({ operation }) => operation === "grant execute",
    );
    if (
      revokes.length !== 1 ||
      revokes[0].identityArguments !== identityArguments ||
      revokes[0].direction !== "from" ||
      revokes[0].roles !==
        "public, anon, authenticated, service_role" ||
      (entry.executeAcl === "owner" && grants.length !== 0) ||
      (
        entry.executeAcl !== "owner" &&
        (
          grants.length !== 1 ||
          grants[0].identityArguments !== identityArguments ||
          grants[0].direction !== "to" ||
          grants[0].roles !==
            (
              entry.executeAcl === "authenticated"
                ? "authenticated"
                : "service_role"
            )
        )
      )
    ) {
      throw new Error("oauth_function_acl_manifest_invalid");
    }
  }
  return true;
}

export function readOAuthCatalogFunctionManifest(
  expandSql,
  dependencySources,
) {
  if (
    !dependencySources ||
    typeof dependencySources !== "object" ||
    Array.isArray(dependencySources) ||
    Object.keys(dependencySources).sort().join(",") !==
      "scoreSubmissionIntegritySql,userMutationLockOrderSql" ||
    Object.values(dependencySources).some(
      (source) => typeof source !== "string" || source.length === 0,
    )
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  const entries = [
    ...readOAuthExpandFunctionBodyManifest(expandSql),
    ...OAUTH_EXTERNAL_FUNCTION_SOURCES.map(
      ({ name, sourceName, sourceKey }) =>
        readFunctionDefinition(
          dependencySources[sourceKey],
          sourceName,
          name,
          "owner",
        ),
    ),
  ];
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (
    entries.length !== OAUTH_CATALOG_FUNCTION_NAMES.length ||
    entries.some(
      (entry, index) =>
        entry.name !== OAUTH_CATALOG_FUNCTION_NAMES[index],
    )
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  return entries;
}

function exactCommit(value, reason) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(reason);
  return normalized;
}

function productionOrigin(value) {
  const raw =
    typeof value === "string" && value.length > 0
      ? value
      : DEFAULT_PRODUCTION_ORIGIN;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("production_origin_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.origin !== DEFAULT_PRODUCTION_ORIGIN
  ) {
    throw new Error("production_origin_invalid");
  }
  return url.origin;
}

/** @param {RuntimeEnvironment} env */
function readManagementEnvironment(env) {
  const token = env.BOSS_PAEGI_SUPABASE_ACCESS_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("management_access_token_missing");
  }
  const configuredRef =
    env.BOSS_PAEGI_SUPABASE_PROJECT_REF ?? PRODUCTION_PROJECT_REF;
  if (configuredRef !== PRODUCTION_PROJECT_REF) {
    throw new Error("management_project_ref_mismatch");
  }
  return { token, ref: PRODUCTION_PROJECT_REF };
}

async function readBoundedJson(response, maxBytes) {
  if (!response?.body || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("response_body_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("response_body_invalid");
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response_body_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("response_utf8_invalid");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("response_json_invalid");
  }
}

class ManagementRequestError extends Error {
  constructor(status = null) {
    super("management_request_failed");
    this.status = status;
  }
}

async function managementQuery(sql, management, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(
      `${API_HOST}/v1/projects/${management.ref}/database/query`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${management.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql.trim() }),
        redirect: "error",
        signal: AbortSignal.timeout(12 * 60_000),
      },
    );
  } catch {
    throw new ManagementRequestError();
  }
  if (!response.ok || response.redirected) {
    try {
      await response.body?.cancel();
    } catch {
      // Provider bodies can contain row identifiers, so never surface them.
    }
    throw new ManagementRequestError(response.status);
  }
  return readBoundedJson(response, MAX_MANAGEMENT_BODY_BYTES);
}

function manifestHash(stage, sourceTree, migrationHash) {
  return sha256(
    JSON.stringify({
      schema: "boss-paegi-oauth-production-rollout-manifest/v1",
      stage,
      sourceTree,
      migrationHash,
    }),
  );
}

async function migrationSource(
  version,
  stage,
  sourceTree,
  immutableSql = null,
) {
  const sql =
    immutableSql === null
      ? await readFile(
          new URL(
            `../../supabase/migrations/${version}.sql`,
            import.meta.url,
          ),
          "utf8",
        )
      : immutableSql;
  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error(`oauth_migration_source_invalid:${version}`);
  }
  const executableSql = sql.replace(/^[\t ]*--.*$/gm, "");
  const normalizedExecutableSql = executableSql.trim();
  const pruneBody =
    version === OAUTH_EXPAND_MIGRATION
      ? sql.match(
          /create or replace function public\.prune_oauth_flow_intents\([\s\S]*?returns jsonb[\s\S]*?as \$\$([\s\S]*?)\$\$;/u,
        )?.[1]
      : null;
  const pruneAcknowledgement =
    pruneBody?.match(
      /return pg_catalog\.jsonb_build_object\(([\s\S]*?)\);\s*end;/u,
    )?.[1] ?? null;
  const pruneKeys =
    pruneAcknowledgement === null
      ? []
      : [
          ...pruneAcknowledgement.matchAll(
            /'([^']+)'\s*,/gu,
          ),
        ].map(([, key]) => key);
  if (
    (sql.match(/^begin;$/gm) ?? []).length !== 1 ||
    (sql.match(/^commit;$/gm) ?? []).length !== 1 ||
    !normalizedExecutableSql.startsWith("begin;\n") ||
    !normalizedExecutableSql.endsWith(
      "notify pgrst, 'reload schema';\ncommit;",
    ) ||
    !/^set local lock_timeout = '[1-9][0-9]*(?:ms|s|min)';$/m.test(sql) ||
    !/^set local statement_timeout = '[1-9][0-9]*(?:ms|s|min)';$/m.test(
      sql,
    ) ||
    /create\s+(?:unique\s+)?index\s+concurrently/i.test(executableSql) ||
    (
      version === OAUTH_CONTRACT_MIGRATION &&
      (
        (sql.match(
          /-- boss_paegi_oauth_contract_qualification_injection_point/gu,
        ) ?? []).length !== 1 ||
        !sql.includes(
          "select public.assert_oauth_rollout_deployment_qualification(",
        )
      )
    ) ||
    (
      version === OAUTH_EXPAND_MIGRATION &&
      sql.includes(OAUTH_CONTRACT_QUALIFICATION_MARKER)
    ) ||
    (
      version === OAUTH_POST_CONTRACT_MIGRATION &&
      (
        (sql.match(
          /-- boss_paegi_oauth_post_contract_catalog_injection_point/gu,
        ) ?? []).length !== 1 ||
        sql.split(OAUTH_POST_CONTRACT_RAW_GUARD).length - 1 !== 1 ||
        !sql.includes(
          `${OAUTH_POST_CONTRACT_CATALOG_MARKER}\n${OAUTH_POST_CONTRACT_RAW_GUARD}`,
        ) ||
        sql.includes(OAUTH_CONTRACT_QUALIFICATION_MARKER)
      )
    ) ||
    (
      version !== OAUTH_POST_CONTRACT_MIGRATION &&
      sql.includes(OAUTH_POST_CONTRACT_CATALOG_MARKER)
    ) ||
    (
      version === OAUTH_EXPAND_MIGRATION &&
      (
        pruneKeys.length !== OAUTH_PRUNE_ACK_KEYS.length ||
        !OAUTH_PRUNE_ACK_KEYS.every(
          (key, index) => pruneKeys[index] === key,
        )
      )
    )
  ) {
    throw new Error(`oauth_migration_source_invalid:${version}`);
  }
  const migrationHash = sha256(sql);
  let functionBodyManifest = [];
  let maintenanceFunctionBodyManifest = [];
  let catalogIntegrityQuery = null;
  let contractCatalogIntegrityQuery = null;
  if (version === OAUTH_EXPAND_MIGRATION) {
    const [
      scoreSubmissionIntegritySql,
      userMutationLockOrderSql,
    ] = await Promise.all([
      readFile(
        new URL(
          "../../supabase/migrations/0074_score_submission_integrity.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../supabase/migrations/0084_user_mutation_lock_order.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const dependencySources = {
      scoreSubmissionIntegritySql,
      userMutationLockOrderSql,
    };
    validateOAuthExpandFunctionAclSignatures(sql);
    functionBodyManifest = readOAuthCatalogFunctionManifest(
      sql,
      dependencySources,
    );
    const { renderOAuthCatalogIntegrityQuery } = await import(
      "./render-oauth-catalog-integrity-query.mjs"
    );
    catalogIntegrityQuery = renderOAuthCatalogIntegrityQuery(
      sql,
      dependencySources,
      "expand",
    );
    contractCatalogIntegrityQuery = renderOAuthCatalogIntegrityQuery(
      sql,
      dependencySources,
      "contract",
    );
  } else if (version === OAUTH_POST_CONTRACT_MIGRATION) {
    maintenanceFunctionBodyManifest =
      readAnalyticsMaintenanceFunctionManifest(sql);
  }
  return {
    stage,
    version,
    sql,
    migrationHash,
    manifestHash: manifestHash(stage, sourceTree, migrationHash),
    functionBodyManifest,
    maintenanceFunctionBodyManifest,
    catalogIntegrityQuery,
    contractCatalogIntegrityQuery,
  };
}

function contractCatalogAssertionSql(catalogIntegrityQuery) {
  if (
    typeof catalogIntegrityQuery !== "string" ||
    catalogIntegrityQuery.length === 0 ||
    catalogIntegrityQuery.includes("$boss_paegi_catalog$") ||
    (catalogIntegrityQuery.match(/;/gu) ?? []).length !== 1 ||
    !catalogIntegrityQuery.trimStart().startsWith("with ") ||
    !catalogIntegrityQuery.trimEnd().endsWith(";")
  ) {
    throw new Error("oauth_catalog_integrity_query_invalid");
  }
  const query = catalogIntegrityQuery.trim().slice(0, -1);
  return [
    "do $boss_paegi_catalog$",
    "declare",
    "  v_ready boolean;",
    "begin",
    "  select catalog_result = 'ready'",
    "    into v_ready",
    "    from (",
    query,
    "    ) oauth_catalog(catalog_result);",
    "  if v_ready is distinct from true then",
    "    raise exception 'oauth_catalog_integrity_invalid'",
    "      using errcode = 'P0001';",
    "  end if;",
    "end;",
    "$boss_paegi_catalog$;",
  ].join("\n");
}

const OAUTH_CATALOG_LOCK_RELATIONS = Object.freeze([
  "auth.sessions",
  "auth.users",
  "public.ai_generations",
  "public.anon_data_reassignments",
  "public.dolls",
  "public.legacy_signup_migration_receipts",
  "public.member_accounts",
  "public.oauth_anon_auth_cleanup_jobs",
  "public.oauth_auth_session_id_tombstones",
  "public.oauth_deidentified_score_owner_tombstones",
  "public.oauth_flow_intents",
  "public.oauth_quarantined_score_highlights",
  "public.oauth_rollout_deployment_qualifications",
  "public.orders",
  "public.profiles",
  "public.schema_migration_journal",
  "public.score_highlights",
  "public.scores",
  "public.telemetry_sessions",
  "public.user_badges",
]);
const OAUTH_CATALOG_LOCK_SENTINEL_ROLE =
  "bp_oauth_catalog_lock_sentinel";

export function catalogMutationLocksSql(functionManifest) {
  if (
    !Array.isArray(functionManifest) ||
    functionManifest.length !== OAUTH_CATALOG_FUNCTION_NAMES.length ||
    functionManifest.some(
      (entry, index) =>
        !entry ||
        entry.name !== OAUTH_CATALOG_FUNCTION_NAMES[index] ||
        typeof entry.functionArguments !== "string",
    ) ||
    OAUTH_CATALOG_RELATION_NAMES.some(
      (relationName) =>
        !OAUTH_CATALOG_LOCK_RELATIONS.includes(relationName),
    )
  ) {
    throw new Error("oauth_catalog_lock_manifest_invalid");
  }
  const relationList = OAUTH_CATALOG_LOCK_RELATIONS.map(
    (relationName) => `  ${relationName}`,
  ).join(",\n");
  const relationValues = OAUTH_CATALOG_LOCK_RELATIONS.map(
    (relationName) => `      (${sqlLiteral(relationName)})`,
  ).join(",\n");
  const rowTypeList = OAUTH_CATALOG_RELATION_NAMES.map(
    (relationName) => `  ${relationName}`,
  ).join(",\n");
  return [
    "select pg_catalog.pg_advisory_xact_lock(",
    "  pg_catalog.hashtextextended(",
    "    'boss-paegi:oauth-catalog-mutation-lock',",
    "    0",
    "  )",
    ");",
    "",
    "lock table",
    relationList,
    "in share update exclusive mode;",
    "",
    `create role ${OAUTH_CATALOG_LOCK_SENTINEL_ROLE} nologin;`,
    "",
    "grant select on table",
    relationList,
    `to ${OAUTH_CATALOG_LOCK_SENTINEL_ROLE};`,
    "revoke select on table",
    relationList,
    `from ${OAUTH_CATALOG_LOCK_SENTINEL_ROLE};`,
    "",
    "do $boss_paegi_catalog_columns$",
    "declare",
    "  v_relation_name text;",
    "  v_columns text;",
    "begin",
    "  for v_relation_name in",
    "    select locked_relation.relation_name",
    "      from (",
    "        values",
    relationValues,
    "      ) locked_relation(relation_name)",
    "  loop",
    "    select pg_catalog.string_agg(",
    "             pg_catalog.format('%I', attribute.attname),",
    "             ', '",
    "             order by attribute.attnum",
    "           )",
    "      into v_columns",
    "      from pg_catalog.pg_attribute attribute",
    "     where attribute.attrelid =",
    "           pg_catalog.to_regclass(v_relation_name)",
    "       and attribute.attnum > 0",
    "       and not attribute.attisdropped;",
    "",
    "    if v_columns is null then",
    "      raise exception 'oauth_catalog_lock_relation_invalid:%',",
    "        v_relation_name",
    "        using errcode = 'P0001';",
    "    end if;",
    "",
    "    execute pg_catalog.format(",
    "      'grant select (%s) on table %s to " +
      `${OAUTH_CATALOG_LOCK_SENTINEL_ROLE}',`,
    "      v_columns,",
    "      v_relation_name",
    "    );",
    "    execute pg_catalog.format(",
    "      'revoke select (%s) on table %s from " +
      `${OAUTH_CATALOG_LOCK_SENTINEL_ROLE}',`,
    "      v_columns,",
    "      v_relation_name",
    "    );",
    "  end loop;",
    "end;",
    "$boss_paegi_catalog_columns$;",
    "",
    "grant usage on type",
    rowTypeList,
    `to ${OAUTH_CATALOG_LOCK_SENTINEL_ROLE};`,
    "revoke usage on type",
    rowTypeList,
    `from ${OAUTH_CATALOG_LOCK_SENTINEL_ROLE};`,
    "",
    "do $boss_paegi_catalog_publications$",
    "declare",
    "  v_publication record;",
    "begin",
    "  for v_publication in",
    "    select",
    "      publication.pubname,",
    "      publication.pubowner,",
    "      pg_catalog.concat_ws(",
    "        ', ',",
    "        case when publication.pubinsert then 'insert' end,",
    "        case when publication.pubupdate then 'update' end,",
    "        case when publication.pubdelete then 'delete' end,",
    "        case when publication.pubtruncate then 'truncate' end",
    "      ) as publish_actions,",
    "      publication.pubviaroot",
    "      from pg_catalog.pg_publication publication",
    "     order by publication.pubname",
    "  loop",
    "    if v_publication.pubowner <>",
    "         (select role.oid",
    "            from pg_catalog.pg_roles role",
    "           where role.rolname = current_user)",
    "    then",
    "      raise exception",
    "        'oauth_catalog_publication_owner_invalid:%',",
    "        v_publication.pubname",
    "        using errcode = 'P0001';",
    "    end if;",
    "",
    "    execute pg_catalog.format(",
    "      'alter publication %I set (" +
      "publish = %L, publish_via_partition_root = %s)',",
    "      v_publication.pubname,",
    "      v_publication.publish_actions,",
    "      case",
    "        when v_publication.pubviaroot then 'true'",
    "        else 'false'",
    "      end",
    "    );",
    "  end loop;",
    "end;",
    "$boss_paegi_catalog_publications$;",
    "",
    `drop role ${OAUTH_CATALOG_LOCK_SENTINEL_ROLE};`,
    "",
    ...functionManifest.map(
      ({ name, functionArguments }) =>
        `alter function public.${name}(${canonicalFunctionIdentityArguments(
          functionArguments,
        )}) set search_path to '';`,
    ),
  ].join("\n");
}

function injectReceipt(
  source,
  appCommit,
  qualification = null,
  catalogIntegrityQuery = null,
  postContractCatalogIntegrityQuery = null,
  catalogFunctionManifest = null,
) {
  const boundary = "notify pgrst, 'reload schema';\ncommit;";
  const boundaryIndex = source.sql.indexOf(boundary);
  if (
    boundaryIndex < 0 ||
    boundaryIndex !== source.sql.lastIndexOf(boundary)
  ) {
    throw new Error(`oauth_migration_boundary_invalid:${source.version}`);
  }
  const markerCount = source.sql.split(
    OAUTH_CONTRACT_QUALIFICATION_MARKER,
  ).length - 1;
  const postContractMarkerCount = source.sql.split(
    OAUTH_POST_CONTRACT_CATALOG_MARKER,
  ).length - 1;
  const catalogLocks = catalogMutationLocksSql(
    catalogFunctionManifest,
  );
  const injectedSnippets = [catalogLocks];
  let executableSource = source.sql;
  if (source.version === OAUTH_CONTRACT_MIGRATION) {
    if (
      qualification === null ||
      markerCount !== 1 ||
      postContractMarkerCount !== 0 ||
      catalogIntegrityQuery === null ||
      postContractCatalogIntegrityQuery === null
    ) {
      throw new Error(
        `oauth_migration_receipt_injection_failed:${source.version}`,
      );
    }
    injectedSnippets.push(
      qualificationReceiptSql(qualification),
      contractCatalogAssertionSql(catalogIntegrityQuery),
      contractCatalogAssertionSql(postContractCatalogIntegrityQuery),
    );
    executableSource = executableSource.replace(
      OAUTH_CONTRACT_QUALIFICATION_MARKER,
      () => [
        catalogLocks,
        "",
        qualificationReceiptSql(qualification),
      ].join("\n"),
    );
    const qualificationAssertion = [
      "select public.assert_oauth_rollout_deployment_qualification(",
      `  '${OAUTH_CONTRACT_MIGRATION}'`,
      ");",
    ].join("\n");
    if (
      executableSource.split(qualificationAssertion).length - 1 !== 1
    ) {
      throw new Error(
        `oauth_migration_receipt_injection_failed:${source.version}`,
      );
    }
    executableSource = executableSource.replace(
      qualificationAssertion,
      () => [
        qualificationAssertion,
        "",
        "-- boss_paegi_oauth_catalog_assertion_pre_contract",
        contractCatalogAssertionSql(catalogIntegrityQuery),
      ].join("\n"),
    );
    executableSource = executableSource.replace(
      boundary,
      () => [
        "-- boss_paegi_oauth_catalog_assertion_post_contract",
        contractCatalogAssertionSql(
          postContractCatalogIntegrityQuery,
        ),
        "",
        boundary,
      ].join("\n"),
    );
  } else if (source.version === OAUTH_POST_CONTRACT_MIGRATION) {
    if (
      qualification !== null ||
      markerCount !== 0 ||
      postContractMarkerCount !== 1 ||
      catalogIntegrityQuery === null ||
      postContractCatalogIntegrityQuery === null
    ) {
      throw new Error(
        `oauth_migration_receipt_injection_failed:${source.version}`,
      );
    }
    injectedSnippets.push(
      contractCatalogAssertionSql(catalogIntegrityQuery),
      contractCatalogAssertionSql(postContractCatalogIntegrityQuery),
    );
    executableSource = executableSource.replace(
      `${OAUTH_POST_CONTRACT_CATALOG_MARKER}\n${OAUTH_POST_CONTRACT_RAW_GUARD}`,
      () => [
        catalogLocks,
        "",
        "-- boss_paegi_oauth_catalog_assertion_pre_post_contract",
        contractCatalogAssertionSql(catalogIntegrityQuery),
      ].join("\n"),
    );
    executableSource = executableSource.replace(
      boundary,
      () => [
        "-- boss_paegi_oauth_catalog_assertion_post_post_contract",
        contractCatalogAssertionSql(
          postContractCatalogIntegrityQuery,
        ),
        "",
        boundary,
      ].join("\n"),
    );
  } else {
    if (
      qualification !== null ||
      catalogIntegrityQuery === null ||
      postContractCatalogIntegrityQuery !== null ||
      markerCount !== 0 ||
      postContractMarkerCount !== 0
    ) {
      throw new Error(
        `oauth_migration_receipt_injection_failed:${source.version}`,
      );
    }
    injectedSnippets.push(
      contractCatalogAssertionSql(catalogIntegrityQuery),
    );
    executableSource = executableSource.replace(
      boundary,
      () => [
        catalogLocks,
        "",
        "-- boss_paegi_oauth_catalog_assertion_expand",
        contractCatalogAssertionSql(catalogIntegrityQuery),
        "",
        boundary,
      ].join("\n"),
    );
  }
  const receipt = [
    "notify pgrst, 'reload schema';",
    "",
    "insert into public.schema_migration_journal (",
    "  version, migration_hash, manifest_hash, app_commit, applied_at",
    ") values (",
    `  '${source.version}',`,
    `  '${source.migrationHash}',`,
    `  '${source.manifestHash}',`,
    `  '${appCommit}',`,
    "  pg_catalog.clock_timestamp()",
    ");",
    "commit;",
  ].join("\n");
  const executable = executableSource.replace(boundary, () => receipt);
  if (
    executable === source.sql ||
    !executable.includes(`'${source.version}'`) ||
    executable.includes(OAUTH_CONTRACT_QUALIFICATION_MARKER) ||
    executable.includes(OAUTH_POST_CONTRACT_CATALOG_MARKER) ||
    executable.includes(OAUTH_POST_CONTRACT_RAW_GUARD) ||
    (
      executable.match(
        /insert into public\.schema_migration_journal/gu,
      ) ?? []
    ).length !== 1 ||
    // String.replace $-pattern corruption must fail closed: every injected
    // block has to survive byte-for-byte in the executable script.
    !injectedSnippets.every((snippet) => executable.includes(snippet))
  ) {
    throw new Error(`oauth_migration_receipt_injection_failed:${source.version}`);
  }
  return executable;
}

const SNAPSHOT_KEYS = Object.freeze([
  "oauth_table",
  "qualification_table",
  "qualification_rls_enabled",
  "qualification_unexpected_table_privilege",
  "qualification_guard_ready",
  "qualification_guard_unexpected_execute",
  "legacy_receipt_table",
  "legacy_receipt_rls_enabled",
  "legacy_receipt_unexpected_table_privilege",
  "legacy_receipt_guard_ready",
  "legacy_receipt_guard_unexpected_execute",
  "target_generation_schema_ready",
  "target_generation_helper_ready",
  "target_generation_helper_unexpected_execute",
  "oauth_function_bodies_ready",
  "auth_user_generation_fences_ready",
  "auth_session_generation_fence_ready",
  "auth_generation_fence_unexpected_execute",
  "private_table_owners_ready",
  "legacy_bridge_rpc",
  "legacy_bridge_inventory_exact",
  "service_legacy_bridge_execute",
  "anon_legacy_bridge_execute",
  "authenticated_legacy_bridge_execute",
  "public_legacy_bridge_execute",
  "legacy_bridge_unexpected_execute",
  "begin_rpc",
  "recover_rpc",
  "consume_rpc",
  "prune_rpc",
  "scoped_rpcs_ready",
  "scoped_rpc_inventory_exact",
  "scoped_service_execute",
  "scoped_anon_execute",
  "scoped_authenticated_execute",
  "scoped_public_execute",
  "scoped_unexpected_execute",
  "table_rls_enabled",
  "service_table_privilege",
  "anon_table_privilege",
  "authenticated_table_privilege",
  "public_table_privilege",
  "service_raw_execute",
  "anon_raw_execute",
  "authenticated_raw_execute",
  "public_raw_execute",
  "raw_unexpected_execute",
  "analytics_maintenance_bounds_ready",
  "post_contract_owner_only_rpcs_ready",
  "raw_comment",
  "legacy_bridge_comment",
]);

async function readDatabaseSnapshot(
  management,
  fetchImpl,
  expectedFunctionBodies,
  expectedMaintenanceFunctionBodies,
) {
  if (
    !Array.isArray(expectedFunctionBodies) ||
    expectedFunctionBodies.length !==
      OAUTH_CATALOG_FUNCTION_NAMES.length ||
    expectedFunctionBodies.some(
      (entry, index) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !==
          "bodySha256,executeAcl,functionArguments,functionResult,language,name,parallel,securityDefiner,strict,volatility" ||
        entry.name !== OAUTH_CATALOG_FUNCTION_NAMES[index] ||
        !/^[0-9a-f]{64}$/.test(entry.bodySha256) ||
        typeof entry.functionArguments !== "string" ||
        !/^[a-z0-9_, \[\]]*(?:DEFAULT (?:[0-9]+|(?:true|false)|NULL::[a-z ]+))?$/u.test(
          entry.functionArguments,
        ) ||
        ![
          "boolean",
          "jsonb",
          "text",
          "trigger",
          "void",
        ].includes(entry.functionResult) ||
        !["plpgsql", "sql"].includes(entry.language) ||
        typeof entry.securityDefiner !== "boolean" ||
        !["i", "s", "v"].includes(entry.volatility) ||
        typeof entry.strict !== "boolean" ||
        !["r", "s", "u"].includes(entry.parallel) ||
        ![
          "authenticated",
          "owner",
          "owner_or_service",
          "service",
        ].includes(entry.executeAcl),
    )
  ) {
    throw new Error("oauth_function_body_manifest_invalid");
  }
  if (
    !Array.isArray(expectedMaintenanceFunctionBodies) ||
    expectedMaintenanceFunctionBodies.length !==
      ANALYTICS_MAINTENANCE_FUNCTION_NAMES.length ||
    expectedMaintenanceFunctionBodies.some(
      (entry, index) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !==
          "bodySha256,executeAcl,functionArguments,functionResult,language,name,parallel,securityDefiner,strict,volatility" ||
        entry.name !== ANALYTICS_MAINTENANCE_FUNCTION_NAMES[index] ||
        !/^[0-9a-f]{64}$/.test(entry.bodySha256) ||
        typeof entry.functionArguments !== "string" ||
        entry.functionResult !== "jsonb" ||
        entry.language !== "plpgsql" ||
        entry.securityDefiner !== true ||
        entry.volatility !== "v" ||
        entry.strict !== false ||
        entry.parallel !== "u" ||
        entry.executeAcl !== "service",
    )
  ) {
    throw new Error("analytics_maintenance_function_manifest_invalid");
  }
  const expectedFunctionBodyValues = expectedFunctionBodies
    .map(
      ({
        name,
        bodySha256,
        functionArguments,
        functionResult,
        language,
        securityDefiner,
        volatility,
        strict,
        parallel,
        executeAcl,
      }) =>
        `(${sqlLiteral(name)}, ${sqlLiteral(bodySha256)}, ${sqlLiteral(
          functionArguments,
        )}, ${sqlLiteral(functionResult)}, ${sqlLiteral(
          language,
        )}, ${securityDefiner}, ${sqlLiteral(
          volatility,
        )}, ${strict}, ${sqlLiteral(parallel)}, ${sqlLiteral(executeAcl)})`,
    )
    .join(",\n          ");
  const expectedMaintenanceFunctionBodyValues =
    expectedMaintenanceFunctionBodies
      .map(
        ({
          name,
          bodySha256,
          functionArguments,
          functionResult,
          language,
          securityDefiner,
          volatility,
          strict,
          parallel,
          executeAcl,
        }) =>
          `(${sqlLiteral(name)}, ${sqlLiteral(bodySha256)}, ${sqlLiteral(
            functionArguments,
          )}, ${sqlLiteral(functionResult)}, ${sqlLiteral(
            language,
          )}, ${securityDefiner}, ${sqlLiteral(
            volatility,
          )}, ${strict}, ${sqlLiteral(parallel)}, ${sqlLiteral(executeAcl)})`,
      )
      .join(",\n          ");
  const postContractOwnerOnlyRpcValues =
    POST_CONTRACT_OWNER_ONLY_FUNCTION_SIGNATURES.map(
      (signature) =>
        `(pg_catalog.to_regprocedure(${sqlLiteral(signature)}))`,
    ).join(",\n          ");
  const rows = await managementQuery(
    `
      with expected_oauth_function_bodies(
        name,
        body_sha256,
        function_arguments,
        function_result,
        language_name,
        security_definer,
        volatility,
        strict,
        parallel,
        execute_acl
      ) as (
        values
          ${expectedFunctionBodyValues}
      ),
      expected_analytics_maintenance_function_bodies(
        name,
        body_sha256,
        function_arguments,
        function_result,
        language_name,
        security_definer,
        volatility,
        strict,
        parallel,
        execute_acl
      ) as (
        values
          ${expectedMaintenanceFunctionBodyValues}
      ),
      post_contract_owner_only_rpcs(rpc) as (
        values
          ${postContractOwnerOnlyRpcValues}
      ),
      oauth_rpcs(rpc) as (
        values
          (pg_catalog.to_regprocedure(
            'public.begin_oauth_flow_intent(uuid,uuid,uuid,boolean,text,text,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.claim_oauth_flow_intent(uuid,uuid,uuid,text,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.bind_oauth_flow_intent_target(uuid,uuid,uuid,text,uuid,uuid,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.read_oauth_flow_intent_status(uuid,uuid,uuid,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.oauth_anon_privacy_status()'
          )),
          (pg_catalog.to_regprocedure(
            'public.recover_oauth_flow_intent_authority(uuid,uuid,uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.verify_oauth_flow_source_session_evidence(uuid,uuid,uuid,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.verify_oauth_flow_target_session_evidence(uuid,uuid,uuid,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.read_oauth_flow_target_session_evidence(uuid,uuid,uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.rotate_oauth_flow_target_session_evidence(uuid,uuid,uuid,text,text,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.release_oauth_flow_intent(uuid,uuid,uuid,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.finalize_oauth_flow_intent(uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.confirm_oauth_flow_signout_revoke(uuid,uuid,uuid,text,uuid,uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.complete_oauth_flow_signout(uuid,uuid,uuid,text,uuid,uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.complete_recovered_oauth_flow_signout(uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.cancel_oauth_flow_intent(uuid,uuid,uuid,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.abandon_oauth_flow_intent(uuid,uuid,uuid,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.revoke_bound_oauth_flow_target_session(uuid,uuid,uuid,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.expire_oauth_flow_intent(uuid)'
          )),
          (pg_catalog.to_regprocedure(
            'public.consume_oauth_flow_intent_migration(uuid,uuid,uuid,uuid,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.claim_oauth_anon_auth_cleanup(uuid,integer)'
          )),
          (pg_catalog.to_regprocedure(
            'public.verify_oauth_anon_auth_cleanup_source(uuid,uuid,integer)'
          )),
          (pg_catalog.to_regprocedure(
            'public.finish_oauth_anon_auth_cleanup(uuid,uuid,integer,text,text)'
          )),
          (pg_catalog.to_regprocedure(
            'public.prune_oauth_flow_intents(integer)'
          ))
      ),
      oauth_rpc_names(name) as (
        values
          ('begin_oauth_flow_intent'),
          ('claim_oauth_flow_intent'),
          ('bind_oauth_flow_intent_target'),
          ('read_oauth_flow_intent_status'),
          ('oauth_anon_privacy_status'),
          ('recover_oauth_flow_intent_authority'),
          ('recover_active_oauth_flow_by_observed_session'),
          ('verify_oauth_flow_source_session_evidence'),
          ('verify_oauth_flow_target_session_evidence'),
          ('read_oauth_flow_target_session_evidence'),
          ('rotate_oauth_flow_target_session_evidence'),
          ('release_oauth_flow_intent'),
          ('finalize_oauth_flow_intent'),
          ('confirm_oauth_flow_signout_revoke'),
          ('complete_oauth_flow_signout'),
          ('complete_recovered_oauth_flow_signout'),
          ('cancel_oauth_flow_intent'),
          ('abandon_oauth_flow_intent'),
          ('revoke_bound_oauth_flow_target_session'),
          ('expire_oauth_flow_intent'),
          ('consume_oauth_flow_intent_migration'),
          ('claim_oauth_anon_auth_cleanup'),
          ('verify_oauth_anon_auth_cleanup_source'),
          ('finish_oauth_anon_auth_cleanup'),
          ('prune_oauth_flow_intents')
      ),
      actual_oauth_rpcs(rpc) as (
        select p.oid
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n
            on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             select name from oauth_rpc_names
           )
      )
      select
        (
          pg_catalog.to_regclass('public.oauth_flow_intents')
            is not null
          and pg_catalog.to_regclass(
            'public.oauth_anon_auth_cleanup_jobs'
          ) is not null
        ) as oauth_table,
        pg_catalog.to_regclass(
          'public.oauth_rollout_deployment_qualifications'
        ) is not null as qualification_table,
        coalesce(
          (
            select c.relrowsecurity
              from pg_catalog.pg_class c
             where c.oid = pg_catalog.to_regclass(
               'public.oauth_rollout_deployment_qualifications'
             )
          ),
          false
        ) as qualification_rls_enabled,
        exists (
          select 1
            from pg_catalog.pg_class c
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                c.relacl,
                pg_catalog.acldefault('r'::"char", c.relowner)
              )
            ) acl
           where c.oid = pg_catalog.to_regclass(
             'public.oauth_rollout_deployment_qualifications'
           )
             and acl.grantee <> c.relowner
        ) as qualification_unexpected_table_privilege,
        coalesce(
          (
            select
              not t.tgisinternal
              and t.tgenabled = 'O'
              and t.tgtype = 27
              and t.tgqual is null
              and t.tgconstraint = 0
              and t.tgparentid = 0
              and not t.tgdeferrable
              and not t.tginitdeferred
              and t.tgfoid = pg_catalog.to_regprocedure(
                'public.guard_oauth_rollout_deployment_qualification()'
              )
              and pg_catalog.to_regprocedure(
                'public.assert_oauth_rollout_deployment_qualification(text)'
              ) is not null
              from pg_catalog.pg_trigger t
             where t.tgrelid = pg_catalog.to_regclass(
               'public.oauth_rollout_deployment_qualifications'
             )
               and t.tgname =
                 'trg_oauth_rollout_deployment_qualification_append_only'
          ),
          false
        ) as qualification_guard_ready,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid in (
             pg_catalog.to_regprocedure(
               'public.guard_oauth_rollout_deployment_qualification()'
             ),
             pg_catalog.to_regprocedure(
               'public.assert_oauth_rollout_deployment_qualification(text)'
             )
           )
             and acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
        ) as qualification_guard_unexpected_execute,
        pg_catalog.to_regclass(
          'public.legacy_signup_migration_receipts'
        ) is not null as legacy_receipt_table,
        coalesce(
          (
            select c.relrowsecurity
              from pg_catalog.pg_class c
             where c.oid = pg_catalog.to_regclass(
               'public.legacy_signup_migration_receipts'
             )
          ),
          false
        ) as legacy_receipt_rls_enabled,
        exists (
          select 1
            from pg_catalog.pg_class c
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                c.relacl,
                pg_catalog.acldefault('r'::"char", c.relowner)
              )
            ) acl
           where c.oid = pg_catalog.to_regclass(
             'public.legacy_signup_migration_receipts'
           )
             and acl.grantee <> c.relowner
        ) as legacy_receipt_unexpected_table_privilege,
        coalesce(
          (
            select
              not t.tgisinternal
              and t.tgenabled = 'O'
              and t.tgtype = 27
              and t.tgqual is null
              and t.tgconstraint = 0
              and t.tgparentid = 0
              and not t.tgdeferrable
              and not t.tginitdeferred
              and t.tgfoid = pg_catalog.to_regprocedure(
                'public.guard_legacy_signup_migration_receipt()'
              )
              from pg_catalog.pg_trigger t
             where t.tgrelid = pg_catalog.to_regclass(
               'public.legacy_signup_migration_receipts'
             )
               and t.tgname =
                 'trg_legacy_signup_migration_receipt_append_only'
          ),
          false
        ) as legacy_receipt_guard_ready,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid = pg_catalog.to_regprocedure(
             'public.guard_legacy_signup_migration_receipt()'
           )
             and acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
        ) as legacy_receipt_guard_unexpected_execute,
        (
          (
            select
              pg_catalog.count(*) = 3
              and pg_catalog.bool_and(
                case a.attname
                  when 'target_auth_created_at'
                    then pg_catalog.format_type(
                      a.atttypid,
                      a.atttypmod
                    ) = 'timestamp with time zone'
                  when 'target_auth_instance_id'
                    then pg_catalog.format_type(
                      a.atttypid,
                      a.atttypmod
                    ) = 'uuid'
                  when 'target_session_created_at'
                    then pg_catalog.format_type(
                      a.atttypid,
                      a.atttypmod
                    ) = 'timestamp with time zone'
                  else false
                end
                and not a.attnotnull
                and not a.attisdropped
              )
              from pg_catalog.pg_attribute a
             where a.attrelid = pg_catalog.to_regclass(
               'public.oauth_flow_intents'
             )
               and a.attname in (
                 'target_auth_created_at',
                 'target_auth_instance_id',
                 'target_session_created_at'
               )
          )
          and exists (
            select 1
              from pg_catalog.pg_constraint c
             where c.conrelid = pg_catalog.to_regclass(
               'public.oauth_flow_intents'
             )
               and c.conname =
                 'oauth_flow_intents_target_identity_check'
               and c.contype = 'c'
               and c.convalidated
               and pg_catalog.pg_get_expr(
                 c.conbin,
                 c.conrelid
               ) = ${sqlLiteral(
                 OAUTH_TARGET_IDENTITY_CONSTRAINT_EXPRESSION,
               )}
          )
        ) as target_generation_schema_ready,
        coalesce(
          (
            select
              p.prosecdef
              and coalesce(p.proconfig, '{}'::text[])
                @> array['search_path=""']
              and p.prorettype = 'boolean'::regtype
              from pg_catalog.pg_proc p
             where p.oid = pg_catalog.to_regprocedure(
               'public.bp_0093_oauth_target_generation_matches(uuid,uuid,uuid,timestamptz,uuid,timestamptz)'
             )
          ),
          false
        ) as target_generation_helper_ready,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid = pg_catalog.to_regprocedure(
             'public.bp_0093_oauth_target_generation_matches(uuid,uuid,uuid,timestamptz,uuid,timestamptz)'
           )
             and acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
        ) as target_generation_helper_unexpected_execute,
        (
          select
            pg_catalog.count(*) =
              ${OAUTH_CATALOG_FUNCTION_NAMES.length}
            and pg_catalog.count(p.oid) =
              ${OAUTH_CATALOG_FUNCTION_NAMES.length}
            and coalesce(
              pg_catalog.bool_and(
                pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(p.prosrc, 'UTF8')
                  ),
                  'hex'
                ) = expected.body_sha256
                and pg_catalog.pg_get_function_arguments(p.oid) =
                  expected.function_arguments
                and pg_catalog.pg_get_function_result(p.oid) =
                  expected.function_result
                and p.prosecdef = expected.security_definer
                and p.prolang = (
                  select language.oid
                    from pg_catalog.pg_language language
                   where language.lanname = expected.language_name
                )
                and coalesce(p.proconfig, '{}'::text[]) =
                  array['search_path=""']::text[]
                and p.provolatile = expected.volatility::"char"
                and p.proisstrict = expected.strict
                and p.proparallel = expected.parallel::"char"
                and not p.proleakproof
                and not p.proretset
                and p.prokind = 'f'
                and pg_catalog.pg_get_userbyid(p.proowner) =
                  'postgres'
                and (
                  select case expected.execute_acl
                    when 'owner' then pg_catalog.count(*) = 0
                    when 'authenticated' then
                      pg_catalog.count(*) = 1
                      and pg_catalog.count(*) filter (
                        where acl.grantee = coalesce(
                          (
                            select role.oid
                              from pg_catalog.pg_roles role
                             where role.rolname = 'authenticated'
                          ),
                          0
                        )
                          and not acl.is_grantable
                      ) = 1
                    when 'service' then
                      pg_catalog.count(*) = 1
                      and pg_catalog.count(*) filter (
                        where acl.grantee = coalesce(
                          (
                            select role.oid
                              from pg_catalog.pg_roles role
                             where role.rolname = 'service_role'
                          ),
                          0
                        )
                          and not acl.is_grantable
                      ) = 1
                    when 'owner_or_service' then
                      pg_catalog.count(*) = 0
                      or (
                        pg_catalog.count(*) = 1
                        and pg_catalog.count(*) filter (
                          where acl.grantee = coalesce(
                            (
                              select role.oid
                                from pg_catalog.pg_roles role
                               where role.rolname = 'service_role'
                            ),
                            0
                          )
                            and not acl.is_grantable
                        ) = 1
                      )
                    else false
                  end
                      from pg_catalog.aclexplode(
                        coalesce(
                          p.proacl,
                          pg_catalog.acldefault(
                            'f'::"char",
                            p.proowner
                          )
                        )
                      ) acl
                     where acl.grantee <> p.proowner
                       and acl.privilege_type = 'EXECUTE'
                )
              ),
              false
            )
            from expected_oauth_function_bodies expected
            left join pg_catalog.pg_namespace n
              on n.nspname = 'public'
            left join pg_catalog.pg_proc p
              on p.pronamespace = n.oid
             and p.proname = expected.name
        ) as oauth_function_bodies_ready,
        (
          select
            pg_catalog.count(*) = 3
            and pg_catalog.bool_and(
              not t.tgisinternal
              and t.tgenabled = 'O'
              and t.tgqual is null
              and t.tgconstraint = 0
              and t.tgparentid = 0
              and not t.tgdeferrable
              and not t.tginitdeferred
              and (
                (
                  t.tgname =
                    'trg_auth_users_fence_oauth_anon_cleanup_insert'
                  and t.tgtype = 7
                  and t.tgfoid = pg_catalog.to_regprocedure(
                    'public.fence_oauth_anon_auth_cleanup_user()'
                  )
                )
                or (
                  t.tgname =
                    'trg_auth_users_fence_oauth_anon_cleanup_update'
                  and t.tgtype = 19
                  and t.tgfoid = pg_catalog.to_regprocedure(
                    'public.fence_oauth_anon_auth_cleanup_user()'
                  )
                  and (
                    select pg_catalog.array_agg(
                      a.attname
                      order by a.attname
                    )
                      from pg_catalog.pg_attribute a
                     where a.attrelid = t.tgrelid
                       and a.attnum = any(
                         t.tgattr::smallint[]
                       )
                  ) = array[
                    'created_at',
                    'id',
                    'instance_id',
                    'is_anonymous'
                  ]::name[]
                )
                or (
                  t.tgname =
                    'trg_auth_users_fence_oauth_retained_anon_delete'
                  and t.tgtype = 11
                  and t.tgfoid = pg_catalog.to_regprocedure(
                    'public.fence_oauth_retained_anon_auth_delete()'
                  )
                )
              )
            )
            from pg_catalog.pg_trigger t
           where t.tgrelid = pg_catalog.to_regclass('auth.users')
             and t.tgname in (
               'trg_auth_users_fence_oauth_anon_cleanup_insert',
               'trg_auth_users_fence_oauth_anon_cleanup_update',
               'trg_auth_users_fence_oauth_retained_anon_delete'
             )
        ) as auth_user_generation_fences_ready,
        coalesce(
          (
            select
              not t.tgisinternal
              and t.tgenabled = 'O'
              and t.tgtype = 23
              and t.tgqual is null
              and t.tgconstraint = 0
              and t.tgparentid = 0
              and not t.tgdeferrable
              and not t.tginitdeferred
              and t.tgfoid = pg_catalog.to_regprocedure(
                'public.fence_revoked_oauth_target_session_id()'
              )
              and (
                select pg_catalog.array_agg(
                  a.attname
                  order by a.attname
                )
                  from pg_catalog.pg_attribute a
                 where a.attrelid = t.tgrelid
                   and a.attnum = any(
                     t.tgattr::smallint[]
                   )
              ) = array[
                'created_at',
                'id',
                'user_id'
              ]::name[]
              from pg_catalog.pg_trigger t
             where t.tgrelid =
               pg_catalog.to_regclass('auth.sessions')
               and t.tgname =
                 'trg_auth_sessions_fence_revoked_oauth_target_id'
          ),
          false
        ) as auth_session_generation_fence_ready,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid in (
             pg_catalog.to_regprocedure(
               'public.fence_oauth_anon_auth_cleanup_user()'
             ),
             pg_catalog.to_regprocedure(
               'public.fence_oauth_retained_anon_auth_delete()'
             ),
             pg_catalog.to_regprocedure(
               'public.fence_revoked_oauth_target_session_id()'
             )
           )
             and acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
        ) as auth_generation_fence_unexpected_execute,
        (
          (
            select
              pg_catalog.count(*) = 8
              and pg_catalog.count(c.oid) = 8
              and coalesce(
                pg_catalog.bool_and(
                  pg_catalog.pg_get_userbyid(c.relowner) =
                    'postgres'
                  and c.relkind = 'r'
                  and c.relrowsecurity
                  and not c.relforcerowsecurity
                  and not exists (
                    select 1
                      from pg_catalog.pg_policy policy
                     where policy.polrelid = c.oid
                  )
                  and not exists (
                    select 1
                      from pg_catalog.aclexplode(
                        coalesce(
                          c.relacl,
                          pg_catalog.acldefault(
                            'r'::"char",
                            c.relowner
                          )
                        )
                      ) acl
                     where acl.grantee <> c.relowner
                  )
                ),
                false
              )
              from (
                values
                  ('public.anon_data_reassignments'),
                  ('public.oauth_flow_intents'),
                  ('public.oauth_anon_auth_cleanup_jobs'),
                  ('public.oauth_quarantined_score_highlights'),
                  ('public.oauth_deidentified_score_owner_tombstones'),
                  ('public.oauth_auth_session_id_tombstones'),
                  ('public.legacy_signup_migration_receipts'),
                  ('public.oauth_rollout_deployment_qualifications')
              ) expected(relation_name)
              left join pg_catalog.pg_class c
                on c.oid = pg_catalog.to_regclass(
                  expected.relation_name
                )
          )
          and coalesce(
            (
              select
                pg_catalog.pg_get_userbyid(c.relowner) =
                  'postgres'
                and c.relkind = 'r'
                and c.relrowsecurity
                and not c.relforcerowsecurity
                and not exists (
                  select 1
                    from pg_catalog.pg_policy policy
                   where policy.polrelid = c.oid
                )
                and (
                  select
                    pg_catalog.count(*) filter (
                      where acl.grantee <> c.relowner
                    ) = 1
                    and pg_catalog.count(*) filter (
                      where acl.grantee <> c.relowner
                        and acl.grantee = coalesce(
                        (
                          select role.oid
                            from pg_catalog.pg_roles role
                           where role.rolname = 'service_role'
                        ),
                        0
                      )
                        and acl.privilege_type = 'SELECT'
                        and not acl.is_grantable
                    ) = 1
                  from pg_catalog.aclexplode(
                    coalesce(
                      c.relacl,
                      pg_catalog.acldefault(
                        'r'::"char",
                        c.relowner
                      )
                    )
                  ) acl
                )
                from pg_catalog.pg_class c
               where c.oid = pg_catalog.to_regclass(
                 'public.schema_migration_journal'
               )
            ),
            false
          )
          and (
            select
              pg_catalog.count(*) = 1
              and coalesce(
                pg_catalog.bool_and(
                  c.contype = 'u'
                  and c.convalidated
                  and not c.condeferrable
                  and not c.condeferred
                  and (
                    select pg_catalog.array_agg(
                      a.attname
                      order by key.ordinality
                    )
                      from pg_catalog.unnest(c.conkey)
                        with ordinality as key(attnum, ordinality)
                      join pg_catalog.pg_attribute a
                        on a.attrelid = c.conrelid
                       and a.attnum = key.attnum
                  ) = array['target_user_id']::name[]
                  and exists (
                    select 1
                      from pg_catalog.pg_index i
                     where i.indexrelid = c.conindid
                       and i.indrelid = c.conrelid
                       and i.indisunique
                       and i.indisvalid
                       and i.indisready
                       and i.indnkeyatts = 1
                       and i.indnatts = 1
                       and i.indpred is null
                       and i.indexprs is null
                  )
                ),
                false
              )
              from pg_catalog.pg_constraint c
             where c.conrelid = pg_catalog.to_regclass(
               'public.anon_data_reassignments'
             )
               and c.conname =
                 'anon_data_reassignments_target_user_id_key'
          )
          and (
            select
              pg_catalog.count(*) = 1
              and coalesce(
                pg_catalog.bool_and(
                  c.contype = 'c'
                  and c.convalidated
                  and not c.connoinherit
                  and pg_catalog.pg_get_expr(
                    c.conbin,
                    c.conrelid
                  ) = ${sqlLiteral(
                    OAUTH_ANON_RESULT_CONSTRAINT_EXPRESSION,
                  )}
                ),
                false
              )
              from pg_catalog.pg_constraint c
             where c.conrelid = pg_catalog.to_regclass(
               'public.anon_data_reassignments'
             )
               and c.conname =
                 'anon_data_reassignments_result_check'
          )
          and (
            select
              pg_catalog.count(*) = 3
              and coalesce(
                pg_catalog.bool_and(
                  case a.attname
                    when 'source_user_id' then
                      pg_catalog.format_type(
                        a.atttypid,
                        a.atttypmod
                      ) = 'uuid'
                    when 'deidentified_at' then
                      pg_catalog.format_type(
                        a.atttypid,
                        a.atttypmod
                      ) = 'timestamp with time zone'
                    when 'reason' then
                      pg_catalog.format_type(
                        a.atttypid,
                        a.atttypmod
                      ) = 'text'
                    else false
                  end
                  and a.attnotnull
                  and not a.atthasdef
                  and a.attidentity = ''
                  and a.attgenerated = ''
                ),
                false
              )
              from pg_catalog.pg_attribute a
             where a.attrelid = pg_catalog.to_regclass(
               'public.oauth_deidentified_score_owner_tombstones'
             )
               and a.attnum > 0
               and not a.attisdropped
          )
          and (
            select
              pg_catalog.count(*) = 1
              and coalesce(
                pg_catalog.bool_and(
                  c.contype = 'p'
                  and c.convalidated
                  and not c.condeferrable
                  and not c.condeferred
                  and (
                    select pg_catalog.array_agg(
                      a.attname
                      order by key.ordinality
                    )
                      from pg_catalog.unnest(c.conkey)
                        with ordinality as key(attnum, ordinality)
                      join pg_catalog.pg_attribute a
                        on a.attrelid = c.conrelid
                       and a.attnum = key.attnum
                  ) = array['source_user_id']::name[]
                  and exists (
                    select 1
                      from pg_catalog.pg_index i
                      join pg_catalog.pg_class index_relation
                        on index_relation.oid = i.indexrelid
                      join pg_catalog.pg_am access_method
                        on access_method.oid =
                          index_relation.relam
                     where i.indexrelid = c.conindid
                       and i.indrelid = c.conrelid
                       and i.indisprimary
                       and i.indisunique
                       and i.indisvalid
                       and i.indisready
                       and i.indnkeyatts = 1
                       and i.indnatts = 1
                       and i.indpred is null
                       and i.indexprs is null
                       and access_method.amname = 'btree'
                  )
                ),
                false
              )
              from pg_catalog.pg_constraint c
             where c.conrelid = pg_catalog.to_regclass(
               'public.oauth_deidentified_score_owner_tombstones'
             )
               and c.conname =
                 'oauth_deidentified_score_owner_tombstones_pkey'
          )
          and (
            select
              pg_catalog.count(*) = 1
              and coalesce(
                pg_catalog.bool_and(
                  c.contype = 'c'
                  and c.convalidated
                  and not c.connoinherit
                  and pg_catalog.pg_get_expr(
                    c.conbin,
                    c.conrelid
                  ) = ${sqlLiteral(
                    OAUTH_DEIDENTIFIED_REASON_CONSTRAINT_EXPRESSION,
                  )}
                ),
                false
              )
              from pg_catalog.pg_constraint c
             where c.conrelid = pg_catalog.to_regclass(
               'public.oauth_deidentified_score_owner_tombstones'
             )
               and c.conname =
                 'oauth_deidentified_score_owner_tombstones_reason_check'
          )
          and (
            select pg_catalog.count(*) = 2
              from pg_catalog.pg_trigger t
             where t.tgrelid = pg_catalog.to_regclass(
               'public.oauth_deidentified_score_owner_tombstones'
             )
               and not t.tgisinternal
          )
          and (
            select
              pg_catalog.count(*) = 3
              and pg_catalog.count(t.oid) = 3
              and coalesce(
                pg_catalog.bool_and(
                  not t.tgisinternal
                  and t.tgenabled = 'O'
                  and t.tgtype = expected.trigger_type
                  and t.tgqual is null
                  and t.tgconstraint = 0
                  and t.tgparentid = 0
                  and not t.tgdeferrable
                  and not t.tginitdeferred
                  and t.tgfoid = pg_catalog.to_regprocedure(
                    expected.function_signature
                  )
                ),
                false
              )
              from (
                values
                  (
                    'public.anon_data_reassignments',
                    'trg_anon_data_reassignment_append_only',
                    'public.guard_anon_data_reassignment_append_only()',
                    27
                  ),
                  (
                    'public.oauth_deidentified_score_owner_tombstones',
                    'trg_oauth_deidentified_score_owner_tombstone_append_only',
                    'public.guard_oauth_deidentified_score_owner_tombstone()',
                    27
                  ),
                  (
                    'public.profiles',
                    'trg_profiles_guard_oauth_deidentified_score_owner_delete',
                    'public.guard_oauth_deidentified_score_owner_profile_delete()',
                    11
                  )
              ) expected(
                relation_name,
                trigger_name,
                function_signature,
                trigger_type
              )
              left join pg_catalog.pg_trigger t
                on t.tgrelid = pg_catalog.to_regclass(
                  expected.relation_name
                )
               and t.tgname = expected.trigger_name
          )
          and (
            select
              pg_catalog.count(*) = 8
              and pg_catalog.count(t.oid) = 8
              and (
                select pg_catalog.count(*) = 8
                  from pg_catalog.pg_trigger actual
                 where actual.tgname =
                   'trg_oauth_critical_relation_truncate'
                   and not actual.tgisinternal
              )
              and coalesce(
                pg_catalog.bool_and(
                  not t.tgisinternal
                  and t.tgenabled = 'O'
                  and t.tgtype = 34
                  and t.tgqual is null
                  and t.tgconstraint = 0
                  and t.tgparentid = 0
                  and not t.tgdeferrable
                  and not t.tginitdeferred
                  and t.tgfoid = pg_catalog.to_regprocedure(
                    'public.guard_oauth_critical_relation_truncate()'
                  )
                  and pg_catalog.cardinality(
                    t.tgattr::smallint[]
                  ) = 0
                ),
                false
              )
              from (
                values
                  ('public.anon_data_reassignments'),
                  ('public.oauth_flow_intents'),
                  ('public.oauth_anon_auth_cleanup_jobs'),
                  ('public.oauth_quarantined_score_highlights'),
                  ('public.oauth_deidentified_score_owner_tombstones'),
                  ('public.oauth_auth_session_id_tombstones'),
                  ('public.legacy_signup_migration_receipts'),
                  ('public.oauth_rollout_deployment_qualifications')
              ) expected(relation_name)
              left join pg_catalog.pg_trigger t
                on t.tgrelid = pg_catalog.to_regclass(
                  expected.relation_name
                )
               and t.tgname =
                 'trg_oauth_critical_relation_truncate'
          )
        ) as private_table_owners_ready,
        pg_catalog.to_regprocedure(
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
        ) is not null as legacy_bridge_rpc,
        (
          select
            pg_catalog.count(*) = 1
            and pg_catalog.count(*) filter (
              where p.oid = pg_catalog.to_regprocedure(
                'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
              )
            ) = 1
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n
              on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'consume_legacy_signup_migration'
        ) as legacy_bridge_inventory_exact,
        coalesce(
          pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure(
              'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
            ),
            'EXECUTE'
          ),
          false
        ) as service_legacy_bridge_execute,
        coalesce(
          pg_catalog.has_function_privilege(
            'anon',
            pg_catalog.to_regprocedure(
              'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
            ),
            'EXECUTE'
          ),
          false
        ) as anon_legacy_bridge_execute,
        coalesce(
          pg_catalog.has_function_privilege(
            'authenticated',
            pg_catalog.to_regprocedure(
              'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
            ),
            'EXECUTE'
          ),
          false
        ) as authenticated_legacy_bridge_execute,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid = pg_catalog.to_regprocedure(
             'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
           )
             and acl.grantee = 0
             and acl.privilege_type = 'EXECUTE'
        ) as public_legacy_bridge_execute,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid = pg_catalog.to_regprocedure(
             'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
           )
             and acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
             and acl.grantee <> coalesce(
               (
                 select role.oid
                   from pg_catalog.pg_roles role
                  where role.rolname = 'service_role'
               ),
               0
             )
        ) as legacy_bridge_unexpected_execute,
        pg_catalog.to_regprocedure(
          'public.begin_oauth_flow_intent(uuid,uuid,uuid,boolean,text,text,text,text)'
        ) is not null as begin_rpc,
        pg_catalog.to_regprocedure(
          'public.recover_active_oauth_flow_by_observed_session(uuid,uuid)'
        ) is not null as recover_rpc,
        pg_catalog.to_regprocedure(
          'public.consume_oauth_flow_intent_migration(uuid,uuid,uuid,uuid,text,text)'
        ) is not null as consume_rpc,
        pg_catalog.to_regprocedure(
          'public.prune_oauth_flow_intents(integer)'
        ) is not null as prune_rpc,
        (
          select pg_catalog.count(rpc) = 25
            from oauth_rpcs
        ) as scoped_rpcs_ready,
        (
          (
            select pg_catalog.count(rpc) = 25
              from oauth_rpcs
          )
          and
          (
            select
              pg_catalog.count(*) = 25
              and pg_catalog.count(expected.rpc) = 25
              from actual_oauth_rpcs actual
              left join oauth_rpcs expected
                on expected.rpc = actual.rpc
          )
        ) as scoped_rpc_inventory_exact,
        (
          select pg_catalog.count(rpc) = 25
             and coalesce(
                   pg_catalog.bool_and(
                     pg_catalog.has_function_privilege(
                       'service_role',
                       rpc,
                       'EXECUTE'
                     )
                   ),
                   false
                 )
            from oauth_rpcs
        ) as scoped_service_execute,
        exists (
          select 1
            from oauth_rpcs
           where coalesce(
             pg_catalog.has_function_privilege(
               'anon',
               rpc,
               'EXECUTE'
             ),
             false
           )
        ) as scoped_anon_execute,
        exists (
          select 1
            from oauth_rpcs
           where coalesce(
             pg_catalog.has_function_privilege(
               'authenticated',
               rpc,
               'EXECUTE'
             ),
             false
           )
        ) as scoped_authenticated_execute,
        exists (
          select 1
            from oauth_rpcs r
            join pg_catalog.pg_proc p
              on p.oid = r.rpc
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where acl.grantee = 0
             and acl.privilege_type = 'EXECUTE'
        ) as scoped_public_execute,
        exists (
          select 1
            from oauth_rpcs r
            join pg_catalog.pg_proc p
              on p.oid = r.rpc
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
             and acl.grantee <> coalesce(
               (
                 select role.oid
                   from pg_catalog.pg_roles role
                  where role.rolname = 'service_role'
               ),
               0
             )
        ) as scoped_unexpected_execute,
        (
          coalesce(
            (
              select c.relrowsecurity
                from pg_catalog.pg_class c
               where c.oid =
                 pg_catalog.to_regclass('public.oauth_flow_intents')
            ),
            false
          )
          and coalesce(
            (
              select c.relrowsecurity
                from pg_catalog.pg_class c
               where c.oid = pg_catalog.to_regclass(
                 'public.oauth_anon_auth_cleanup_jobs'
               )
            ),
            false
          )
        ) as table_rls_enabled,
        (
          coalesce(
            pg_catalog.has_table_privilege(
              'service_role',
              pg_catalog.to_regclass('public.oauth_flow_intents'),
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ),
            false
          )
          or coalesce(
            pg_catalog.has_table_privilege(
              'service_role',
              pg_catalog.to_regclass(
                'public.oauth_anon_auth_cleanup_jobs'
              ),
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ),
            false
          )
        ) as service_table_privilege,
        (
          coalesce(
            pg_catalog.has_table_privilege(
              'anon',
              pg_catalog.to_regclass('public.oauth_flow_intents'),
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ),
            false
          )
          or coalesce(
            pg_catalog.has_table_privilege(
              'anon',
              pg_catalog.to_regclass(
                'public.oauth_anon_auth_cleanup_jobs'
              ),
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ),
            false
          )
        ) as anon_table_privilege,
        (
          coalesce(
            pg_catalog.has_table_privilege(
              'authenticated',
              pg_catalog.to_regclass('public.oauth_flow_intents'),
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ),
            false
          )
          or coalesce(
            pg_catalog.has_table_privilege(
              'authenticated',
              pg_catalog.to_regclass(
                'public.oauth_anon_auth_cleanup_jobs'
              ),
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ),
            false
          )
        ) as authenticated_table_privilege,
        exists (
          select 1
            from pg_catalog.pg_class c
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                c.relacl,
                pg_catalog.acldefault('r'::"char", c.relowner)
              )
            ) acl
           where c.oid in (
             pg_catalog.to_regclass('public.oauth_flow_intents'),
             pg_catalog.to_regclass(
               'public.oauth_anon_auth_cleanup_jobs'
             )
           )
             and acl.grantee = 0
        ) as public_table_privilege,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.reassign_anon_data(uuid,uuid)',
          'EXECUTE'
        ) as service_raw_execute,
        pg_catalog.has_function_privilege(
          'anon',
          'public.reassign_anon_data(uuid,uuid)',
          'EXECUTE'
        ) as anon_raw_execute,
        pg_catalog.has_function_privilege(
          'authenticated',
          'public.reassign_anon_data(uuid,uuid)',
          'EXECUTE'
        ) as authenticated_raw_execute,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid =
             'public.reassign_anon_data(uuid,uuid)'::regprocedure
             and acl.grantee = 0
             and acl.privilege_type = 'EXECUTE'
        ) as public_raw_execute,
        exists (
          select 1
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                p.proacl,
                pg_catalog.acldefault('f'::"char", p.proowner)
              )
            ) acl
           where p.oid =
             'public.reassign_anon_data(uuid,uuid)'::regprocedure
             and acl.privilege_type = 'EXECUTE'
             and acl.grantee <> p.proowner
             and acl.grantee <> coalesce(
               (
                 select role.oid
                   from pg_catalog.pg_roles role
                  where role.rolname = 'service_role'
               ),
               0
             )
        ) as raw_unexpected_execute,
        (
          select
            pg_catalog.count(*) =
              ${ANALYTICS_MAINTENANCE_FUNCTION_NAMES.length}
            and pg_catalog.count(p.oid) =
              ${ANALYTICS_MAINTENANCE_FUNCTION_NAMES.length}
            and coalesce(
              pg_catalog.bool_and(
                pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(p.prosrc, 'UTF8')
                  ),
                  'hex'
                ) = expected.body_sha256
                and pg_catalog.pg_get_function_arguments(p.oid) =
                  expected.function_arguments
                and pg_catalog.pg_get_function_result(p.oid) =
                  expected.function_result
                and p.prosecdef = expected.security_definer
                and p.prolang = (
                  select language.oid
                    from pg_catalog.pg_language language
                   where language.lanname = expected.language_name
                )
                and coalesce(p.proconfig, '{}'::text[]) =
                  array['search_path=public']::text[]
                and p.provolatile = expected.volatility::"char"
                and p.proisstrict = expected.strict
                and p.proparallel = expected.parallel::"char"
                and not p.proleakproof
                and not p.proretset
                and p.prokind = 'f'
                and pg_catalog.pg_get_userbyid(p.proowner) =
                  'postgres'
                and (
                  select
                    pg_catalog.count(*) = 1
                    and pg_catalog.count(*) filter (
                      where acl.grantee = coalesce(
                        (
                          select role.oid
                            from pg_catalog.pg_roles role
                           where role.rolname = 'service_role'
                        ),
                        0
                      )
                        and not acl.is_grantable
                    ) = 1
                    from pg_catalog.aclexplode(
                      coalesce(
                        p.proacl,
                        pg_catalog.acldefault(
                          'f'::"char",
                          p.proowner
                        )
                      )
                    ) acl
                   where acl.grantee <> p.proowner
                     and acl.privilege_type = 'EXECUTE'
                )
              ),
              false
            )
            from expected_analytics_maintenance_function_bodies
              expected
            left join pg_catalog.pg_namespace n
              on n.nspname = 'public'
            left join pg_catalog.pg_proc p
              on p.pronamespace = n.oid
             and p.proname = expected.name
        ) as analytics_maintenance_bounds_ready,
        (
          select
            pg_catalog.count(*) =
              ${POST_CONTRACT_OWNER_ONLY_FUNCTION_SIGNATURES.length}
            and pg_catalog.count(p.oid) =
              ${POST_CONTRACT_OWNER_ONLY_FUNCTION_SIGNATURES.length}
            and coalesce(
              pg_catalog.bool_and(
                pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
                and not exists (
                  select 1
                    from pg_catalog.aclexplode(
                      coalesce(
                        p.proacl,
                        pg_catalog.acldefault(
                          'f'::"char",
                          p.proowner
                        )
                      )
                    ) acl
                   where acl.privilege_type = 'EXECUTE'
                     and acl.grantee <> p.proowner
                )
              ),
              false
            )
            from post_contract_owner_only_rpcs expected
            left join pg_catalog.pg_proc p
              on p.oid = expected.rpc
        ) as post_contract_owner_only_rpcs_ready,
        pg_catalog.obj_description(
          'public.reassign_anon_data(uuid,uuid)'::regprocedure,
          'pg_proc'
        ) as raw_comment,
        pg_catalog.obj_description(
          pg_catalog.to_regprocedure(
            'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'
          ),
          'pg_proc'
        ) as legacy_bridge_comment
    `,
    management,
    fetchImpl,
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== "object" ||
    Array.isArray(rows[0]) ||
    Object.keys(rows[0]).sort().join(",") !==
      [...SNAPSHOT_KEYS].sort().join(",")
  ) {
    throw new Error("oauth_database_snapshot_invalid");
  }
  const row = rows[0];
  for (const key of SNAPSHOT_KEYS.slice(0, -2)) {
    if (typeof row[key] !== "boolean") {
      throw new Error("oauth_database_snapshot_invalid");
    }
  }
  if (row.raw_comment !== null && typeof row.raw_comment !== "string") {
    throw new Error("oauth_database_snapshot_invalid");
  }
  if (
    row.legacy_bridge_comment !== null &&
    typeof row.legacy_bridge_comment !== "string"
  ) {
    throw new Error("oauth_database_snapshot_invalid");
  }
  return row;
}

export function classifyOAuthDatabaseStage(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return "invalid";
  }
  const functionsReady =
    snapshot.oauth_table === true &&
    snapshot.qualification_table === true &&
    snapshot.begin_rpc === true &&
    snapshot.recover_rpc === true &&
    snapshot.consume_rpc === true &&
    snapshot.prune_rpc === true;
  const scopedSurfacePrivate =
    snapshot.scoped_rpcs_ready === true &&
    snapshot.scoped_rpc_inventory_exact === true &&
    snapshot.scoped_service_execute === true &&
    snapshot.scoped_anon_execute === false &&
    snapshot.scoped_authenticated_execute === false &&
    snapshot.scoped_public_execute === false &&
    snapshot.scoped_unexpected_execute === false &&
    snapshot.table_rls_enabled === true &&
    snapshot.service_table_privilege === false &&
    snapshot.anon_table_privilege === false &&
    snapshot.authenticated_table_privilege === false &&
    snapshot.public_table_privilege === false;
  const qualificationPrivate =
    snapshot.qualification_rls_enabled === true &&
    snapshot.qualification_unexpected_table_privilege === false &&
    snapshot.qualification_guard_ready === true &&
    snapshot.qualification_guard_unexpected_execute === false;
  const legacyReceiptPrivate =
    snapshot.legacy_receipt_table === true &&
    snapshot.legacy_receipt_rls_enabled === true &&
    snapshot.legacy_receipt_unexpected_table_privilege === false &&
    snapshot.legacy_receipt_guard_ready === true &&
    snapshot.legacy_receipt_guard_unexpected_execute === false;
  const targetGenerationFenced =
    snapshot.target_generation_schema_ready === true &&
    snapshot.target_generation_helper_ready === true &&
    snapshot.target_generation_helper_unexpected_execute === false &&
    snapshot.oauth_function_bodies_ready === true &&
    snapshot.auth_user_generation_fences_ready === true &&
    snapshot.auth_session_generation_fence_ready === true &&
    snapshot.auth_generation_fence_unexpected_execute === false &&
    snapshot.private_table_owners_ready === true;
  const legacyBridgePrivate =
    snapshot.legacy_bridge_rpc === true &&
    snapshot.legacy_bridge_inventory_exact === true &&
    snapshot.anon_legacy_bridge_execute === false &&
    snapshot.authenticated_legacy_bridge_execute === false &&
    snapshot.public_legacy_bridge_execute === false &&
    snapshot.legacy_bridge_unexpected_execute === false;
  const rawPrivate =
    snapshot.anon_raw_execute === false &&
    snapshot.authenticated_raw_execute === false &&
    snapshot.public_raw_execute === false &&
    snapshot.raw_unexpected_execute === false;
  if (
    functionsReady &&
    scopedSurfacePrivate &&
    qualificationPrivate &&
    legacyReceiptPrivate &&
    targetGenerationFenced &&
    legacyBridgePrivate &&
    rawPrivate &&
    snapshot.service_raw_execute === true &&
    snapshot.raw_comment === null &&
    snapshot.service_legacy_bridge_execute === true &&
    snapshot.legacy_bridge_comment === null
  ) {
    return "expand";
  }
  if (
    functionsReady &&
    scopedSurfacePrivate &&
    qualificationPrivate &&
    legacyReceiptPrivate &&
    targetGenerationFenced &&
    legacyBridgePrivate &&
    rawPrivate &&
    snapshot.service_raw_execute === false &&
    snapshot.raw_comment === CONTRACT_COMMENT &&
    snapshot.service_legacy_bridge_execute === false &&
    snapshot.legacy_bridge_comment ===
      LEGACY_BRIDGE_CONTRACT_COMMENT
  ) {
    return "contract";
  }
  if (
    snapshot.oauth_table === false &&
    snapshot.qualification_table === false &&
    snapshot.qualification_rls_enabled === false &&
    snapshot.qualification_unexpected_table_privilege === false &&
    snapshot.qualification_guard_ready === false &&
    snapshot.qualification_guard_unexpected_execute === false &&
    snapshot.legacy_receipt_table === false &&
    snapshot.legacy_receipt_rls_enabled === false &&
    snapshot.legacy_receipt_unexpected_table_privilege === false &&
    snapshot.legacy_receipt_guard_ready === false &&
    snapshot.legacy_receipt_guard_unexpected_execute === false &&
    snapshot.target_generation_schema_ready === false &&
    snapshot.target_generation_helper_ready === false &&
    snapshot.target_generation_helper_unexpected_execute === false &&
    snapshot.oauth_function_bodies_ready === false &&
    snapshot.auth_user_generation_fences_ready === false &&
    snapshot.auth_session_generation_fence_ready === false &&
    snapshot.auth_generation_fence_unexpected_execute === false &&
    snapshot.private_table_owners_ready === false &&
    snapshot.legacy_bridge_rpc === false &&
    snapshot.legacy_bridge_inventory_exact === false &&
    snapshot.service_legacy_bridge_execute === false &&
    snapshot.anon_legacy_bridge_execute === false &&
    snapshot.authenticated_legacy_bridge_execute === false &&
    snapshot.public_legacy_bridge_execute === false &&
    snapshot.legacy_bridge_unexpected_execute === false &&
    snapshot.legacy_bridge_comment === null &&
    snapshot.begin_rpc === false &&
    snapshot.recover_rpc === false &&
    snapshot.consume_rpc === false &&
    snapshot.prune_rpc === false &&
    snapshot.scoped_rpcs_ready === false &&
    snapshot.scoped_rpc_inventory_exact === false &&
    snapshot.scoped_service_execute === false &&
    snapshot.scoped_anon_execute === false &&
    snapshot.scoped_authenticated_execute === false &&
    snapshot.scoped_public_execute === false &&
    snapshot.scoped_unexpected_execute === false &&
    snapshot.table_rls_enabled === false &&
    snapshot.service_table_privilege === false &&
    snapshot.anon_table_privilege === false &&
    snapshot.authenticated_table_privilege === false &&
    snapshot.public_table_privilege === false &&
    snapshot.service_raw_execute === true &&
    rawPrivate &&
    snapshot.raw_comment === null
  ) {
    return "legacy";
  }
  return "invalid";
}

function postContractSnapshotReady(snapshot) {
  return (
    snapshot?.analytics_maintenance_bounds_ready === true &&
    snapshot?.post_contract_owner_only_rpcs_ready === true
  );
}

function postContractJournalMatchesSnapshot(
  snapshot,
  postContractApplied,
) {
  return (
    snapshot?.analytics_maintenance_bounds_ready ===
      postContractApplied &&
    snapshot?.post_contract_owner_only_rpcs_ready ===
      postContractApplied
  );
}

async function readReceipts(
  management,
  fetchImpl,
  currentSources,
  deploymentCommit,
  {
    repositoryRoot,
    verifyReceiptLineageImpl,
    readReceiptMigrationSourceImpl,
  },
) {
  const rows = await managementQuery(
    `
      select
        version,
        migration_hash,
        manifest_hash,
        app_commit,
        floor(
          extract(epoch from applied_at) * 1000
        )::bigint::text as applied_at_ms
        from public.schema_migration_journal
       where version in (
         '${OAUTH_EXPAND_MIGRATION}',
         '${OAUTH_CONTRACT_MIGRATION}',
         '${OAUTH_POST_CONTRACT_MIGRATION}'
       )
       order by version
    `,
    management,
    fetchImpl,
  );
  if (!Array.isArray(rows)) throw new Error("oauth_migration_journal_invalid");
  const receipts = new Map();
  for (const row of rows) {
    const currentSource =
      row && typeof row === "object" && typeof row.version === "string"
        ? currentSources.get(row.version)
        : null;
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !==
        "app_commit,applied_at_ms,manifest_hash,migration_hash,version" ||
      !currentSource ||
      receipts.has(row.version) ||
      typeof row.app_commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(row.app_commit) ||
      typeof row.applied_at_ms !== "string" ||
      !/^[0-9]{1,16}$/.test(row.applied_at_ms)
    ) {
      throw new Error("oauth_migration_journal_invalid");
    }
    let lineage;
    let immutableSql;
    try {
      lineage = await verifyReceiptLineageImpl({
        receiptCommit: row.app_commit,
        deploymentCommit,
        repositoryRoot,
      });
      immutableSql = await readReceiptMigrationSourceImpl({
        receiptCommit: row.app_commit,
        migrationVersion: row.version,
        repositoryRoot,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /^[a-z0-9_]+$/u.test(error.message)
      ) {
        throw error;
      }
      throw new Error("oauth_migration_journal_invalid");
    }
    if (
      !lineage ||
      typeof lineage !== "object" ||
      lineage.receiptCommit !== row.app_commit ||
      lineage.deploymentCommit !== deploymentCommit ||
      typeof lineage.receiptTree !== "string" ||
      !/^[0-9a-f]{40}$/.test(lineage.receiptTree)
    ) {
      throw new Error("oauth_migration_journal_invalid");
    }
    const immutableSource = await migrationSource(
      row.version,
      currentSource.stage,
      lineage.receiptTree,
      immutableSql,
    );
    if (
      row.migration_hash !== immutableSource.migrationHash ||
      row.manifest_hash !== immutableSource.manifestHash ||
      row.migration_hash !== currentSource.migrationHash
    ) {
      throw new Error("oauth_migration_journal_invalid");
    }
    const appliedAtMs = Number(row.applied_at_ms);
    if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs <= 0) {
      throw new Error("oauth_migration_journal_invalid");
    }
    receipts.set(row.version, {
      ...row,
      appliedAtMs,
      receiptTree: lineage.receiptTree,
    });
  }
  return receipts;
}

const QUALIFICATION_KEYS = Object.freeze([
  "contract_version",
  "expand_version",
  "expand_migration_hash",
  "expand_manifest_hash",
  "expand_app_commit",
  "deployment_app_commit",
  "deployment_source_tree",
  "provider",
  "provider_team_id",
  "provider_project_id",
  "provider_deployment_id",
  "provider_deployment_url",
  "production_alias",
  "alias_uid",
  "provider_function_timeout_seconds",
  "deployment_created_at_ms",
  "provider_ready_at_ms",
  "alias_current_since_ms",
  "evidence_sha256",
  "qualified_at_ms",
]);

function exactEpochText(value) {
  if (typeof value !== "string" || !/^[0-9]{1,16}$/.test(value)) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return milliseconds;
}

function exactFunctionTimeout(value) {
  if (value !== BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return value;
}

async function readDeploymentQualification(management, fetchImpl) {
  const rows = await managementQuery(
    `
      select
        contract_version,
        expand_version,
        expand_migration_hash,
        expand_manifest_hash,
        expand_app_commit,
        deployment_app_commit,
        deployment_source_tree,
        provider,
        provider_team_id,
        provider_project_id,
        provider_deployment_id,
        provider_deployment_url,
        production_alias,
        alias_uid,
        provider_function_timeout_seconds,
        floor(
          extract(epoch from deployment_created_at) * 1000
        )::bigint::text as deployment_created_at_ms,
        floor(
          extract(epoch from provider_ready_at) * 1000
        )::bigint::text as provider_ready_at_ms,
        floor(
          extract(epoch from alias_current_since) * 1000
        )::bigint::text as alias_current_since_ms,
        evidence_sha256,
        floor(
          extract(epoch from qualified_at) * 1000
        )::bigint::text as qualified_at_ms
        from public.oauth_rollout_deployment_qualifications
       where contract_version =
         '${OAUTH_CONTRACT_MIGRATION}'
    `,
    management,
    fetchImpl,
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !==
      [...QUALIFICATION_KEYS].sort().join(",")
  ) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return {
    ...row,
    provider_function_timeout_seconds: exactFunctionTimeout(
      row.provider_function_timeout_seconds,
    ),
    deploymentCreatedAt: exactEpochText(
      row.deployment_created_at_ms,
    ),
    providerReadyAt: exactEpochText(row.provider_ready_at_ms),
    aliasCurrentSince: exactEpochText(row.alias_current_since_ms),
    qualifiedAtMs: exactEpochText(row.qualified_at_ms),
  };
}

function expectedDeploymentQualification({
  expandReceipt,
  attestation,
  sourceCommit,
  sourceTree,
}) {
  if (!expandReceipt) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return {
    contract_version: OAUTH_CONTRACT_MIGRATION,
    expand_version: OAUTH_EXPAND_MIGRATION,
    expand_migration_hash: expandReceipt.migration_hash,
    expand_manifest_hash: expandReceipt.manifest_hash,
    expand_app_commit: expandReceipt.app_commit,
    deployment_app_commit: sourceCommit,
    deployment_source_tree: sourceTree,
    provider: attestation.provider,
    provider_team_id: attestation.teamId,
    provider_project_id: attestation.projectId,
    provider_deployment_id: attestation.deploymentId,
    provider_deployment_url: attestation.deploymentUrl,
    production_alias: attestation.productionAlias,
    alias_uid: attestation.aliasUid,
    provider_function_timeout_seconds:
      attestation.functionTimeoutSeconds,
    deploymentCreatedAt: attestation.deploymentCreatedAt,
    providerReadyAt: attestation.providerReadyAt,
    aliasCurrentSince: attestation.aliasCurrentSince,
    evidence_sha256: attestation.evidenceSha256,
  };
}

function verifyDeploymentQualification(
  actual,
  expected,
  contractReceipt = null,
) {
  if (!actual || !expected) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  for (const key of [
    "contract_version",
    "expand_version",
    "expand_migration_hash",
    "expand_manifest_hash",
    "expand_app_commit",
    "deployment_app_commit",
    "deployment_source_tree",
    "provider",
    "provider_team_id",
    "provider_project_id",
    "provider_deployment_id",
    "provider_deployment_url",
    "production_alias",
    "alias_uid",
    "provider_function_timeout_seconds",
    "deploymentCreatedAt",
    "providerReadyAt",
    "aliasCurrentSince",
    "evidence_sha256",
  ]) {
    if (actual[key] !== expected[key]) {
      throw new Error("oauth_deployment_qualification_invalid");
    }
  }
  if (
    actual.qualifiedAtMs <
      expected.aliasCurrentSince + MIN_DEPLOYMENT_DRAIN_MS ||
    actual.qualifiedAtMs >
      expected.aliasCurrentSince + MAX_DEPLOYMENT_EVIDENCE_AGE_MS ||
    (
      contractReceipt !== null &&
      contractReceipt.appliedAtMs < actual.qualifiedAtMs
    )
  ) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return true;
}

function verifyHistoricalDeploymentQualification(
  actual,
  expandReceipt,
  contractReceipt,
) {
  if (!actual || !expandReceipt || !contractReceipt) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  const exactStrings = [
    [actual.contract_version, OAUTH_CONTRACT_MIGRATION],
    [actual.expand_version, OAUTH_EXPAND_MIGRATION],
    [actual.expand_migration_hash, expandReceipt.migration_hash],
    [actual.expand_manifest_hash, expandReceipt.manifest_hash],
    [actual.expand_app_commit, expandReceipt.app_commit],
    [actual.deployment_app_commit, contractReceipt.app_commit],
    [actual.deployment_source_tree, contractReceipt.receiptTree],
    [actual.provider, "vercel"],
    [actual.provider_team_id, BOSS_PAEGI_VERCEL_TEAM_ID],
    [actual.provider_project_id, BOSS_PAEGI_VERCEL_PROJECT_ID],
    [actual.production_alias, BOSS_PAEGI_PRODUCTION_ALIAS],
  ];
  const historicalEvidence = {
    provider: actual.provider,
    teamId: actual.provider_team_id,
    projectId: actual.provider_project_id,
    deploymentId: actual.provider_deployment_id,
    deploymentUrl: actual.provider_deployment_url,
    productionAlias: actual.production_alias,
    aliasUid: actual.alias_uid,
    appCommit: actual.deployment_app_commit,
    functionTimeoutSeconds:
      actual.provider_function_timeout_seconds,
    gitProvider: "github",
    gitRepositoryId: BOSS_PAEGI_GITHUB_REPOSITORY_ID,
    gitRepository: "jangahn/boss-paegi",
    gitRef: "main",
    gitMainCommit: actual.deployment_app_commit,
    deploymentCreatedAt: actual.deploymentCreatedAt,
    providerReadyAt: actual.providerReadyAt,
    aliasCurrentSince: actual.aliasCurrentSince,
  };
  if (
    exactStrings.some(([value, expected]) => value !== expected) ||
    typeof actual.provider_deployment_id !== "string" ||
    !/^dpl_[A-Za-z0-9]{16,64}$/.test(
      actual.provider_deployment_id,
    ) ||
    typeof actual.provider_deployment_url !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(
      actual.provider_deployment_url,
    ) ||
    actual.provider_deployment_url === BOSS_PAEGI_PRODUCTION_ALIAS ||
    typeof actual.alias_uid !== "string" ||
    actual.alias_uid.length < 64 ||
    actual.alias_uid.length > 256 ||
    !/^[0-9a-f]+$/.test(actual.alias_uid) ||
    actual.provider_function_timeout_seconds !==
      BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS ||
    typeof actual.evidence_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(actual.evidence_sha256) ||
    actual.evidence_sha256 !==
      vercelProductionEvidenceSha256(historicalEvidence) ||
    actual.deploymentCreatedAt <= expandReceipt.appliedAtMs ||
    actual.providerReadyAt < actual.deploymentCreatedAt ||
    actual.aliasCurrentSince < actual.providerReadyAt ||
    actual.aliasCurrentSince <= expandReceipt.appliedAtMs ||
    actual.qualifiedAtMs <
      actual.aliasCurrentSince + MIN_DEPLOYMENT_DRAIN_MS ||
    actual.qualifiedAtMs >
      actual.aliasCurrentSince + MAX_DEPLOYMENT_EVIDENCE_AGE_MS ||
    contractReceipt.appliedAtMs < actual.qualifiedAtMs
  ) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return true;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function qualificationTimestamp(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return `${sqlLiteral(new Date(milliseconds).toISOString())}::timestamptz`;
}

function qualificationReceiptSql(qualification) {
  const values = [
    qualification.contract_version,
    qualification.expand_version,
    qualification.expand_migration_hash,
    qualification.expand_manifest_hash,
    qualification.expand_app_commit,
    qualification.deployment_app_commit,
    qualification.deployment_source_tree,
    qualification.provider,
    qualification.provider_team_id,
    qualification.provider_project_id,
    qualification.provider_deployment_id,
    qualification.provider_deployment_url,
    qualification.production_alias,
    qualification.alias_uid,
    qualification.evidence_sha256,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 512,
    ) ||
    qualification.provider_function_timeout_seconds !==
      BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS
  ) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  return [
    "do $oauth_deployment_qualification$",
    "declare",
    "  v_inserted integer;",
    "begin",
    "  insert into public.oauth_rollout_deployment_qualifications (",
    "    contract_version, expand_version,",
    "    expand_migration_hash, expand_manifest_hash,",
    "    expand_app_commit, deployment_app_commit,",
    "    deployment_source_tree, provider, provider_team_id,",
    "    provider_project_id, provider_deployment_id,",
    "    provider_deployment_url, production_alias, alias_uid,",
    "    provider_function_timeout_seconds,",
    "    deployment_created_at, provider_ready_at,",
    "    alias_current_since, evidence_sha256",
    "  )",
    "  select",
    `    ${sqlLiteral(qualification.contract_version)},`,
    `    ${sqlLiteral(qualification.expand_version)},`,
    `    ${sqlLiteral(qualification.expand_migration_hash)},`,
    `    ${sqlLiteral(qualification.expand_manifest_hash)},`,
    `    ${sqlLiteral(qualification.expand_app_commit)},`,
    `    ${sqlLiteral(qualification.deployment_app_commit)},`,
    `    ${sqlLiteral(qualification.deployment_source_tree)},`,
    `    ${sqlLiteral(qualification.provider)},`,
    `    ${sqlLiteral(qualification.provider_team_id)},`,
    `    ${sqlLiteral(qualification.provider_project_id)},`,
    `    ${sqlLiteral(qualification.provider_deployment_id)},`,
    `    ${sqlLiteral(qualification.provider_deployment_url)},`,
    `    ${sqlLiteral(qualification.production_alias)},`,
    `    ${sqlLiteral(qualification.alias_uid)},`,
    `    ${qualification.provider_function_timeout_seconds},`,
    `    ${qualificationTimestamp(qualification.deploymentCreatedAt)},`,
    `    ${qualificationTimestamp(qualification.providerReadyAt)},`,
    `    ${qualificationTimestamp(qualification.aliasCurrentSince)},`,
    `    ${sqlLiteral(qualification.evidence_sha256)}`,
    "    from public.schema_migration_journal receipt",
    "   where receipt.version =",
    `     ${sqlLiteral(OAUTH_EXPAND_MIGRATION)}`,
    "     and receipt.migration_hash =",
    `       ${sqlLiteral(qualification.expand_migration_hash)}`,
    "     and receipt.manifest_hash =",
    `       ${sqlLiteral(qualification.expand_manifest_hash)}`,
    "     and receipt.app_commit =",
    `       ${sqlLiteral(qualification.expand_app_commit)}`,
    "     and receipt.applied_at <",
    `       ${qualificationTimestamp(qualification.deploymentCreatedAt)}`,
    "     and receipt.applied_at <",
    `       ${qualificationTimestamp(qualification.aliasCurrentSince)};`,
    "  get diagnostics v_inserted = row_count;",
    "  if v_inserted <> 1 then",
    "    raise exception",
    "      'oauth_deployment_qualification_receipt_mismatch'",
    "      using errcode = 'P0001';",
    "  end if;",
    "end;",
    "$oauth_deployment_qualification$;",
  ].join("\n");
}

function verifyReceiptTimeline(receipts) {
  const expand = receipts.get(OAUTH_EXPAND_MIGRATION);
  const contract = receipts.get(OAUTH_CONTRACT_MIGRATION);
  const postContract = receipts.get(OAUTH_POST_CONTRACT_MIGRATION);
  if (
    contract &&
    (!expand || contract.appliedAtMs <= expand.appliedAtMs)
  ) {
    throw new Error("oauth_migration_journal_timeline_invalid");
  }
  if (
    postContract &&
    (
      !contract ||
      postContract.appliedAtMs <= contract.appliedAtMs
    )
  ) {
    throw new Error("oauth_migration_journal_timeline_invalid");
  }
}

function verifyDeploymentEvidence(
  receipts,
  attestation,
  sourceCommit,
  nowMs,
) {
  const expand = receipts.get(OAUTH_EXPAND_MIGRATION);
  const contract = receipts.get(OAUTH_CONTRACT_MIGRATION);
  if (
    !expand ||
    !attestation ||
    typeof attestation !== "object" ||
    Array.isArray(attestation) ||
    attestation.provider !== "vercel" ||
    attestation.teamId !== BOSS_PAEGI_VERCEL_TEAM_ID ||
    attestation.projectId !== BOSS_PAEGI_VERCEL_PROJECT_ID ||
    attestation.productionAlias !== BOSS_PAEGI_PRODUCTION_ALIAS ||
    attestation.appCommit !== sourceCommit ||
    attestation.functionTimeoutSeconds !==
      BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS ||
    typeof attestation.deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]{16,64}$/.test(attestation.deploymentId) ||
    typeof attestation.deploymentUrl !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(
      attestation.deploymentUrl,
    ) ||
    attestation.deploymentUrl === BOSS_PAEGI_PRODUCTION_ALIAS ||
    typeof attestation.aliasUid !== "string" ||
    !/^[0-9a-f]{64,256}$/.test(attestation.aliasUid) ||
    typeof attestation.evidenceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(attestation.evidenceSha256) ||
    !Number.isSafeInteger(attestation.deploymentCreatedAt) ||
    !Number.isSafeInteger(attestation.providerReadyAt) ||
    !Number.isSafeInteger(attestation.aliasCurrentSince) ||
    attestation.deploymentCreatedAt <= expand.appliedAtMs ||
    attestation.providerReadyAt < attestation.deploymentCreatedAt ||
    attestation.aliasCurrentSince < attestation.providerReadyAt ||
    attestation.aliasCurrentSince <= expand.appliedAtMs
  ) {
    throw new Error("oauth_deployment_attestation_invalid");
  }
  const age = nowMs - attestation.aliasCurrentSince;
  if (
    age < MIN_DEPLOYMENT_DRAIN_MS ||
    age > MAX_DEPLOYMENT_EVIDENCE_AGE_MS
  ) {
    throw new Error("oauth_deployment_not_drained");
  }
  if (
    contract &&
    contract.appliedAtMs <
      attestation.aliasCurrentSince + MIN_DEPLOYMENT_DRAIN_MS
  ) {
    throw new Error("oauth_contract_precedes_drain");
  }
  return attestation;
}

function verifyCurrentDeploymentEvidence(
  attestation,
  sourceCommit,
  nowMs,
) {
  if (
    !attestation ||
    typeof attestation !== "object" ||
    Array.isArray(attestation)
  ) {
    throw new Error("oauth_current_deployment_attestation_invalid");
  }
  const evidence = {
    provider: attestation.provider,
    teamId: attestation.teamId,
    projectId: attestation.projectId,
    deploymentId: attestation.deploymentId,
    deploymentUrl: attestation.deploymentUrl,
    productionAlias: attestation.productionAlias,
    aliasUid: attestation.aliasUid,
    appCommit: attestation.appCommit,
    functionTimeoutSeconds: attestation.functionTimeoutSeconds,
    gitProvider: attestation.gitProvider,
    gitRepositoryId: attestation.gitRepositoryId,
    gitRepository: attestation.gitRepository,
    gitRef: attestation.gitRef,
    gitMainCommit: attestation.gitMainCommit,
    deploymentCreatedAt: attestation.deploymentCreatedAt,
    providerReadyAt: attestation.providerReadyAt,
    aliasCurrentSince: attestation.aliasCurrentSince,
  };
  if (
    attestation.provider !== "vercel" ||
    attestation.teamId !== BOSS_PAEGI_VERCEL_TEAM_ID ||
    attestation.projectId !== BOSS_PAEGI_VERCEL_PROJECT_ID ||
    attestation.productionAlias !== BOSS_PAEGI_PRODUCTION_ALIAS ||
    attestation.appCommit !== sourceCommit ||
    attestation.functionTimeoutSeconds !==
      BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS ||
    attestation.gitProvider !== "github" ||
    attestation.gitRepositoryId !==
      BOSS_PAEGI_GITHUB_REPOSITORY_ID ||
    attestation.gitRepository !== "jangahn/boss-paegi" ||
    attestation.gitRef !== "main" ||
    attestation.gitMainCommit !== sourceCommit ||
    typeof attestation.deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]{16,64}$/.test(attestation.deploymentId) ||
    typeof attestation.deploymentUrl !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(
      attestation.deploymentUrl,
    ) ||
    attestation.deploymentUrl === BOSS_PAEGI_PRODUCTION_ALIAS ||
    typeof attestation.aliasUid !== "string" ||
    !/^[0-9a-f]{64,256}$/.test(attestation.aliasUid) ||
    !Number.isSafeInteger(attestation.deploymentCreatedAt) ||
    !Number.isSafeInteger(attestation.providerReadyAt) ||
    !Number.isSafeInteger(attestation.aliasCurrentSince) ||
    attestation.deploymentCreatedAt <= 0 ||
    attestation.deploymentCreatedAt > attestation.providerReadyAt ||
    attestation.providerReadyAt > attestation.aliasCurrentSince ||
    attestation.aliasCurrentSince > nowMs + 5_000 ||
    typeof attestation.evidenceSha256 !== "string" ||
    attestation.evidenceSha256 !==
      vercelProductionEvidenceSha256(evidence)
  ) {
    throw new Error("oauth_current_deployment_attestation_invalid");
  }
  return attestation;
}

async function probeOAuthApplication(
  origin,
  fetchImpl,
  expectedIdentity,
) {
  if (
    !expectedIdentity ||
    typeof expectedIdentity !== "object" ||
    Array.isArray(expectedIdentity) ||
    Object.keys(expectedIdentity).sort().join(",") !==
      "buildCommit,deploymentId,deploymentUrl,environment,projectId,projectRef"
  ) {
    throw new Error("oauth_application_probe_failed");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(
        `${origin}/api/auth/oauth-flow/status?rollout=${randomUUID()}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: origin,
          },
          body: "{}",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new Error("oauth_application_probe_failed");
    }
    const cacheControl = response.headers.get("cache-control") ?? "";
    if (
      response.status !== 400 ||
      response.redirected ||
      !cacheControl
        .split(",")
        .some((part) => part.trim() === "no-store") ||
      response.headers.get(
        "x-boss-paegi-supabase-project-ref",
      ) !== expectedIdentity.projectRef ||
      response.headers.get("x-boss-paegi-build-commit") !==
        expectedIdentity.buildCommit ||
      response.headers.get(
        "x-boss-paegi-vercel-project-id",
      ) !== expectedIdentity.projectId ||
      response.headers.get(
        "x-boss-paegi-vercel-deployment-id",
      ) !== expectedIdentity.deploymentId ||
      response.headers.get(
        "x-boss-paegi-vercel-deployment-url",
      ) !== expectedIdentity.deploymentUrl ||
      response.headers.get(
        "x-boss-paegi-vercel-environment",
      ) !== expectedIdentity.environment
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort response cleanup.
      }
      throw new Error("oauth_application_probe_failed");
    }
    const body = await readBoundedJson(response, MAX_PROBE_BODY_BYTES);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      body.error !== "invalid_body"
    ) {
      throw new Error("oauth_application_probe_failed");
    }
  }
}

async function probeAttestedDeployment({
  attestation,
  sourceCommit,
  management,
  origin,
  fetchImpl,
}) {
  const expectedDeploymentIdentity = {
    projectId: attestation.projectId,
    deploymentId: attestation.deploymentId,
    url: attestation.deploymentUrl,
    environment: "production",
  };
  const expectedApplicationIdentity = {
    projectRef: management.ref,
    buildCommit: sourceCommit,
    projectId: attestation.projectId,
    deploymentId: attestation.deploymentId,
    deploymentUrl: attestation.deploymentUrl,
    environment: "production",
  };
  for (const checkedOrigin of [
    origin,
    `https://${attestation.deploymentUrl}`,
  ]) {
    const deploymentIdentityReady = await verifyFrozenSurfaces({
      origin: checkedOrigin,
      expectedProjectRef: management.ref,
      allowedCommits: new Set([sourceCommit]),
      expectedDeploymentIdentity,
      fetchImpl,
    });
    if (!deploymentIdentityReady) {
      throw new Error("oauth_deployment_identity_probe_failed");
    }
    await probeOAuthApplication(
      checkedOrigin,
      fetchImpl,
      expectedApplicationIdentity,
    );
  }
  return attestation;
}

async function probeCurrentAttestedDeployment({
  attestation,
  sourceCommit,
  management,
  origin,
  fetchImpl,
}) {
  const expectedApplicationIdentity = {
    projectRef: management.ref,
    buildCommit: sourceCommit,
    projectId: attestation.projectId,
    deploymentId: attestation.deploymentId,
    deploymentUrl: attestation.deploymentUrl,
    environment: "production",
  };
  for (const checkedOrigin of [
    origin,
    `https://${attestation.deploymentUrl}`,
  ]) {
    await probeOAuthApplication(
      checkedOrigin,
      fetchImpl,
      expectedApplicationIdentity,
    );
  }
  return attestation;
}

async function attestAndProbeDeployment({
  receipts,
  sourceCommit,
  management,
  origin,
  env,
  fetchImpl,
  nowMs,
  readDeploymentAttestationImpl,
}) {
  const attestation = verifyDeploymentEvidence(
    receipts,
    await readDeploymentAttestationImpl({
      expectedCommit: sourceCommit,
      env,
      fetchImpl,
      nowMs,
    }),
    sourceCommit,
    nowMs,
  );
  return probeAttestedDeployment({
    attestation,
    sourceCommit,
    management,
    origin,
    fetchImpl,
  });
}

async function attestAndProbeCurrentDeployment({
  sourceCommit,
  management,
  origin,
  env,
  fetchImpl,
  nowMs,
  readDeploymentAttestationImpl,
}) {
  const attestation = verifyCurrentDeploymentEvidence(
    await readDeploymentAttestationImpl({
      expectedCommit: sourceCommit,
      env,
      fetchImpl,
      nowMs,
    }),
    sourceCommit,
    nowMs,
  );
  return probeCurrentAttestedDeployment({
    attestation,
    sourceCommit,
    management,
    origin,
    fetchImpl,
  });
}

async function attestAndProbeCurrentFrozenDeployment({
  sourceCommit,
  management,
  origin,
  env,
  fetchImpl,
  nowMs,
  readDeploymentAttestationImpl,
}) {
  const attestation = verifyCurrentDeploymentEvidence(
    await readDeploymentAttestationImpl({
      expectedCommit: sourceCommit,
      env,
      fetchImpl,
      nowMs,
    }),
    sourceCommit,
    nowMs,
  );
  return probeAttestedDeployment({
    attestation,
    sourceCommit,
    management,
    origin,
    fetchImpl,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function convergedAfterUnknownResponse({
  expectedStage,
  expectedReceipt,
  management,
  fetchImpl,
  currentSources,
  deploymentCommit,
  receiptValidation,
  expectedQualification,
  expectedFunctionBodies,
  expectedMaintenanceFunctionBodies,
  delayImpl,
}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [snapshot, receipts] = await Promise.all([
        readDatabaseSnapshot(
          management,
          fetchImpl,
          expectedFunctionBodies,
          expectedMaintenanceFunctionBodies,
        ),
        readReceipts(
          management,
          fetchImpl,
          currentSources,
          deploymentCommit,
          receiptValidation,
        ),
      ]);
      const databaseStage = classifyOAuthDatabaseStage(snapshot);
      const receipt = receipts.get(expectedReceipt);
      verifyReceiptTimeline(receipts);
      const postContractApplied = receipts.has(
        OAUTH_POST_CONTRACT_MIGRATION,
      );
      if (
        !postContractJournalMatchesSnapshot(
          snapshot,
          postContractApplied,
        )
      ) {
        throw new Error("oauth_database_journal_mismatch");
      }
      if (databaseStage === expectedStage && receipt) {
        if (expectedReceipt === OAUTH_CONTRACT_MIGRATION) {
          const qualification = await readDeploymentQualification(
            management,
            fetchImpl,
          );
          verifyDeploymentQualification(
            qualification,
            expectedQualification,
            receipt,
          );
        } else if (
          expectedReceipt === OAUTH_POST_CONTRACT_MIGRATION
        ) {
          const qualification = await readDeploymentQualification(
            management,
            fetchImpl,
          );
          verifyHistoricalDeploymentQualification(
            qualification,
            receipts.get(OAUTH_EXPAND_MIGRATION),
            receipts.get(OAUTH_CONTRACT_MIGRATION),
          );
        }
        return true;
      }
    } catch {
      // The original transaction may still own catalog locks.
    }
    if (attempt < 4) await delayImpl(2_000);
  }
  return false;
}

/**
 * @param {{
 *   stage?: "expand" | "app-postflight" | "contract" | "post-contract",
 *   apply?: boolean,
 *   env?: RuntimeEnvironment,
 *   fetchImpl?: typeof fetch,
 *   logger?: (message: string) => void,
 *   delayImpl?: (milliseconds: number) => Promise<void>,
 *   nowMs?: number,
 *   sourceIdentity?: {commit: string, sourceTree: string},
 *   repositoryRoot?: string,
 *   verifyReceiptLineageImpl?: typeof verifyOAuthReceiptSourceLineage,
 *   readReceiptMigrationSourceImpl?: typeof readOAuthReceiptMigrationSource,
 *   readDeploymentAttestationImpl?: typeof readVercelProductionAttestation
 * }} [options]
 */
export async function runOAuthProductionRollout({
  stage,
  apply = false,
  env = process.env,
  fetchImpl = fetch,
  logger = console.log,
  delayImpl = delay,
  nowMs = Date.now(),
  sourceIdentity,
  repositoryRoot,
  verifyReceiptLineageImpl = verifyOAuthReceiptSourceLineage,
  readReceiptMigrationSourceImpl = readOAuthReceiptMigrationSource,
  readDeploymentAttestationImpl = readVercelProductionAttestation,
} = {}) {
  if (
    ![
      "expand",
      "app-postflight",
      "contract",
      "post-contract",
    ].includes(stage) ||
    typeof apply !== "boolean" ||
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    typeof fetchImpl !== "function" ||
    typeof logger !== "function" ||
    typeof delayImpl !== "function" ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0 ||
    (
      repositoryRoot !== undefined &&
      (typeof repositoryRoot !== "string" || repositoryRoot.length === 0)
    ) ||
    typeof verifyReceiptLineageImpl !== "function" ||
    typeof readReceiptMigrationSourceImpl !== "function" ||
    typeof readDeploymentAttestationImpl !== "function"
  ) {
    throw new Error("oauth_rollout_arguments_invalid");
  }
  if (stage === "app-postflight" && apply) {
    throw new Error("postflight_is_read_only");
  }
  const identity = sourceIdentity ?? readCanonicalSourceIdentity(env);
  const sourceCommit = exactCommit(
    identity.commit,
    "oauth_source_commit_invalid",
  );
  const sourceTree = exactCommit(
    identity.sourceTree,
    "oauth_source_tree_invalid",
  );
  const management = readManagementEnvironment(env);
  const origin = productionOrigin(env.BOSS_PAEGI_PRODUCTION_ORIGIN);
  const expand = await migrationSource(
    OAUTH_EXPAND_MIGRATION,
    "expand",
    sourceTree,
  );
  const contract = await migrationSource(
    OAUTH_CONTRACT_MIGRATION,
    "contract",
    sourceTree,
  );
  const postContract = await migrationSource(
    OAUTH_POST_CONTRACT_MIGRATION,
    "post-contract",
    sourceTree,
  );
  const sources = new Map([
    [expand.version, expand],
    [contract.version, contract],
    [postContract.version, postContract],
  ]);
  const receiptValidation = {
    repositoryRoot,
    verifyReceiptLineageImpl,
    readReceiptMigrationSourceImpl,
  };

  let [snapshot, receipts] = await Promise.all([
    readDatabaseSnapshot(
      management,
      fetchImpl,
      expand.functionBodyManifest,
      postContract.maintenanceFunctionBodyManifest,
    ),
    readReceipts(
      management,
      fetchImpl,
      sources,
      sourceCommit,
      receiptValidation,
    ),
  ]);
  let databaseStage = classifyOAuthDatabaseStage(snapshot);
  const expandApplied = receipts.has(OAUTH_EXPAND_MIGRATION);
  const contractApplied = receipts.has(OAUTH_CONTRACT_MIGRATION);
  const postContractApplied = receipts.has(
    OAUTH_POST_CONTRACT_MIGRATION,
  );
  let deploymentQualification = snapshot.qualification_table
    ? await readDeploymentQualification(management, fetchImpl)
    : null;
  verifyReceiptTimeline(receipts);
  if (
    (databaseStage === "expand" &&
      (!expandApplied || contractApplied || postContractApplied)) ||
    (databaseStage === "contract" &&
      (!expandApplied || !contractApplied)) ||
    (databaseStage === "legacy" &&
      (expandApplied || contractApplied || postContractApplied)) ||
    databaseStage === "invalid" ||
    (contractApplied && !expandApplied) ||
    (postContractApplied && !contractApplied) ||
    !postContractJournalMatchesSnapshot(
      snapshot,
      postContractApplied,
    ) ||
    contractApplied !== (deploymentQualification !== null)
  ) {
    throw new Error("oauth_database_journal_mismatch");
  }
  if (contractApplied) {
    verifyHistoricalDeploymentQualification(
      deploymentQualification,
      receipts.get(OAUTH_EXPAND_MIGRATION),
      receipts.get(OAUTH_CONTRACT_MIGRATION),
    );
  }

  let deploymentAttestation = null;
  let currentDeploymentAttestation = null;
  let expectedQualification = null;
  if (stage === "app-postflight" || stage === "contract") {
    if (!expandApplied || databaseStage === "legacy") {
      throw new Error("oauth_expand_incomplete");
    }
    if (!contractApplied) {
      deploymentAttestation = await attestAndProbeDeployment({
        receipts,
        sourceCommit,
        management,
        origin,
        env,
        fetchImpl,
        nowMs,
        readDeploymentAttestationImpl,
      });
      expectedQualification = expectedDeploymentQualification({
        expandReceipt: receipts.get(OAUTH_EXPAND_MIGRATION),
        attestation: deploymentAttestation,
        sourceCommit,
        sourceTree,
      });
    }
  }
  if (
    contractApplied &&
    (stage === "contract" || stage === "post-contract")
  ) {
    currentDeploymentAttestation =
      await (
        postContractApplied
          ? attestAndProbeCurrentDeployment
          : attestAndProbeCurrentFrozenDeployment
      )({
        sourceCommit,
        management,
        origin,
        env,
        fetchImpl,
        nowMs,
        readDeploymentAttestationImpl,
      });
  }

  if (stage === "app-postflight") {
    if (contractApplied || databaseStage !== "expand") {
      throw new Error("oauth_contract_already_started");
    }
    logger("oauth production rollout stage=app-postflight mode=read-only");
    return { changed: false, stage, pending: [] };
  }

  const source =
    stage === "expand"
      ? expand
      : stage === "contract"
        ? contract
        : postContract;
  const targetReceipt =
    stage === "expand"
      ? OAUTH_EXPAND_MIGRATION
      : stage === "contract"
        ? OAUTH_CONTRACT_MIGRATION
        : OAUTH_POST_CONTRACT_MIGRATION;
  if (stage === "expand" && contractApplied) {
    throw new Error("oauth_contract_already_started");
  }
  if (receipts.has(targetReceipt)) {
    const expectedDatabaseStage =
      stage === "expand" ? "expand" : "contract";
    if (
      databaseStage !== expectedDatabaseStage ||
      (
        stage === "post-contract" &&
        !postContractSnapshotReady(snapshot)
      )
    ) {
      throw new Error("oauth_rollout_stage_postcondition_failed");
    }
    logger(
      `oauth production rollout stage=${stage} mode=${apply ? "apply" : "dry-run"} pending=0`,
    );
    return { changed: false, stage, pending: [] };
  }
  if (stage === "expand" && databaseStage !== "legacy") {
    throw new Error("oauth_expand_precondition_failed");
  }
  if (stage === "contract" && databaseStage !== "expand") {
    throw new Error("oauth_contract_precondition_failed");
  }
  if (
    stage === "post-contract" &&
    (
      databaseStage !== "contract" ||
      !expandApplied ||
      !contractApplied ||
      deploymentQualification === null
    )
  ) {
    throw new Error("oauth_post_contract_precondition_failed");
  }

  logger(
    `oauth production rollout stage=${stage} mode=${apply ? "apply" : "dry-run"} pending=1`,
  );
  logger(`pending migration=${targetReceipt}`);
  if (!apply) {
    return { changed: false, stage, pending: [targetReceipt] };
  }

  if (stage === "contract") {
    const immediatelyBefore = await attestAndProbeDeployment({
      receipts,
      sourceCommit,
      management,
      origin,
      env,
      fetchImpl,
      nowMs,
      readDeploymentAttestationImpl,
    });
    if (
      !sameVercelProductionAttestation(
        deploymentAttestation,
        immediatelyBefore,
      )
    ) {
      throw new Error("oauth_deployment_attestation_changed");
    }
    deploymentAttestation = immediatelyBefore;
    expectedQualification = expectedDeploymentQualification({
      expandReceipt: receipts.get(OAUTH_EXPAND_MIGRATION),
      attestation: deploymentAttestation,
      sourceCommit,
      sourceTree,
    });
  } else if (stage === "post-contract") {
    const immediatelyBefore =
      await attestAndProbeCurrentFrozenDeployment({
        sourceCommit,
        management,
        origin,
        env,
        fetchImpl,
        nowMs,
        readDeploymentAttestationImpl,
      });
    if (
      !sameVercelProductionAttestation(
        currentDeploymentAttestation,
        immediatelyBefore,
      )
    ) {
      throw new Error("oauth_deployment_attestation_changed");
    }
    currentDeploymentAttestation = immediatelyBefore;
  }

  const sql = injectReceipt(
    source,
    sourceCommit,
    stage === "contract" ? expectedQualification : null,
    stage === "post-contract"
      ? expand.contractCatalogIntegrityQuery
      : expand.catalogIntegrityQuery,
    stage === "contract" || stage === "post-contract"
      ? expand.contractCatalogIntegrityQuery
      : null,
    expand.functionBodyManifest,
  );
  try {
    await managementQuery(sql, management, fetchImpl);
  } catch (error) {
    const converged = await convergedAfterUnknownResponse({
      expectedStage: stage === "expand" ? "expand" : "contract",
      expectedReceipt: targetReceipt,
      management,
      fetchImpl,
      currentSources: sources,
      deploymentCommit: sourceCommit,
      receiptValidation,
      expectedQualification,
      expectedFunctionBodies: expand.functionBodyManifest,
      expectedMaintenanceFunctionBodies:
        postContract.maintenanceFunctionBodyManifest,
      delayImpl,
    });
    if (!converged) {
      const status =
        error instanceof ManagementRequestError &&
        Number.isSafeInteger(error.status)
          ? error.status
          : "unknown";
      throw new Error(
        `oauth_migration_apply_failed:${targetReceipt}:status=${status}`,
      );
    }
  }

  [snapshot, receipts] = await Promise.all([
    readDatabaseSnapshot(
      management,
      fetchImpl,
      expand.functionBodyManifest,
      postContract.maintenanceFunctionBodyManifest,
    ),
    readReceipts(
      management,
      fetchImpl,
      sources,
      sourceCommit,
      receiptValidation,
    ),
  ]);
  databaseStage = classifyOAuthDatabaseStage(snapshot);
  deploymentQualification = snapshot.qualification_table
    ? await readDeploymentQualification(management, fetchImpl)
    : null;
  verifyReceiptTimeline(receipts);
  const finalPostContractApplied = receipts.has(
    OAUTH_POST_CONTRACT_MIGRATION,
  );
  const expectedDatabaseStage =
    stage === "expand" ? "expand" : "contract";
  if (
    databaseStage !== expectedDatabaseStage ||
    !receipts.has(targetReceipt) ||
    (
      stage === "expand" &&
      (
        receipts.has(OAUTH_CONTRACT_MIGRATION) ||
        finalPostContractApplied
      )
    ) ||
    !postContractJournalMatchesSnapshot(
      snapshot,
      finalPostContractApplied,
    )
  ) {
    throw new Error("oauth_rollout_stage_postcondition_failed");
  }
  if (stage === "contract") {
    verifyDeploymentQualification(
      deploymentQualification,
      expectedQualification,
      receipts.get(OAUTH_CONTRACT_MIGRATION),
    );
  } else if (stage === "post-contract") {
    verifyHistoricalDeploymentQualification(
      deploymentQualification,
      receipts.get(OAUTH_EXPAND_MIGRATION),
      receipts.get(OAUTH_CONTRACT_MIGRATION),
    );
  } else if (deploymentQualification !== null) {
    throw new Error("oauth_deployment_qualification_invalid");
  }
  if (stage === "contract") {
    const immediatelyAfter = await attestAndProbeDeployment({
      receipts,
      sourceCommit,
      management,
      origin,
      env,
      fetchImpl,
      nowMs,
      readDeploymentAttestationImpl,
    });
    if (
      !sameVercelProductionAttestation(
        deploymentAttestation,
        immediatelyAfter,
      )
    ) {
      throw new Error("oauth_deployment_attestation_changed");
    }
  } else if (stage === "post-contract") {
    const immediatelyAfter =
      await attestAndProbeCurrentFrozenDeployment({
        sourceCommit,
        management,
        origin,
        env,
        fetchImpl,
        nowMs,
        readDeploymentAttestationImpl,
      });
    if (
      !sameVercelProductionAttestation(
        currentDeploymentAttestation,
        immediatelyAfter,
      )
    ) {
      throw new Error("oauth_deployment_attestation_changed");
    }
  }
  return { changed: true, stage, pending: [] };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseOAuthRolloutArgs(argv);
  if (!parsed.ok) {
    console.error(`OAuth production rollout blocked reason=${parsed.reason}`);
    return 2;
  }
  try {
    await runOAuthProductionRollout({
      stage: parsed.stage,
      apply: parsed.apply,
    });
    return 0;
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_:=-]+$/.test(error.message)
        ? error.message
        : "unexpected_failure";
    console.error(`OAuth production rollout blocked reason=${reason}`);
    return 1;
  }
}

if (
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
