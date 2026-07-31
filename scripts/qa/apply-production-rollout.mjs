#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensurePaymentIntentIndex } from "./ensure-payment-intent-index.mjs";

const API_HOST = "https://api.supabase.com";
const DEFAULT_PRODUCTION_ORIGIN = "https://boss-paegi.vercel.app";
const MAX_MANAGEMENT_BODY_BYTES = 1024 * 1024;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const CANONICAL_BOOTSTRAP_COMMIT =
  "1b1ed83703eca595fbb21cbe4d952ca1aff75774";
export const PAYMENT_ROLLOUT_PROJECT_HEADER =
  "x-boss-paegi-supabase-project-ref";
export const PAYMENT_ROLLOUT_COMMIT_HEADER =
  "x-boss-paegi-build-commit";
export const PAYMENT_ROLLOUT_VERCEL_PROJECT_HEADER =
  "x-boss-paegi-vercel-project-id";
export const PAYMENT_ROLLOUT_VERCEL_DEPLOYMENT_HEADER =
  "x-boss-paegi-vercel-deployment-id";
export const PAYMENT_ROLLOUT_VERCEL_URL_HEADER =
  "x-boss-paegi-vercel-deployment-url";
export const PAYMENT_ROLLOUT_VERCEL_ENVIRONMENT_HEADER =
  "x-boss-paegi-vercel-environment";

/** @typedef {Record<string, string | undefined>} RuntimeEnvironment */

export const EXPAND_MIGRATIONS = Object.freeze([
  "0072_account_deletion_cleanup_saga",
  "0073_generation_terminal_state_machine",
  "0074_score_submission_integrity",
  "0075_checkout_account_delete_serialization",
  "0076_client_surface_acl_manifest",
  "0077_refund_pg_evidence_integrity",
  "0078_moderation_purge_fenced_saga",
  "0079_storage_cleanup_intents",
  "0080_atomic_content_report_submission",
  "0081_legal_state_machine_idempotency",
  "0082_admin_credit_adjust_idempotency",
  "0083_reviewer_account_saga",
  "0084_user_mutation_lock_order",
  "0085_admin_mutation_idempotency",
  "0086_fal_submit_ack_saga",
  "0087_payment_evidence_expand_ddl",
  "008800_payment_evidence_expand_validate",
  "008899_server_read_surface_rollout_gate",
  "008900_public_write_quotas",
  "008901_generation_storage_cost_controls",
  "008902_financial_projection_bounds",
  "008903_bounded_asset_cleanup_sagas",
  "008904_privacy_retention_controls",
  "008905_legal_commerce_generation_compliance",
  "008906_admin_search_helper_acl",
  "008907_atomic_active_event_snapshot",
]);

export const CONTRACT_MIGRATIONS = Object.freeze([
  "0090_payment_evidence_contract_constraint",
  "0091_payment_evidence_contract_validate",
  "0092_rollout_contract_cleanup",
]);

const ALL_MIGRATIONS = Object.freeze([
  ...EXPAND_MIGRATIONS,
  ...CONTRACT_MIGRATIONS,
]);

export function parseRolloutArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, reason: "invalid_arguments" };
  }
  let stage = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stage" && stage === null) {
      const candidate = argv[index + 1];
      if (
        candidate !== "expand" &&
        candidate !== "app-postflight" &&
        candidate !== "contract"
      ) {
        return { ok: false, reason: "invalid_stage" };
      }
      stage = candidate;
      index += 1;
    } else if (arg === "--apply" && !apply) {
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

/** @param {RuntimeEnvironment} env */
function readManagementEnvironment(env = process.env) {
  const token = env.BOSS_PAEGI_SUPABASE_ACCESS_TOKEN;
  const ref = env.BOSS_PAEGI_SUPABASE_PROJECT_REF;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("management_access_token_missing");
  }
  if (typeof ref !== "string" || !/^[a-z0-9]{20}$/.test(ref)) {
    throw new Error("management_project_ref_invalid");
  }
  return { token, ref };
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
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("production_origin_invalid");
  }
  return url.origin;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactCommit(value, reason) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(reason);
  }
  return normalized;
}

export function readCanonicalSourceIdentity(env = process.env) {
  let head;
  let tree;
  let dirty;
  try {
    head = execFileSync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    tree = execFileSync(
      "git",
      ["rev-parse", "--verify", "HEAD^{tree}"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    dirty = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    throw new Error("rollout_source_git_invalid");
  }
  const commit = exactCommit(head, "rollout_source_commit_invalid");
  const sourceTree = exactCommit(tree, "rollout_source_tree_invalid");
  if (dirty.trim() !== "") {
    throw new Error("rollout_source_worktree_dirty");
  }
  const expected = env.BOSS_PAEGI_ROLLOUT_SOURCE_COMMIT;
  if (
    typeof expected === "string" &&
    exactCommit(expected, "rollout_source_commit_invalid") !== commit
  ) {
    throw new Error("rollout_source_commit_mismatch");
  }
  const expectedTree = env.BOSS_PAEGI_ROLLOUT_SOURCE_TREE;
  if (
    typeof expectedTree === "string" &&
    exactCommit(expectedTree, "rollout_source_tree_invalid") !== sourceTree
  ) {
    throw new Error("rollout_source_tree_mismatch");
  }
  return { commit, sourceTree };
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
      // Never expose a provider error body; it can contain row identifiers.
    }
    throw new ManagementRequestError(response.status);
  }
  return readBoundedJson(response, MAX_MANAGEMENT_BODY_BYTES);
}

function quotedSqlList(values) {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

function stageManifestHash(stage, sourceTree, sources) {
  return sha256(
    JSON.stringify({
      schema: "boss-paegi-production-rollout-manifest/v1",
      stage,
      sourceTree,
      migrations: sources.map(({ version, migrationHash }) => ({
        version,
        migrationHash,
      })),
    }),
  );
}

export async function buildMigrationReceiptCatalog(
  sourceCommit,
  sourceTree,
) {
  const appCommit = exactCommit(
    sourceCommit,
    "rollout_source_commit_invalid",
  );
  const appSourceTree = exactCommit(
    sourceTree,
    "rollout_source_tree_invalid",
  );
  const catalog = new Map();
  for (const [stage, versions] of [
    ["expand", EXPAND_MIGRATIONS],
    ["contract", CONTRACT_MIGRATIONS],
  ]) {
    const sources = [];
    for (const version of versions) {
      sources.push(await migrationSource(version));
    }
    const manifestHash = stageManifestHash(
      stage,
      appSourceTree,
      sources,
    );
    for (const source of sources) {
      catalog.set(source.version, {
        ...source,
        manifestHash,
        appCommit,
      });
    }
  }
  if (catalog.size !== ALL_MIGRATIONS.length) {
    throw new Error("migration_receipt_catalog_invalid");
  }
  return catalog;
}

async function readJournal(management, fetchImpl, receiptCatalog) {
  const rows = await managementQuery(
    `
      select
        j.version,
        j.migration_hash,
        j.manifest_hash,
        j.app_commit
        from public.schema_migration_journal j
       where j.version in (${quotedSqlList(ALL_MIGRATIONS)})
       order by j.version
    `,
    management,
    fetchImpl,
  );
  if (!Array.isArray(rows)) throw new Error("migration_journal_invalid");
  const versions = [];
  const stageCommits = new Map();
  for (const row of rows) {
    const expected =
      row && typeof row === "object" && typeof row.version === "string"
        ? receiptCatalog.get(row.version)
        : null;
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !==
        "app_commit,manifest_hash,migration_hash,version" ||
      typeof row.version !== "string" ||
      !ALL_MIGRATIONS.includes(row.version) ||
      versions.includes(row.version) ||
      !expected
    ) {
      throw new Error("migration_journal_invalid");
    }
    if (
      row.migration_hash !== expected.migrationHash ||
      row.manifest_hash !== expected.manifestHash ||
      typeof row.app_commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(row.app_commit)
    ) {
      throw new Error(`migration_journal_receipt_mismatch:${row.version}`);
    }
    const receiptStage = EXPAND_MIGRATIONS.includes(row.version)
      ? "expand"
      : "contract";
    const stageCommit = stageCommits.get(receiptStage);
    if (stageCommit && stageCommit !== row.app_commit) {
      throw new Error(
        `migration_journal_stage_commit_mismatch:${receiptStage}`,
      );
    }
    stageCommits.set(receiptStage, row.app_commit);
    versions.push(row.version);
  }
  return { versions: new Set(versions), stageCommits };
}

export function pendingMigrationsForStage(stage, applied) {
  if (!(applied instanceof Set)) {
    return { ok: false, reason: "migration_journal_invalid" };
  }
  const desired =
    stage === "expand"
      ? EXPAND_MIGRATIONS
      : stage === "contract"
        ? CONTRACT_MIGRATIONS
        : null;
  if (!desired) return { ok: false, reason: "invalid_stage" };

  if (
    stage === "expand" &&
    CONTRACT_MIGRATIONS.some((version) => applied.has(version))
  ) {
    return { ok: false, reason: "contract_already_started" };
  }
  if (
    stage === "contract" &&
    EXPAND_MIGRATIONS.some((version) => !applied.has(version))
  ) {
    return { ok: false, reason: "expand_incomplete" };
  }

  let sawGap = false;
  for (const version of desired) {
    if (!applied.has(version)) {
      sawGap = true;
    } else if (sawGap) {
      return { ok: false, reason: "migration_journal_noncontiguous" };
    }
  }
  return {
    ok: true,
    pending: desired.filter((version) => !applied.has(version)),
  };
}

const FROZEN_SURFACES = Object.freeze([
  Object.freeze({
    path: "/api/pay/checkout",
    rolloutHeader: "x-boss-paegi-payment-rollout",
    error: "payment_unavailable",
  }),
  Object.freeze({
    path: "/api/fal",
    rolloutHeader: "x-boss-paegi-generation-cost-rollout",
    error: "generation_unavailable",
  }),
  Object.freeze({
    path: "/api/doll",
    rolloutHeader: "x-boss-paegi-generation-cost-rollout",
    error: "generation_unavailable",
  }),
]);

async function readFrozenSurface({
  origin,
  surface,
  expectedProjectRef,
  allowedCommits,
  expectedDeploymentIdentity,
  fetchImpl,
}) {
  let response;
  try {
    response = await fetchImpl(`${origin}${surface.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (response.status !== 503 || response.redirected) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
    return null;
  }
  if (
    response.headers.get(surface.rolloutHeader) !== "frozen" ||
    response.headers.get(PAYMENT_ROLLOUT_PROJECT_HEADER) !==
      expectedProjectRef ||
    (
      expectedDeploymentIdentity !== null &&
      (
        response.headers.get(PAYMENT_ROLLOUT_VERCEL_PROJECT_HEADER) !==
          expectedDeploymentIdentity.projectId ||
        response.headers.get(PAYMENT_ROLLOUT_VERCEL_DEPLOYMENT_HEADER) !==
          expectedDeploymentIdentity.deploymentId ||
        response.headers.get(PAYMENT_ROLLOUT_VERCEL_URL_HEADER) !==
          expectedDeploymentIdentity.url ||
        response.headers.get(
          PAYMENT_ROLLOUT_VERCEL_ENVIRONMENT_HEADER,
        ) !== expectedDeploymentIdentity.environment
      )
    )
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
    return null;
  }
  const commit = response.headers.get(PAYMENT_ROLLOUT_COMMIT_HEADER);
  if (
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !allowedCommits.has(commit)
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
    return null;
  }
  let body;
  try {
    body = await readBoundedJson(response, 4096);
  } catch {
    return null;
  }
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    body.error === surface.error
  ) {
    return commit;
  }
  return null;
}

/**
 * @param {{
 *   origin?: string,
 *   expectedProjectRef?: string,
 *   allowedCommits?: Set<string>,
 *   expectedDeploymentIdentity?: null | {
 *     projectId: string,
 *     deploymentId: string,
 *     url: string,
 *     environment: "production"
 *   },
 *   fetchImpl?: typeof fetch
 * }} [options]
 */
export async function verifyFrozenSurfaces({
  origin = DEFAULT_PRODUCTION_ORIGIN,
  expectedProjectRef,
  allowedCommits,
  expectedDeploymentIdentity = null,
  fetchImpl = fetch,
} = {}) {
  const checkedOrigin = productionOrigin(origin);
  const deploymentIdentityValid =
    expectedDeploymentIdentity === null ||
    (
      expectedDeploymentIdentity &&
      typeof expectedDeploymentIdentity === "object" &&
      !Array.isArray(expectedDeploymentIdentity) &&
      Object.keys(expectedDeploymentIdentity).sort().join(",") ===
        "deploymentId,environment,projectId,url" &&
      /^prj_[A-Za-z0-9]{16,64}$/.test(
        expectedDeploymentIdentity.projectId,
      ) &&
      /^dpl_[A-Za-z0-9]{16,64}$/.test(
        expectedDeploymentIdentity.deploymentId,
      ) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(
        expectedDeploymentIdentity.url,
      ) &&
      expectedDeploymentIdentity.environment === "production"
    );
  if (
    typeof expectedProjectRef !== "string" ||
    !/^[a-z0-9]{20}$/.test(expectedProjectRef) ||
    !(allowedCommits instanceof Set) ||
    allowedCommits.size === 0 ||
    [...allowedCommits].some(
      (commit) =>
        typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit),
    ) ||
    !deploymentIdentityValid
  ) {
    throw new Error("frozen_surface_expectation_invalid");
  }
  const commits = await Promise.all(
    FROZEN_SURFACES.map((surface) =>
      readFrozenSurface({
        origin: checkedOrigin,
        surface,
        expectedProjectRef,
        allowedCommits,
        expectedDeploymentIdentity,
        fetchImpl,
      }),
    ),
  );
  return (
    commits.every((commit) => commit !== null) &&
    new Set(commits).size === 1
  );
}

async function readContractBlockers(management, fetchImpl) {
  const rows = await managementQuery(
    `
      select
        (
          select pg_catalog.count(*)::text
            from public.orders o
           where (
                   o.expected_store_id is null
                   or o.expected_currency is null
                   or o.expected_channel_key is null
                 )
             and (
                   o.expected_store_id is not null
                   or o.expected_currency is not null
                   or o.expected_channel_key is not null
                 )
        ) as partial_tuples,
        (
          select pg_catalog.count(*)::text
            from public.orders o
           where o.provider = 'portone'
             and (
                   o.payment_id is null
                   or o.expected_store_id is null
                   or o.expected_currency is null
                   or o.expected_channel_key is null
                 )
        ) as incomplete_portone_rows,
        (
          select pg_catalog.count(*)::text
            from (
              select o.user_id
                from public.orders o
               where o.provider = 'portone'
                 and o.status in ('pending', 'failed')
                 and o.paid_at is null
                 and o.canceled_at is null
               group by o.user_id
              having pg_catalog.count(*) > 1
            ) duplicate_users
        ) as duplicate_users,
        (
          select pg_catalog.count(*)::text
            from public.account_reactivation_legacy_repairs j
           where j.status in ('pending', 'leased')
        ) as legacy_reactivation_repairs,
        (
          select pg_catalog.count(*)::text
            from public.profiles p
            join public.member_accounts m on m.user_id = p.id
            left join auth.users u on u.id = p.id
           where p.deleted_at is null
             and (
               u.id is null
               or pg_catalog.lower(pg_catalog.btrim(u.email))
                    is distinct from
                      pg_catalog.lower(pg_catalog.btrim(m.email))
             )
        ) as active_auth_email_mismatches
    `,
    management,
    fetchImpl,
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== "object"
  ) {
    throw new Error("contract_inventory_invalid");
  }
  for (const key of [
    "partial_tuples",
    "incomplete_portone_rows",
    "duplicate_users",
    "legacy_reactivation_repairs",
    "active_auth_email_mismatches",
  ]) {
    if (rows[0][key] !== "0") return false;
  }
  return true;
}

const CANDIDATE_INVENTORY_KEYS = Object.freeze([
  "stale_generations",
  "stale_candidate_objects",
  "approved_stale_generations",
  "unapproved_stale_generations",
  "terminal_candidate_objects",
  "orphan_candidate_objects",
  "noncanonical_candidate_objects",
]);

export async function readCandidateRetentionInventory(
  management,
  fetchImpl,
) {
  const rows = await managementQuery(
    `
      with params as (
        select pg_catalog.clock_timestamp() - interval '24 hours' as cutoff
      ),
      stale_generations as (
        select
          g.id,
          g.owner_id,
          (
            pg_catalog.lower(pg_catalog.btrim(m.email)) in (
              'emfoa23@gmail.com',
              'emfoa23@kakao.com',
              'dev.jangahn@gmail.com'
            )
            or pg_catalog.strpos(
                 pg_catalog.lower(pg_catalog.btrim(m.email)),
                 'brian.ahn'
               ) > 0
          ) as approved_qa_owner
        from public.ai_generations g
        cross join params p
        left join public.member_accounts m on m.user_id = g.owner_id
        where g.status = 'done'
          and g.created_at < p.cutoff
      ),
      all_candidate_objects as (
        select o.name, o.created_at
        from storage.objects o
        where o.bucket_id = 'dolls'
          and o.name like '%/candidates/%'
      ),
      candidate_objects as (
        select
          o.name,
          o.created_at,
          pg_catalog.split_part(o.name, '/', 1)::uuid as owner_id,
          pg_catalog.split_part(o.name, '/', 3)::uuid as generation_id
        from all_candidate_objects o
        where o.name ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/candidates/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-2][.]jpg$'
      )
      select
        (
          select pg_catalog.count(*)::text
          from stale_generations
        ) as stale_generations,
        (
          select pg_catalog.count(*)::text
          from candidate_objects o
          join stale_generations g
            on g.id = o.generation_id
           and g.owner_id = o.owner_id
        ) as stale_candidate_objects,
        (
          select pg_catalog.count(*)::text
          from stale_generations
          where approved_qa_owner
        ) as approved_stale_generations,
        (
          select pg_catalog.count(*)::text
          from stale_generations
          where not coalesce(approved_qa_owner, false)
        ) as unapproved_stale_generations,
        (
          select pg_catalog.count(*)::text
          from candidate_objects o
          join public.ai_generations g
            on g.id = o.generation_id
           and g.owner_id = o.owner_id
          where g.status in ('failed', 'picked', 'expired')
        ) as terminal_candidate_objects,
        (
          select pg_catalog.count(*)::text
          from candidate_objects o
          cross join params p
          left join public.ai_generations g
            on g.id = o.generation_id
           and g.owner_id = o.owner_id
          where g.id is null
            and o.created_at < p.cutoff
        ) as orphan_candidate_objects,
        (
          select pg_catalog.count(*)::text
          from all_candidate_objects o
          cross join params p
          where o.created_at < p.cutoff
            and o.name !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/candidates/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-2][.]jpg$'
        ) as noncanonical_candidate_objects
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
      [...CANDIDATE_INVENTORY_KEYS].sort().join(",")
  ) {
    throw new Error("candidate_retention_inventory_invalid");
  }
  const inventory = {};
  for (const key of CANDIDATE_INVENTORY_KEYS) {
    const raw = rows[0][key];
    if (
      typeof raw !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(raw)
    ) {
      throw new Error("candidate_retention_inventory_invalid");
    }
    const count = Number(raw);
    if (!Number.isSafeInteger(count)) {
      throw new Error("candidate_retention_inventory_invalid");
    }
    inventory[key] = count;
  }
  return inventory;
}

function candidateRetentionPostcondition(inventory) {
  return (
    inventory.stale_generations === 0 &&
    inventory.stale_candidate_objects === 0 &&
    inventory.terminal_candidate_objects === 0 &&
    inventory.orphan_candidate_objects === 0 &&
    inventory.noncanonical_candidate_objects === 0
  );
}

async function migrationSource(version) {
  if (!ALL_MIGRATIONS.includes(version)) {
    throw new Error("migration_source_version_invalid");
  }
  const path = new URL(
    `../../supabase/migrations/${version}.sql`,
    import.meta.url,
  );
  const sql = await readFile(path, "utf8");
  const executableSql = sql.replace(/^[\t ]*--.*$/gm, "");
  const beginCount = (sql.match(/^begin;$/gm) ?? []).length;
  const commitCount = (sql.match(/^commit;$/gm) ?? []).length;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const journalPlaceholder = new RegExp(
    `values\\s*\\(\\s*'${escapedVersion}'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*null\\s*\\)`,
    "g",
  );
  const placeholderCount = (sql.match(journalPlaceholder) ?? []).length;
  if (
    beginCount !== 1 ||
    commitCount !== 1 ||
    !/^set local lock_timeout = '[1-9][0-9]*(?:ms|s|min)';$/m.test(
      sql,
    ) ||
    !/^set local statement_timeout = '[1-9][0-9]*(?:ms|s|min)';$/m.test(
      sql,
    ) ||
    /create\s+(?:unique\s+)?index\s+concurrently/i.test(executableSql) ||
    placeholderCount !== 1
  ) {
    throw new Error(`migration_source_invalid:${version}`);
  }
  return {
    version,
    sql,
    migrationHash: sha256(sql),
    journalPlaceholder,
  };
}

function executableMigrationSql(receipt) {
  const replacement =
    `values ('${receipt.version}', '${receipt.migrationHash}', ` +
    `'${receipt.manifestHash}', '${receipt.appCommit}')`;
  const sql = receipt.sql.replace(receipt.journalPlaceholder, replacement);
  if (
    sql === receipt.sql ||
    (sql.match(receipt.journalPlaceholder) ?? []).length !== 0 ||
    !sql.includes(replacement)
  ) {
    throw new Error(`migration_receipt_injection_failed:${receipt.version}`);
  }
  return sql;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function journalContainsAfterUnknownResponse(
  version,
  management,
  fetchImpl,
  delayImpl,
  receiptCatalog,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (
        (
          await readJournal(management, fetchImpl, receiptCatalog)
        ).versions.has(version)
      ) {
        return true;
      }
    } catch {
      // The original migration may still own a catalog lock. Retry briefly.
    }
    if (attempt < 4) await delayImpl(2000);
  }
  return false;
}

/**
 * @param {{
 *   stage?: "expand" | "app-postflight" | "contract",
 *   apply?: boolean,
 *   env?: RuntimeEnvironment,
 *   fetchImpl?: typeof fetch,
 *   logger?: (message: string) => void,
 *   delayImpl?: (milliseconds: number) => Promise<void>,
 *   sourceCommit?: string,
 *   sourceTree?: string
 * }} [options]
 */
export async function runProductionRollout(
  {
    stage,
    apply = false,
    env = process.env,
    fetchImpl = fetch,
    logger = console.log,
    delayImpl = delay,
    sourceCommit,
    sourceTree,
  } = {},
) {
  if (
    typeof fetchImpl !== "function" ||
    typeof delayImpl !== "function" ||
    typeof logger !== "function"
  ) {
    throw new Error("rollout_dependencies_invalid");
  }
  if (
    stage !== "expand" &&
    stage !== "app-postflight" &&
    stage !== "contract"
  ) {
    throw new Error("invalid_stage");
  }
  if (stage === "app-postflight" && apply) {
    throw new Error("postflight_is_read_only");
  }
  let sourceIdentity;
  if (sourceCommit === undefined && sourceTree === undefined) {
    sourceIdentity = readCanonicalSourceIdentity(env);
  } else if (
    typeof sourceCommit === "string" &&
    typeof sourceTree === "string"
  ) {
    sourceIdentity = {
      commit: exactCommit(
        sourceCommit,
        "rollout_source_commit_invalid",
      ),
      sourceTree: exactCommit(
        sourceTree,
        "rollout_source_tree_invalid",
      ),
    };
  } else {
    throw new Error("rollout_source_identity_incomplete");
  }
  const appCommit = sourceIdentity.commit;
  const receiptCatalog = await buildMigrationReceiptCatalog(
    appCommit,
    sourceIdentity.sourceTree,
  );
  const management = readManagementEnvironment(env);
  const origin = productionOrigin(env.BOSS_PAEGI_PRODUCTION_ORIGIN);
  const allowedFrozenCommits =
    stage === "expand"
      ? new Set([CANONICAL_BOOTSTRAP_COMMIT, appCommit])
      : new Set([appCommit]);
  const surfacesFrozen = () =>
    verifyFrozenSurfaces({
      origin,
      expectedProjectRef: management.ref,
      allowedCommits: allowedFrozenCommits,
      fetchImpl,
    });
  if (!(await surfacesFrozen())) {
    throw new Error("paid_surfaces_not_frozen");
  }

  await ensurePaymentIntentIndex({
    env: management,
    fetchImpl,
    checkOnly: true,
  });

  let journal = await readJournal(
    management,
    fetchImpl,
    receiptCatalog,
  );
  let applied = journal.versions;
  const candidateInventory = await readCandidateRetentionInventory(
    management,
    fetchImpl,
  );
  logger(
    "candidate retention inventory " +
      CANDIDATE_INVENTORY_KEYS.map(
        (key) => `${key}=${candidateInventory[key]}`,
      ).join(" "),
  );

  if (stage === "app-postflight") {
    const expanded = pendingMigrationsForStage("expand", applied);
    if (!expanded.ok || expanded.pending.length !== 0) {
      throw new Error("expand_incomplete");
    }
    if (!candidateRetentionPostcondition(candidateInventory)) {
      throw new Error("candidate_retention_postcondition_failed");
    }
    const finalCandidateInventory =
      await readCandidateRetentionInventory(management, fetchImpl);
    if (!candidateRetentionPostcondition(finalCandidateInventory)) {
      throw new Error("candidate_retention_postcondition_failed");
    }
    if (!(await surfacesFrozen())) {
      throw new Error("paid_surfaces_not_frozen");
    }
    logger(
      "production rollout stage=app-postflight mode=read-only pending=0",
    );
    return { changed: false, stage, pending: [] };
  }

  const plan = pendingMigrationsForStage(stage, applied);
  if (!plan.ok) throw new Error(plan.reason);
  if (
    stage === "contract" &&
    !(await readContractBlockers(management, fetchImpl))
  ) {
    throw new Error("contract_inventory_blocked");
  }
  if (
    stage === "contract" &&
    !candidateRetentionPostcondition(candidateInventory)
  ) {
    throw new Error("candidate_retention_postcondition_failed");
  }

  logger(
    `production rollout stage=${stage} mode=${apply ? "apply" : "dry-run"} pending=${plan.pending.length}`,
  );
  for (const version of plan.pending) {
    logger(`pending migration=${version}`);
  }
  if (!apply) {
    return { changed: false, stage, pending: plan.pending };
  }

  const journalAppCommit =
    journal.stageCommits.get(stage) ?? appCommit;
  for (const version of plan.pending) {
    if (!(await surfacesFrozen())) {
      throw new Error("paid_surfaces_not_frozen");
    }
    const sourceReceipt = receiptCatalog.get(version);
    if (!sourceReceipt) {
      throw new Error(`migration_receipt_missing:${version}`);
    }
    const receipt = {
      ...sourceReceipt,
      appCommit: journalAppCommit,
    };
    const sql = executableMigrationSql(receipt);
    try {
      await managementQuery(sql, management, fetchImpl);
    } catch (error) {
      const committed = await journalContainsAfterUnknownResponse(
        version,
        management,
        fetchImpl,
        delayImpl,
        receiptCatalog,
      );
      if (!committed) {
        const status =
          error instanceof ManagementRequestError &&
          Number.isSafeInteger(error.status)
            ? error.status
            : "unknown";
        throw new Error(`migration_apply_failed:${version}:status=${status}`);
      }
    }
    journal = await readJournal(
      management,
      fetchImpl,
      receiptCatalog,
    );
    applied = journal.versions;
    if (!applied.has(version)) {
      throw new Error(`migration_journal_postcondition_failed:${version}`);
    }
    logger(`applied migration=${version}`);
  }

  const complete = pendingMigrationsForStage(stage, applied);
  if (!complete.ok || complete.pending.length !== 0) {
    throw new Error("rollout_stage_postcondition_failed");
  }
  if (stage === "contract") {
    if (!(await readContractBlockers(management, fetchImpl))) {
      throw new Error("contract_inventory_postcondition_failed");
    }
    const finalCandidateInventory =
      await readCandidateRetentionInventory(management, fetchImpl);
    if (!candidateRetentionPostcondition(finalCandidateInventory)) {
      throw new Error("candidate_retention_postcondition_failed");
    }
  }
  if (!(await surfacesFrozen())) {
    throw new Error("paid_surfaces_not_frozen");
  }
  return { changed: plan.pending.length > 0, stage, pending: [] };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseRolloutArgs(argv);
  if (!parsed.ok) {
    console.error(`production rollout blocked reason=${parsed.reason}`);
    return 2;
  }
  try {
    await runProductionRollout({
      stage: parsed.stage,
      apply: parsed.apply,
    });
    return 0;
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z0-9_:=-]+$/.test(error.message)
        ? error.message
        : "unexpected_failure";
    console.error(`production rollout blocked reason=${reason}`);
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
