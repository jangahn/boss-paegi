import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OAUTH_CONTRACT_MIGRATION,
  OAUTH_EXPAND_MIGRATION,
  OAUTH_POST_CONTRACT_MIGRATION,
  classifyOAuthDatabaseStage,
  parseOAuthRolloutArgs,
  readAnalyticsMaintenanceFunctionManifest,
  readOAuthCatalogFunctionManifest,
  readOAuthExpandFunctionBodyManifest,
  runOAuthProductionRollout as runOAuthProductionRolloutRaw,
  validateOAuthExpandFunctionAclSignatures,
} from "../../scripts/qa/apply-oauth-production-rollout.mjs";
import {
  OAUTH_CATALOG_RELATION_NAMES,
  OAUTH_EXPECTED_RELATION_FINGERPRINTS,
} from "../../scripts/qa/oauth-relation-fingerprints.mjs";
import { renderOAuthCatalogIntegrityQuery } from "../../scripts/qa/render-oauth-catalog-integrity-query.mjs";
import { vercelProductionEvidenceSha256 } from "../../scripts/qa/vercel-production-attestation.mjs";
import { renderLocalOAuthContractFixture } from "../../scripts/qa/render-local-oauth-contract.mjs";
import { renderLocalAnalyticsMaintenanceBoundsFixture } from "../../scripts/qa/render-local-analytics-maintenance-bounds.mjs";
import { deploymentIdentityHeaders } from "../../lib/deployment-identity.ts";

const SOURCE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const SOURCE_TREE = "1111111111111111111111111111111111111111";
const DESCENDANT_COMMIT =
  "2222222222222222222222222222222222222222";
const DESCENDANT_TREE =
  "3333333333333333333333333333333333333333";
const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const DEPLOYMENT_ID = "dpl_abcdefghijklmnop";
const DEPLOYMENT_URL =
  "boss-paegi-git-main-abcdef.vercel.app";
const ALIAS_UID = "1".repeat(64);
const ENV = Object.freeze({
  BOSS_PAEGI_SUPABASE_ACCESS_TOKEN: "management-token",
  BOSS_PAEGI_SUPABASE_PROJECT_REF: "jxnzolkmeqjvrnzikcmb",
  BOSS_PAEGI_VERCEL_API_TOKEN: "vercel-provider-token",
  BOSS_PAEGI_VERCEL_ORG_ID: "team_NmYBq4k4t5BbaQKQNAHRgu8a",
  BOSS_PAEGI_VERCEL_PROJECT_ID:
    "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
});
const SOURCE_IDENTITY = Object.freeze({
  commit: SOURCE_COMMIT,
  sourceTree: SOURCE_TREE,
});
const CONTRACT_COMMENT =
  "Internal primitive; invoke only through flow-scoped OAuth migration consumption.";
const LEGACY_BRIDGE_CONTRACT_COMMENT =
  "Expand-only pre-ledger cookie bridge; execution revoked after the full deployment drain.";

function currentMigrationSource(migrationVersion: string) {
  return readFileSync(
    new URL(
      `../../supabase/migrations/${migrationVersion}.sql`,
      import.meta.url,
    ),
    "utf8",
  );
}

function oauthCatalogDependencySources() {
  return {
    scoreSubmissionIntegritySql: currentMigrationSource(
      "0074_score_submission_integrity",
    ),
    userMutationLockOrderSql: currentMigrationSource(
      "0084_user_mutation_lock_order",
    ),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function oauthManifestHash(
  stage: "expand" | "contract" | "post-contract",
  sourceTree: string,
  migrationHash: string,
) {
  return sha256(
    JSON.stringify({
      schema: "boss-paegi-oauth-production-rollout-manifest/v1",
      stage,
      sourceTree,
      migrationHash,
    }),
  );
}

function deploymentAttestation(
  expectedCommit: string,
  overrides: Record<string, unknown> = {},
) {
  const evidence = {
    provider: "vercel" as const,
    teamId: "team_NmYBq4k4t5BbaQKQNAHRgu8a",
    projectId: "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
    deploymentId: DEPLOYMENT_ID,
    deploymentUrl: DEPLOYMENT_URL,
    productionAlias: "boss-paegi.vercel.app",
    aliasUid: ALIAS_UID,
    appCommit: expectedCommit,
    functionTimeoutSeconds: 300,
    gitProvider: "github" as const,
    gitRepositoryId: 1_260_129_355,
    gitRepository: "jangahn/boss-paegi" as const,
    gitRef: "main" as const,
    gitMainCommit: expectedCommit,
    deploymentCreatedAt: Date.parse("2026-07-31T11:33:10.000Z"),
    providerReadyAt: Date.parse("2026-07-31T11:33:20.000Z"),
    aliasCurrentSince: Date.parse("2026-07-31T11:34:00.000Z"),
    ...overrides,
  };
  const suppliedHash = (evidence as Record<string, unknown>)
    .evidenceSha256;
  delete (evidence as Record<string, unknown>).evidenceSha256;
  return {
    ...evidence,
    evidenceSha256:
      typeof suppliedHash === "string"
        ? suppliedHash
        : vercelProductionEvidenceSha256(evidence),
  };
}

function runOAuthProductionRollout(
  options: Parameters<typeof runOAuthProductionRolloutRaw>[0],
) {
  return runOAuthProductionRolloutRaw({
    verifyReceiptLineageImpl: (lineageOptions) => {
      assert.ok(lineageOptions);
      const { receiptCommit, deploymentCommit } = lineageOptions;
      if (receiptCommit !== SOURCE_COMMIT) {
        throw new Error("oauth_receipt_lineage_git_invalid");
      }
      return {
        receiptCommit,
        receiptTree: SOURCE_TREE,
        deploymentCommit,
      };
    },
    readReceiptMigrationSourceImpl: (sourceOptions) => {
      assert.ok(sourceOptions);
      return currentMigrationSource(sourceOptions.migrationVersion);
    },
    readDeploymentAttestationImpl: async (attestationOptions) => {
      assert.ok(attestationOptions);
      return deploymentAttestation(attestationOptions.expectedCommit);
    },
    ...options,
  });
}

function snapshot(
  stage: "legacy" | "expand" | "contract",
  analyticsMaintenanceReady = false,
  postContractOwnerOnlyRpcsReady = false,
) {
  const ready = stage !== "legacy";
  return {
    oauth_table: ready,
    qualification_table: ready,
    qualification_rls_enabled: ready,
    qualification_unexpected_table_privilege: false,
    qualification_guard_ready: ready,
    qualification_guard_unexpected_execute: false,
    legacy_receipt_table: ready,
    legacy_receipt_rls_enabled: ready,
    legacy_receipt_unexpected_table_privilege: false,
    legacy_receipt_guard_ready: ready,
    legacy_receipt_guard_unexpected_execute: false,
    target_generation_schema_ready: ready,
    target_generation_helper_ready: ready,
    target_generation_helper_unexpected_execute: false,
    oauth_function_bodies_ready: ready,
    auth_user_generation_fences_ready: ready,
    auth_session_generation_fence_ready: ready,
    auth_generation_fence_unexpected_execute: false,
    private_table_owners_ready: ready,
    legacy_bridge_rpc: ready,
    legacy_bridge_inventory_exact: ready,
    service_legacy_bridge_execute:
      stage === "expand",
    anon_legacy_bridge_execute: false,
    authenticated_legacy_bridge_execute: false,
    public_legacy_bridge_execute: false,
    legacy_bridge_unexpected_execute: false,
    begin_rpc: ready,
    recover_rpc: ready,
    consume_rpc: ready,
    prune_rpc: ready,
    scoped_rpcs_ready: ready,
    scoped_rpc_inventory_exact: ready,
    scoped_service_execute: ready,
    scoped_anon_execute: false,
    scoped_authenticated_execute: false,
    scoped_public_execute: false,
    scoped_unexpected_execute: false,
    table_rls_enabled: ready,
    service_table_privilege: false,
    anon_table_privilege: false,
    authenticated_table_privilege: false,
    public_table_privilege: false,
    service_raw_execute: stage !== "contract",
    anon_raw_execute: false,
    authenticated_raw_execute: false,
    public_raw_execute: false,
    raw_unexpected_execute: false,
    analytics_maintenance_bounds_ready:
      analyticsMaintenanceReady,
    post_contract_owner_only_rpcs_ready:
      postContractOwnerOnlyRpcsReady,
    raw_comment: stage === "contract" ? CONTRACT_COMMENT : null,
    legacy_bridge_comment:
      stage === "contract"
        ? LEGACY_BRIDGE_CONTRACT_COMMENT
        : null,
  };
}

function jsonResponse(value: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rolloutHarness({
  initialStage = "legacy",
  invalidApplicationProbe = false,
  unknownCommittedVersion = null,
  deploymentCommit = SOURCE_COMMIT,
  expandAppliedAtMs = Date.parse("2026-07-31T11:33:00.000Z"),
  contractAppliedAtMs = NOW,
  postContractAppliedAtMs = NOW + 1,
}: {
  initialStage?: "legacy" | "expand" | "contract" | "post-contract";
  invalidApplicationProbe?: boolean;
  unknownCommittedVersion?: string | null;
  deploymentCommit?: string;
  expandAppliedAtMs?: number;
  contractAppliedAtMs?: number;
  postContractAppliedAtMs?: number;
} = {}) {
  let databaseStage =
    initialStage === "post-contract" ? "contract" : initialStage;
  let analyticsMaintenanceReady = false;
  let postContractOwnerOnlyRpcsReady = false;
  let paidSurfacesOpen = false;
  let applicationProbeInvalid = invalidApplicationProbe;
  const receipts = new Map<
    string,
    {
      version: string;
      migration_hash: string;
      manifest_hash: string;
      app_commit: string;
      applied_at_ms: string;
    }
  >();
  let qualification: Record<string, string | number> | null = null;
  const events: Array<{ kind: string; sql?: string }> = [];

  const installReceipt = (sql: string, version: string) => {
    const receiptPattern = new RegExp(
      `values\\s*\\(\\s*'${version}',\\s*'([0-9a-f]{64})',\\s*'([0-9a-f]{64})',\\s*'([0-9a-f]{40})',\\s*pg_catalog\\.clock_timestamp\\(\\)\\s*\\)`,
      "u",
    );
    const match = sql.match(receiptPattern);
    assert.ok(match, `missing atomic receipt for ${version}`);
    receipts.set(version, {
      version,
      migration_hash: match[1],
      manifest_hash: match[2],
      app_commit: match[3],
      applied_at_ms: String(
        version === OAUTH_EXPAND_MIGRATION
          ? expandAppliedAtMs
          : version === OAUTH_CONTRACT_MIGRATION
            ? contractAppliedAtMs
            : postContractAppliedAtMs,
      ),
    });
  };

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const applicationUrl = new URL(url);
    if (
      applicationUrl.hostname === "boss-paegi.vercel.app" ||
      applicationUrl.hostname === DEPLOYMENT_URL
    ) {
      const pathname = applicationUrl.pathname;
      if (
        pathname === "/api/pay/checkout" ||
        pathname === "/api/fal" ||
        pathname === "/api/doll"
      ) {
        events.push({ kind: "deployment-identity-probe" });
        if (paidSurfacesOpen) {
          return jsonResponse(
            { ok: true },
            200,
            {
              "X-Boss-Paegi-Supabase-Project-Ref":
                "jxnzolkmeqjvrnzikcmb",
              "X-Boss-Paegi-Build-Commit": deploymentCommit,
              "X-Boss-Paegi-Vercel-Project-Id":
                "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
              "X-Boss-Paegi-Vercel-Deployment-Id":
                DEPLOYMENT_ID,
              "X-Boss-Paegi-Vercel-Deployment-Url":
                DEPLOYMENT_URL,
              "X-Boss-Paegi-Vercel-Environment": "production",
            },
          );
        }
        const checkout = pathname === "/api/pay/checkout";
        return jsonResponse(
          {
            error: checkout
              ? "payment_unavailable"
              : "generation_unavailable",
          },
          503,
          {
            [checkout
              ? "X-Boss-Paegi-Payment-Rollout"
              : "X-Boss-Paegi-Generation-Cost-Rollout"]: "frozen",
            "X-Boss-Paegi-Supabase-Project-Ref":
              "jxnzolkmeqjvrnzikcmb",
            "X-Boss-Paegi-Build-Commit": deploymentCommit,
            "X-Boss-Paegi-Vercel-Project-Id":
              "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
            "X-Boss-Paegi-Vercel-Deployment-Id": DEPLOYMENT_ID,
            "X-Boss-Paegi-Vercel-Deployment-Url": DEPLOYMENT_URL,
            "X-Boss-Paegi-Vercel-Environment": "production",
          },
        );
      }
      assert.equal(pathname, "/api/auth/oauth-flow/status");
      events.push({ kind: "application-probe" });
      if (applicationProbeInvalid) {
        return jsonResponse({ error: "not_found" }, 404, {
          "Cache-Control": "no-store",
        });
      }
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
      assert.equal(
        new Headers(init?.headers).get("origin"),
        applicationUrl.origin,
      );
      return jsonResponse({ error: "invalid_body" }, 400, {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Boss-Paegi-Supabase-Project-Ref":
          "jxnzolkmeqjvrnzikcmb",
        "X-Boss-Paegi-Build-Commit": deploymentCommit,
        "X-Boss-Paegi-Vercel-Project-Id":
          "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
        "X-Boss-Paegi-Vercel-Deployment-Id": DEPLOYMENT_ID,
        "X-Boss-Paegi-Vercel-Deployment-Url": DEPLOYMENT_URL,
        "X-Boss-Paegi-Vercel-Environment": "production",
      });
    }

    assert.match(url, /api\.supabase\.com\/v1\/projects\/jxnzolkmeqjvrnzikcmb/);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer management-token",
    );
    const payload = JSON.parse(String(init?.body)) as { query: string };
    const sql = payload.query;
    if (sql.includes("as oauth_table")) {
      events.push({ kind: "snapshot" });
      return jsonResponse([
        snapshot(
          databaseStage,
          analyticsMaintenanceReady,
          postContractOwnerOnlyRpcsReady,
        ),
      ]);
    }
    if (
      sql.trimStart().startsWith("select") &&
      sql.includes("from public.schema_migration_journal")
    ) {
      events.push({ kind: "journal" });
      return jsonResponse(
        [...receipts.values()].sort((left, right) =>
          left.version.localeCompare(right.version),
        ),
      );
    }
    if (
      sql.trimStart().startsWith("select") &&
      sql.includes(
        "from public.oauth_rollout_deployment_qualifications",
      )
    ) {
      events.push({ kind: "qualification" });
      return jsonResponse(qualification === null ? [] : [qualification]);
    }

    events.push({ kind: "migration", sql });
    if (
      databaseStage === "legacy" &&
      sql.includes(`'${OAUTH_EXPAND_MIGRATION}'`)
    ) {
      assert.equal(databaseStage, "legacy");
      assert.match(
        sql,
        /revoke all on function public\.reassign_anon_data\(uuid, uuid\)[\s\S]*grant execute on function public\.reassign_anon_data\(uuid, uuid\)\s+to service_role/u,
      );
      assert.match(
        sql,
        /revoke all on function public\.consume_legacy_signup_migration\([\s\S]*grant execute on function public\.consume_legacy_signup_migration\([\s\S]*to service_role/u,
      );
      assert.doesNotMatch(
        sql,
        /boss_paegi_oauth_contract_qualification_injection_point/u,
      );
      databaseStage = "expand";
      installReceipt(sql, OAUTH_EXPAND_MIGRATION);
      if (unknownCommittedVersion === OAUTH_EXPAND_MIGRATION) {
        throw new TypeError("simulated response loss");
      }
      return jsonResponse([]);
    }
    if (
      databaseStage === "expand" &&
      sql.includes(`'${OAUTH_CONTRACT_MIGRATION}'`)
    ) {
      assert.equal(databaseStage, "expand");
      assert.doesNotMatch(
        sql,
        /create table public\.oauth_flow_intents/u,
      );
      const expandReceipt = receipts.get(OAUTH_EXPAND_MIGRATION);
      assert.ok(expandReceipt);
      assert.match(
        sql,
        /oauth_rollout_deployment_qualifications/u,
      );
      assert.match(
        sql,
        /revoke all on function public\.reassign_anon_data\(uuid, uuid\)[\s\S]*revoke all on function public\.consume_legacy_signup_migration\(/u,
      );
      assert.match(sql, new RegExp(CONTRACT_COMMENT, "u"));
      assert.match(
        sql,
        new RegExp(LEGACY_BRIDGE_CONTRACT_COMMENT, "u"),
      );
      qualification = {
        contract_version: OAUTH_CONTRACT_MIGRATION,
        expand_version: OAUTH_EXPAND_MIGRATION,
        expand_migration_hash: expandReceipt.migration_hash,
        expand_manifest_hash: expandReceipt.manifest_hash,
        expand_app_commit: expandReceipt.app_commit,
        deployment_app_commit: SOURCE_COMMIT,
        deployment_source_tree: SOURCE_TREE,
        provider: "vercel",
        provider_team_id: "team_NmYBq4k4t5BbaQKQNAHRgu8a",
        provider_project_id:
          "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
        provider_deployment_id: DEPLOYMENT_ID,
        provider_deployment_url: DEPLOYMENT_URL,
        production_alias: "boss-paegi.vercel.app",
        alias_uid: ALIAS_UID,
        provider_function_timeout_seconds: 300,
        deployment_created_at_ms: String(
          Date.parse("2026-07-31T11:33:10.000Z"),
        ),
        provider_ready_at_ms: String(
          Date.parse("2026-07-31T11:33:20.000Z"),
        ),
        alias_current_since_ms: String(
          Date.parse("2026-07-31T11:34:00.000Z"),
        ),
        evidence_sha256:
          deploymentAttestation(SOURCE_COMMIT).evidenceSha256,
        qualified_at_ms: String(contractAppliedAtMs - 1),
      };
      databaseStage = "contract";
      installReceipt(sql, OAUTH_CONTRACT_MIGRATION);
      if (unknownCommittedVersion === OAUTH_CONTRACT_MIGRATION) {
        throw new TypeError("simulated response loss");
      }
      return jsonResponse([]);
    }
    if (
      databaseStage === "contract" &&
      !analyticsMaintenanceReady &&
      sql.includes(`'${OAUTH_POST_CONTRACT_MIGRATION}'`)
    ) {
      assert.doesNotMatch(
        sql,
        /boss_paegi_oauth_post_contract_catalog_injection_point/u,
      );
      assert.doesNotMatch(
        sql,
        /boss_paegi_raw_post_contract_guard/u,
      );
      assert.match(
        sql,
        /boss-paegi:oauth-catalog-mutation-lock/u,
      );
      assert.equal(
        sql.split(
          "-- boss_paegi_oauth_catalog_assertion_pre_post_contract",
        ).length - 1,
        1,
      );
      assert.equal(
        sql.split(
          "-- boss_paegi_oauth_catalog_assertion_post_post_contract",
        ).length - 1,
        1,
      );
      assert.match(
        sql,
        /create or replace function public\.telemetry_rollup_days\(p_days int default 3\)/u,
      );
      assert.match(
        sql,
        /create or replace function public\.maintain_analytics_rollups\(/u,
      );
      assert.match(
        sql,
        /create or replace function public\.prune_analytics_events\(/u,
      );
      assert.match(
        sql,
        /create or replace function public\.telemetry_prune\(\)/u,
      );
      assert.doesNotMatch(
        sql,
        /insert into public\.oauth_rollout_deployment_qualifications/u,
      );
      const postAssertionIndex = sql.indexOf(
        "-- boss_paegi_oauth_catalog_assertion_post_post_contract",
      );
      const receiptIndex = sql.indexOf(
        "insert into public.schema_migration_journal",
      );
      assert.ok(postAssertionIndex >= 0);
      assert.ok(receiptIndex > postAssertionIndex);
      analyticsMaintenanceReady = true;
      postContractOwnerOnlyRpcsReady = true;
      installReceipt(sql, OAUTH_POST_CONTRACT_MIGRATION);
      if (
        unknownCommittedVersion === OAUTH_POST_CONTRACT_MIGRATION
      ) {
        throw new TypeError("simulated response loss");
      }
      return jsonResponse([]);
    }
    assert.fail("unexpected management SQL");
  };

  const seedStage = async () => {
    if (initialStage === "legacy") return;
    const expand = await runOAuthProductionRollout({
      stage: "expand",
      apply: true,
      env: ENV,
      fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    });
    assert.equal(expand.changed, true);
    events.length = 0;
    if (
      initialStage === "contract" ||
      initialStage === "post-contract"
    ) {
      const contract = await runOAuthProductionRollout({
        stage: "contract",
        apply: true,
        env: ENV,
        fetchImpl,
        nowMs: NOW,
        sourceIdentity: SOURCE_IDENTITY,
      });
      assert.equal(contract.changed, true);
      events.length = 0;
    }
    if (initialStage === "post-contract") {
      const postContract = await runOAuthProductionRollout({
        stage: "post-contract",
        apply: true,
        env: ENV,
        fetchImpl,
        nowMs: NOW,
        sourceIdentity: SOURCE_IDENTITY,
      });
      assert.equal(postContract.changed, true);
      events.length = 0;
    }
  };

  // Seeding through the runner needs a legacy starting point.
  if (initialStage !== "legacy") databaseStage = "legacy";
  return {
    events,
    fetchImpl,
    receipts,
    clearQualification: () => {
      qualification = null;
    },
    qualification: () => qualification,
    analyticsMaintenanceReady: () => analyticsMaintenanceReady,
    setAnalyticsMaintenanceReady: (ready: boolean) => {
      analyticsMaintenanceReady = ready;
    },
    setPostContractOwnerOnlyRpcsReady: (ready: boolean) => {
      postContractOwnerOnlyRpcsReady = ready;
    },
    setPaidSurfacesOpen: (open: boolean) => {
      paidSurfacesOpen = open;
    },
    setApplicationProbeInvalid: (invalid: boolean) => {
      applicationProbeInvalid = invalid;
    },
    seedStage,
    stage: () => databaseStage,
  };
}

test("OAuth rollout CLI accepts one stage and can never apply postflight", () => {
  assert.deepEqual(parseOAuthRolloutArgs(["--stage", "expand"]), {
    ok: true,
    stage: "expand",
    apply: false,
  });
  assert.deepEqual(
    parseOAuthRolloutArgs(["--stage", "contract", "--apply"]),
    { ok: true, stage: "contract", apply: true },
  );
  assert.deepEqual(
    parseOAuthRolloutArgs([
      "--stage",
      "post-contract",
      "--apply",
    ]),
    { ok: true, stage: "post-contract", apply: true },
  );
  assert.deepEqual(
    parseOAuthRolloutArgs(["--stage", "app-postflight", "--apply"]),
    { ok: false, reason: "postflight_is_read_only" },
  );
  for (const argv of [
    [],
    ["--stage", "0093"],
    ["--stage", "expand", "--stage", "contract"],
    ["--apply"],
  ]) {
    assert.equal(parseOAuthRolloutArgs(argv).ok, false);
  }
});

test("OAuth status invalid-body responses expose only the complete public deployment identity contract", () => {
  const headers = deploymentIdentityHeaders({
    NEXT_PUBLIC_SUPABASE_URL:
      "https://jxnzolkmeqjvrnzikcmb.supabase.co",
    VERCEL_GIT_COMMIT_SHA: SOURCE_COMMIT,
    VERCEL_PROJECT_ID:
      "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
    VERCEL_DEPLOYMENT_ID: DEPLOYMENT_ID,
    VERCEL_URL: DEPLOYMENT_URL,
    VERCEL_TARGET_ENV: "production",
  });
  assert.deepEqual(headers, {
    "X-Boss-Paegi-Supabase-Project-Ref":
      "jxnzolkmeqjvrnzikcmb",
    "X-Boss-Paegi-Build-Commit": SOURCE_COMMIT,
    "X-Boss-Paegi-Vercel-Project-Id":
      "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
    "X-Boss-Paegi-Vercel-Deployment-Id": DEPLOYMENT_ID,
    "X-Boss-Paegi-Vercel-Deployment-Url": DEPLOYMENT_URL,
    "X-Boss-Paegi-Vercel-Environment": "production",
  });
  const route = readFileSync(
    new URL(
      "../../app/api/auth/oauth-flow/status/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    route,
    /import \{ deploymentIdentityHeaders \} from "@\/lib\/deployment-identity";/u,
  );
  assert.match(
    route,
    /headers:\s*\{\s*\.\.\.deploymentIdentityHeaders\(\),\s*"Cache-Control": "private, no-store, max-age=0"/u,
  );
  assert.deepEqual(
    deploymentIdentityHeaders({
      NEXT_PUBLIC_SUPABASE_URL:
        "https://jxnzolkmeqjvrnzikcmb.supabase.co",
      VERCEL_GIT_COMMIT_SHA: SOURCE_COMMIT,
      VERCEL_PROJECT_ID:
        "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU",
      VERCEL_DEPLOYMENT_ID: DEPLOYMENT_ID,
      VERCEL_URL: DEPLOYMENT_URL,
      VERCEL_TARGET_ENV: "preview",
    }),
    {},
  );
});

test("raw 0094 contains an intrinsic qualification guard and only the disposable renderer injects its local fixture", async () => {
  const raw = currentMigrationSource(OAUTH_CONTRACT_MIGRATION);
  const marker =
    "-- boss_paegi_oauth_contract_qualification_injection_point";
  const assertion =
    "select public.assert_oauth_rollout_deployment_qualification(";
  assert.equal(raw.split(marker).length - 1, 1);
  assert.ok(raw.indexOf(marker) < raw.indexOf(assertion));
  assert.doesNotMatch(
    raw,
    /insert into public\.oauth_rollout_deployment_qualifications/u,
  );

  const rendered = await renderLocalOAuthContractFixture();
  assert.doesNotMatch(rendered, new RegExp(marker, "u"));
  assert.ok(
    rendered.indexOf(
      "insert into public.oauth_rollout_deployment_qualifications",
    ) < rendered.indexOf(assertion),
  );
  assert.match(
    rendered,
    /Local disposable-DB qualification fixture; never production evidence/u,
  );
});

test("raw 0095 is intrinsically blocked while its fenced local renderer preserves the exact maintenance manifest", async () => {
  const raw = currentMigrationSource(OAUTH_POST_CONTRACT_MIGRATION);
  const marker =
    "-- boss_paegi_oauth_post_contract_catalog_injection_point";
  const rawGuard =
    "do $boss_paegi_raw_post_contract_guard$";
  assert.equal(raw.split(marker).length - 1, 1);
  assert.equal(raw.split(rawGuard).length - 1, 1);
  assert.ok(raw.indexOf(marker) < raw.indexOf(rawGuard));
  assert.match(
    raw,
    /raise exception '0095 requires the staged post-contract runner'/u,
  );
  const manifest = readAnalyticsMaintenanceFunctionManifest(raw);
  assert.deepEqual(
    manifest.map(
      ({ name, functionArguments, functionResult, executeAcl }) => ({
        name,
        functionArguments,
        functionResult,
        executeAcl,
      }),
    ),
    [
      {
        name: "maintain_analytics_rollups",
        functionArguments: "p_days integer DEFAULT 7",
        functionResult: "jsonb",
        executeAcl: "service",
      },
      {
        name: "prune_analytics_events",
        functionArguments:
          "p_retention_days integer DEFAULT 90",
        functionResult: "jsonb",
        executeAcl: "service",
      },
      {
        name: "telemetry_prune",
        functionArguments: "",
        functionResult: "jsonb",
        executeAcl: "service",
      },
      {
        name: "telemetry_rollup_days",
        functionArguments: "p_days integer DEFAULT 3",
        functionResult: "jsonb",
        executeAcl: "service",
      },
    ],
  );
  const rendered =
    await renderLocalAnalyticsMaintenanceBoundsFixture();
  assert.doesNotMatch(rendered, new RegExp(marker, "u"));
  assert.doesNotMatch(rendered, new RegExp(rawGuard, "u"));
  assert.match(
    rendered,
    /Local disposable-DB post-contract authorization fixture/u,
  );
  assert.deepEqual(
    readAnalyticsMaintenanceFunctionManifest(
      rendered.replace(
        "-- Local disposable-DB post-contract authorization fixture;",
        marker,
      ),
    ).map(({ bodySha256 }) => bodySha256),
    manifest.map(({ bodySha256 }) => bodySha256),
  );
});

test("catalog attestation binds every 0093 function body and security attribute plus the exact target-generation constraint", () => {
  const expandSql = currentMigrationSource(OAUTH_EXPAND_MIGRATION);
  const manifest = readOAuthExpandFunctionBodyManifest(expandSql);
  assert.equal(manifest.length, 51);
  assert.equal(new Set(manifest.map(({ name }) => name)).size, 51);
  assert.equal(
    manifest.find(
      ({ name }) =>
        name === "bp_0093_oauth_target_generation_matches",
    )?.securityDefiner,
    true,
  );
  assert.equal(
    validateOAuthExpandFunctionAclSignatures(expandSql, manifest),
    true,
  );
  const mismatchedAcl = expandSql.replace(
    /(revoke all on function public\.consume_oauth_flow_intent_migration\()[\s\S]*?(\)\s+from)/u,
    "$1uuid$2",
  );
  assert.notEqual(mismatchedAcl, expandSql);
  assert.throws(
    () =>
      validateOAuthExpandFunctionAclSignatures(
        mismatchedAcl,
        manifest,
      ),
    /oauth_function_acl_manifest_invalid/u,
  );
  assert.equal(
    manifest.find(
      ({ name }) =>
        name === "guard_oauth_rollout_deployment_qualification",
    )?.securityDefiner,
    false,
  );
  assert.equal(
    manifest.find(
      ({ name }) => name === "guard_oauth_critical_relation_truncate",
    )?.executeAcl,
    "owner",
  );

  const changedBody = expandSql.replace(
    "raise exception 'legacy_signup_migration_receipt_append_only'",
    "raise exception 'legacy_signup_migration_receipt_drifted'",
  );
  assert.notEqual(changedBody, expandSql);
  assert.notEqual(
    readOAuthExpandFunctionBodyManifest(changedBody).find(
      ({ name }) =>
        name === "guard_legacy_signup_migration_receipt",
    )?.bodySha256,
    manifest.find(
      ({ name }) =>
        name === "guard_legacy_signup_migration_receipt",
    )?.bodySha256,
  );

  const catalogManifest = readOAuthCatalogFunctionManifest(
    expandSql,
    oauthCatalogDependencySources(),
  );
  assert.equal(catalogManifest.length, 56);
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "bp_telemetry_submitter_binding",
    )?.language,
    "sql",
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "bp_telemetry_submitter_binding",
    )?.volatility,
    "i",
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "bp_telemetry_submitter_binding",
    )?.strict,
    true,
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "bp_user_mutation_lock",
    )?.executeAcl,
    "owner",
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "bp_0093_reassign_legacy_anon_data",
    )?.executeAcl,
    "owner",
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "begin_oauth_flow_intent",
    )?.executeAcl,
    "service",
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "oauth_current_badge_owner_readable",
    )?.executeAcl,
    "authenticated",
  );
  assert.equal(
    catalogManifest.find(
      ({ name }) => name === "reassign_anon_data",
    )?.executeAcl,
    "owner_or_service",
  );

  const integrityQuery = renderOAuthCatalogIntegrityQuery(
    expandSql,
    oauthCatalogDependencySources(),
  );
  const contractIntegrityQuery = renderOAuthCatalogIntegrityQuery(
    expandSql,
    oauthCatalogDependencySources(),
    "contract",
  );
  const expandBridgeLine = integrityQuery
    .split("\n")
    .find((line) =>
      line.includes("'consume_legacy_signup_migration'"),
    );
  const contractBridgeLine = contractIntegrityQuery
    .split("\n")
    .find((line) =>
      line.includes("'consume_legacy_signup_migration'"),
    );
  assert.match(expandBridgeLine ?? "", /'service'\),?$/u);
  assert.match(contractBridgeLine ?? "", /'owner'\),?$/u);
  assert.throws(
    () =>
      renderOAuthCatalogIntegrityQuery(
        expandSql,
        oauthCatalogDependencySources(),
        "invalid" as "expand",
      ),
    /oauth_catalog_stage_invalid/u,
  );
  assert.match(
    integrityQuery,
    /pg_catalog\.sha256[\s\S]*pg_get_function_arguments[\s\S]*pg_get_function_result[\s\S]*p\.prosecdef = expected\.security_definer/u,
  );
  assert.match(
    integrityQuery,
    /p\.proconfig[\s\S]*search_path=""[\s\S]*p\.provolatile[\s\S]*p\.proisstrict[\s\S]*p\.proparallel[\s\S]*pg_get_userbyid\(p\.proowner\) = 'postgres'/u,
  );
  assert.match(
    integrityQuery,
    /pg_get_expr\(c\.conbin, c\.conrelid\)[\s\S]*target_auth_created_at IS NULL[\s\S]*target_session_created_at IS NULL/u,
  );
  assert.match(
    integrityQuery,
    /expected_flow_columns[\s\S]*'flow_id'[\s\S]*'migration_result'[\s\S]*pg_catalog\.count\(\*\) = 28/u,
  );
  assert.match(
    integrityQuery,
    /expected_flow_checks[\s\S]*oauth_flow_intents_state_shape_check[\s\S]*oauth_flow_intents_time_order_check[\s\S]*pg_catalog\.count\(\*\) = 11/u,
  );
  assert.match(
    integrityQuery,
    /expected_flow_indexes[\s\S]*oauth_flow_intents_one_fenced_source_session_uidx[\s\S]*oauth_flow_intents_terminal_retention_idx[\s\S]*pg_catalog\.count\(\*\) = 5/u,
  );
  assert.match(
    integrityQuery,
    /oauth_flow_intents_pkey[\s\S]*flow_schema_integrity\.ready/u,
  );
  assert.match(
    integrityQuery,
    /oauth_anon_auth_cleanup_jobs_flow_source_generation_uidx[\s\S]*pg_catalog\.count\(\*\) = 4/u,
  );
  assert.match(
    integrityQuery,
    /anon_receipt_constraint_integrity[\s\S]*indisunique/u,
  );
  assert.match(
    integrityQuery,
    /anon_data_reassignments_target_user_id_key[\s\S]*anon_data_reassignments_result_check/u,
  );
  assert.match(
    integrityQuery,
    /pg_get_userbyid\(c\.relowner\) = 'postgres'[\s\S]*oauth_rollout_deployment_qualifications/u,
  );
  assert.match(
    integrityQuery,
    /journal_integrity[\s\S]*service_role[\s\S]*privilege_type = 'SELECT'/u,
  );
  assert.equal(integrityQuery.includes("schema_migration_journal"), true);
  assert.equal(integrityQuery.includes("trigger_integrity"), true);
  assert.equal(
    integrityQuery.includes(
      "trg_anon_data_reassignment_append_only",
    ),
    true,
  );
  assert.match(
    integrityQuery,
    /trg_oauth_critical_relation_truncate[\s\S]*guard_oauth_critical_relation_truncate\(\)[\s\S]*\n\s+34,[\s\S]*pg_catalog\.count\(\*\) = 21/u,
  ); 
  assert.equal(OAUTH_CATALOG_RELATION_NAMES.length, 13);
  for (const relationName of OAUTH_CATALOG_RELATION_NAMES) {
    const expectedFingerprint =
      OAUTH_EXPECTED_RELATION_FINGERPRINTS[
        relationName as keyof typeof OAUTH_EXPECTED_RELATION_FINGERPRINTS
      ];
    assert.match(
      expectedFingerprint,
      /^[0-9a-f]{64}$/u,
    );
    assert.equal(integrityQuery.includes(relationName), true);
    assert.equal(
      integrityQuery.includes(expectedFingerprint),
      true,
    );
    assert.match(
      expandSql,
      new RegExp(
        `grant usage on type\\s+${relationName.replaceAll(
          ".",
          "\\.",
        )}\\s+to public`,
        "u",
      ),
    );
  }
  assert.match(
    integrityQuery,
    /relation_fingerprint_integrity[\s\S]*full join actual_relation_fingerprints[\s\S]*relation_fingerprint_integrity\.ready/u,
  );
});

test("programmatic rollout rejects non-boolean apply values before any I/O", async () => {
  let fetched = false;
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "expand",
      apply: "false" as unknown as boolean,
      env: ENV,
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse([]);
      },
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_rollout_arguments_invalid/u,
  );
  assert.equal(fetched, false);
});

test("database stage classification binds 0093 and 0094 to opposite raw RPC ACLs", () => {
  assert.equal(classifyOAuthDatabaseStage(snapshot("legacy")), "legacy");
  assert.equal(classifyOAuthDatabaseStage(snapshot("expand")), "expand");
  assert.equal(classifyOAuthDatabaseStage(snapshot("contract")), "contract");
  assert.equal(
    classifyOAuthDatabaseStage({
      ...snapshot("expand"),
      service_raw_execute: false,
    }),
    "invalid",
  );
  assert.equal(
    classifyOAuthDatabaseStage({
      ...snapshot("expand"),
      raw_comment: "drifted comment",
    }),
    "invalid",
  );
  assert.equal(
    classifyOAuthDatabaseStage({
      ...snapshot("contract"),
      raw_comment: null,
    }),
    "invalid",
  );
  assert.equal(
    classifyOAuthDatabaseStage({
      ...snapshot("contract"),
      service_legacy_bridge_execute: true,
    }),
    "invalid",
  );
  assert.equal(
    classifyOAuthDatabaseStage({
      ...snapshot("contract"),
      legacy_bridge_comment: null,
    }),
    "invalid",
  );
  for (const drift of [
    { qualification_table: false },
    { qualification_rls_enabled: false },
    { qualification_unexpected_table_privilege: true },
    { qualification_guard_ready: false },
    { qualification_guard_unexpected_execute: true },
    { legacy_receipt_table: false },
    { legacy_receipt_rls_enabled: false },
    { legacy_receipt_unexpected_table_privilege: true },
    { legacy_receipt_guard_ready: false },
    { legacy_receipt_guard_unexpected_execute: true },
    { target_generation_schema_ready: false },
    { target_generation_helper_ready: false },
    { target_generation_helper_unexpected_execute: true },
    { oauth_function_bodies_ready: false },
    { auth_user_generation_fences_ready: false },
    { auth_session_generation_fence_ready: false },
    { auth_generation_fence_unexpected_execute: true },
    { private_table_owners_ready: false },
    { legacy_bridge_rpc: false },
    { legacy_bridge_inventory_exact: false },
    { service_legacy_bridge_execute: false },
    { anon_legacy_bridge_execute: true },
    { authenticated_legacy_bridge_execute: true },
    { public_legacy_bridge_execute: true },
    { legacy_bridge_unexpected_execute: true },
    { legacy_bridge_comment: "drifted comment" },
    { scoped_rpcs_ready: false },
    { scoped_rpc_inventory_exact: false },
    { scoped_service_execute: false },
    { scoped_anon_execute: true },
    { scoped_authenticated_execute: true },
    { scoped_public_execute: true },
    { scoped_unexpected_execute: true },
    { table_rls_enabled: false },
    { service_table_privilege: true },
    { anon_table_privilege: true },
    { authenticated_table_privilege: true },
    { public_table_privilege: true },
    { raw_unexpected_execute: true },
  ]) {
    assert.equal(
      classifyOAuthDatabaseStage({
        ...snapshot("expand"),
        ...drift,
      }),
      "invalid",
      JSON.stringify(drift),
    );
  }
});

test("migration receipts are bound to the exact canonical application commit", async () => {
  const harness = rolloutHarness({ initialStage: "expand" });
  await harness.seedStage();
  const receipt = harness.receipts.get(OAUTH_EXPAND_MIGRATION);
  assert.ok(receipt);
  receipt.app_commit =
    "2222222222222222222222222222222222222222";

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "app-postflight",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_receipt_lineage_git_invalid/u,
  );
  assert.equal(
    harness.events.some(({ kind }) =>
      kind.endsWith("probe"),
    ),
    false,
    "a stale receipt must fail before any deployment or route probe",
  );
});

test("postflight accepts only a true descendant while preserving the immutable expand receipt tree", async () => {
  const harness = rolloutHarness({
    initialStage: "expand",
    deploymentCommit: DESCENDANT_COMMIT,
  });
  await harness.seedStage();

  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "app-postflight",
      env: {
        ...ENV,
        BOSS_PAEGI_OAUTH_DEPLOYMENT_COMMIT: "0".repeat(40),
        BOSS_PAEGI_OAUTH_DEPLOYMENT_READY_AT:
          "1970-01-01T00:00:00.000Z",
      },
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: {
        commit: DESCENDANT_COMMIT,
        sourceTree: DESCENDANT_TREE,
      },
    }),
    { changed: false, stage: "app-postflight", pending: [] },
  );
});

test("a descendant rewrite of applied 0093 bytes fails even when its historical receipt blob and manifest agree", async () => {
  const harness = rolloutHarness({ initialStage: "expand" });
  await harness.seedStage();
  const receipt = harness.receipts.get(OAUTH_EXPAND_MIGRATION);
  assert.ok(receipt);
  const historicalRewrite =
    `-- rewritten after apply\n${currentMigrationSource(
      OAUTH_EXPAND_MIGRATION,
    )}`;
  receipt.migration_hash = sha256(historicalRewrite);
  receipt.manifest_hash = oauthManifestHash(
    "expand",
    SOURCE_TREE,
    receipt.migration_hash,
  );

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "app-postflight",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
      readReceiptMigrationSourceImpl: () => historicalRewrite,
    }),
    /oauth_migration_journal_invalid/u,
  );
  assert.equal(
    harness.events.some(({ kind }) => kind.endsWith("probe")),
    false,
  );
});

test("expand dry-run is read-only and apply sends only 0093 with an atomic receipt", async () => {
  const harness = rolloutHarness();
  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "expand",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    {
      changed: false,
      stage: "expand",
      pending: [OAUTH_EXPAND_MIGRATION],
    },
  );
  assert.equal(
    harness.events.some(({ kind }) => kind === "migration"),
    false,
  );

  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "expand",
      apply: true,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    { changed: true, stage: "expand", pending: [] },
  );
  assert.equal(harness.stage(), "expand");
  assert.equal(harness.receipts.has(OAUTH_EXPAND_MIGRATION), true);
  assert.equal(harness.receipts.has(OAUTH_CONTRACT_MIGRATION), false);
  const expandMigrationSql = harness.events.find(
    ({ kind }) => kind === "migration",
  )?.sql;
  assert.ok(expandMigrationSql);
  assert.ok(
    expandMigrationSql.indexOf("lock table") <
      expandMigrationSql.indexOf("oauth_catalog_integrity_invalid"),
  );
  assert.match(
    expandMigrationSql,
    /pg_advisory_xact_lock[\s\S]*boss-paegi:oauth-catalog-mutation-lock/u,
  );
  assert.match(
    expandMigrationSql,
    /lock table[\s\S]*in share update exclusive mode;/u,
  );
  assert.doesNotMatch(
    expandMigrationSql,
    /lock table[\s\S]*in access exclusive mode;/u,
  );
  assert.match(
    expandMigrationSql,
    /create role bp_oauth_catalog_lock_sentinel nologin;[\s\S]*grant select on table[\s\S]*do \$boss_paegi_catalog_columns\$[\s\S]*grant usage on type[\s\S]*do \$boss_paegi_catalog_publications\$[\s\S]*drop role bp_oauth_catalog_lock_sentinel;/u,
  );
  assert.ok(
    expandMigrationSql.indexOf(
      "alter function public.begin_oauth_flow_intent",
    ) <
      expandMigrationSql.indexOf("oauth_catalog_integrity_invalid"),
  );
  assert.match(
    expandMigrationSql,
    /alter function public\.begin_oauth_flow_intent\([\s\S]*?\) set search_path to '';/u,
  );
  assert.doesNotMatch(
    expandMigrationSql,
    /alter function public\.[^(]+\([\s\S]*?\) owner to postgres;/u,
  );
  assert.ok(
    expandMigrationSql.indexOf("oauth_catalog_integrity_invalid") <
      expandMigrationSql.indexOf(
        "insert into public.schema_migration_journal",
      ),
  );
});

test("postflight requires provider evidence, drain age, and both canonical and immutable route probes", async () => {
  const harness = rolloutHarness({ initialStage: "expand" });
  await harness.seedStage();

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "app-postflight",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
      readDeploymentAttestationImpl: async ({ expectedCommit }) =>
        deploymentAttestation(expectedCommit, {
          functionTimeoutSeconds: 301,
        }),
    }),
    /oauth_deployment_attestation_invalid/u,
  );

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "app-postflight",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
      readDeploymentAttestationImpl: async ({ expectedCommit }) =>
        deploymentAttestation(expectedCommit, {
          aliasCurrentSince:
            NOW - (300 + 15 * 60 + 300 + 5) * 1_000 + 1,
        }),
    }),
    /oauth_deployment_not_drained/u,
  );
  assert.equal(
    harness.events.some(({ kind }) => kind === "application-probe"),
    false,
  );

  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "app-postflight",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
      readDeploymentAttestationImpl: async ({ expectedCommit }) =>
        deploymentAttestation(expectedCommit, {
          aliasCurrentSince:
            NOW - (300 + 15 * 60 + 300 + 5) * 1_000,
        }),
    }),
    { changed: false, stage: "app-postflight", pending: [] },
  );
  assert.equal(
    harness.events.filter(({ kind }) => kind === "application-probe").length,
    6,
  );
  assert.equal(
    harness.events.filter(
      ({ kind }) => kind === "deployment-identity-probe",
    ).length,
    6,
  );

  const deployedBeforeExpand = rolloutHarness({
    initialStage: "expand",
    expandAppliedAtMs: Date.parse("2026-07-31T11:59:00.000Z"),
  });
  await deployedBeforeExpand.seedStage();
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "app-postflight",
      env: ENV,
      fetchImpl: deployedBeforeExpand.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_deployment_attestation_invalid/u,
  );
  assert.equal(
    deployedBeforeExpand.events.some(
      ({ kind }) => kind === "deployment-identity-probe",
    ),
    false,
  );

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "app-postflight",
      env: {
        ...ENV,
        BOSS_PAEGI_PRODUCTION_ORIGIN: "https://attacker.example",
      },
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /production_origin_invalid/u,
  );
});

test("contract refuses pre-expand or stale application state and never sends 0094", async () => {
  const legacy = rolloutHarness();
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      apply: true,
      env: ENV,
      fetchImpl: legacy.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_expand_incomplete/u,
  );
  assert.equal(
    legacy.events.some(({ kind }) => kind === "migration"),
    false,
  );

  const stale = rolloutHarness({
    initialStage: "expand",
    invalidApplicationProbe: true,
  });
  await stale.seedStage();
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      apply: true,
      env: ENV,
      fetchImpl: stale.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_application_probe_failed/u,
  );
  assert.equal(
    stale.events.some(({ kind }) => kind === "migration"),
    false,
  );

  const wrongDeployment = rolloutHarness({
    initialStage: "expand",
    deploymentCommit: "2222222222222222222222222222222222222222",
  });
  await wrongDeployment.seedStage();
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      apply: true,
      env: ENV,
      fetchImpl: wrongDeployment.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_deployment_identity_probe_failed/u,
  );
  assert.equal(
    wrongDeployment.events.some(
      ({ kind }) => kind === "application-probe",
    ),
    false,
  );
  assert.equal(
    wrongDeployment.events.some(({ kind }) => kind === "migration"),
    false,
  );
});

test("contract re-entry requires the exact append-only provider qualification row", async () => {
  const tampered = rolloutHarness({ initialStage: "contract" });
  await tampered.seedStage();
  const qualification = tampered.qualification();
  assert.ok(qualification);
  qualification.evidence_sha256 = "f".repeat(64);

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      env: ENV,
      fetchImpl: tampered.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_deployment_qualification_invalid/u,
  );
  assert.equal(
    tampered.events.some(({ kind }) => kind === "migration"),
    false,
  );

  const missing = rolloutHarness({ initialStage: "contract" });
  await missing.seedStage();
  missing.clearQualification();
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      env: ENV,
      fetchImpl: missing.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_database_journal_mismatch/u,
  );
  assert.equal(
    missing.events.some(({ kind }) => kind.endsWith("probe")),
    false,
  );
});

test("completed post-contract re-entry binds the current OAuth app while allowing paid surfaces to be open", async () => {
  const completed = rolloutHarness({
    initialStage: "post-contract",
  });
  await completed.seedStage();
  completed.setPaidSurfacesOpen(true);
  let providerReads = 0;

  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "post-contract",
      env: ENV,
      fetchImpl: completed.fetchImpl,
      nowMs: NOW + 60_000,
      sourceIdentity: SOURCE_IDENTITY,
      readDeploymentAttestationImpl: async ({
        expectedCommit,
      }) => {
        providerReads += 1;
        return deploymentAttestation(expectedCommit);
      },
    }),
    { changed: false, stage: "post-contract", pending: [] },
  );
  assert.equal(providerReads, 1);
  assert.equal(
    completed.events.filter(
      ({ kind }) => kind === "application-probe",
    ).length,
    6,
  );
  assert.equal(
    completed.events.filter(
      ({ kind }) => kind === "deployment-identity-probe",
    ).length,
    0,
  );
  assert.equal(
    completed.events.some(({ kind }) => kind === "migration"),
    false,
  );

  completed.events.length = 0;
  completed.setApplicationProbeInvalid(true);
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "post-contract",
      env: ENV,
      fetchImpl: completed.fetchImpl,
      nowMs: NOW + 60_000,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_application_probe_failed/u,
  );
  assert.equal(
    completed.events.some(({ kind }) => kind === "migration"),
    false,
  );
});

test("contract blocks if Vercel alias evidence changes between the first gate and the immediate pre-SQL gate", async () => {
  const harness = rolloutHarness({ initialStage: "expand" });
  await harness.seedStage();
  let attestations = 0;

  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      apply: true,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
      readDeploymentAttestationImpl: async ({ expectedCommit }) => {
        attestations += 1;
        return deploymentAttestation(
          expectedCommit,
          attestations === 1
            ? {}
            : {
                aliasUid: "3".repeat(64),
                evidenceSha256: "4".repeat(64),
              },
        );
      },
    }),
    /oauth_deployment_attestation_changed/u,
  );
  assert.equal(attestations, 2);
  assert.equal(
    harness.events.some(({ kind }) => kind === "migration"),
    false,
  );
});

test("contract applies only 0094 after postflight and response loss converges by receipt", async () => {
  const harness = rolloutHarness({
    initialStage: "expand",
    unknownCommittedVersion: OAUTH_CONTRACT_MIGRATION,
  });
  await harness.seedStage();
  const delays: number[] = [];
  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "contract",
      apply: true,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      delayImpl: async (milliseconds) => {
        delays.push(milliseconds);
      },
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    { changed: true, stage: "contract", pending: [] },
  );
  assert.equal(harness.stage(), "contract");
  assert.equal(harness.receipts.has(OAUTH_EXPAND_MIGRATION), true);
  assert.equal(harness.receipts.has(OAUTH_CONTRACT_MIGRATION), true);
  assert.deepEqual(delays, []);
  assert.equal(
    harness.events.filter(({ kind }) => kind === "migration").length,
    1,
  );
  const migrationSql = harness.events.find(
    ({ kind }) => kind === "migration",
  )?.sql;
  assert.ok(migrationSql);
  assert.ok(
    migrationSql.indexOf("lock table") <
      migrationSql.indexOf(
        "insert into public.oauth_rollout_deployment_qualifications",
      ),
  );
  assert.ok(
    migrationSql.indexOf(
      "insert into public.oauth_rollout_deployment_qualifications",
    ) <
      migrationSql.indexOf(
        "insert into public.schema_migration_journal",
      ),
  );
  assert.ok(
    migrationSql.indexOf(
      "select public.assert_oauth_rollout_deployment_qualification",
    ) <
      migrationSql.indexOf("oauth_catalog_integrity_invalid"),
  );
  assert.match(
    migrationSql,
    /oauth_catalog_integrity_invalid[\s\S]*revoke all on function public\.reassign_anon_data/u,
  );
  assert.equal(
    migrationSql.match(
      /^-- boss_paegi_oauth_catalog_assertion_pre_contract$/gmu,
    )?.length,
    1,
  );
  assert.equal(
    migrationSql.match(
      /^-- boss_paegi_oauth_catalog_assertion_post_contract$/gmu,
    )?.length,
    1,
  );
  assert.ok(
    migrationSql.indexOf(
      "-- boss_paegi_oauth_catalog_assertion_post_contract",
    ) >
      migrationSql.indexOf(
        "revoke all on function public.consume_legacy_signup_migration",
      ),
  );
  assert.ok(
    migrationSql.indexOf(
      "-- boss_paegi_oauth_catalog_assertion_post_contract",
    ) <
      migrationSql.indexOf(
        "insert into public.schema_migration_journal",
      ),
  );
  assert.equal(migrationSql.includes("pg_get_function_arguments"), true);
  assert.equal(
    migrationSql.includes(
      "anon_data_reassignments_target_user_id_key",
    ),
    true,
  );
  assert.equal(
    migrationSql.includes(
      "trg_anon_data_reassignment_append_only",
    ),
    true,
  );
  assert.ok(harness.qualification());
});

test("completed contract re-entry probes the current frozen OAuth deployment and rejects an old app", async () => {
  const harness = rolloutHarness({ initialStage: "contract" });
  await harness.seedStage();
  let providerReads = 0;
  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "contract",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
      readDeploymentAttestationImpl: async ({
        expectedCommit,
      }) => {
        providerReads += 1;
        return deploymentAttestation(expectedCommit);
      },
    }),
    { changed: false, stage: "contract", pending: [] },
  );
  assert.equal(providerReads, 1);
  assert.equal(
    harness.events.filter(
      ({ kind }) => kind === "deployment-identity-probe",
    ).length,
    6,
  );
  assert.equal(
    harness.events.filter(
      ({ kind }) => kind === "application-probe",
    ).length,
    6,
  );

  harness.events.length = 0;
  harness.setApplicationProbeInvalid(true);
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "contract",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_application_probe_failed/u,
  );
  assert.equal(
    harness.events.some(({ kind }) => kind === "migration"),
    false,
  );
});

test("post-contract refuses every pre-0094 state without sending 0095", async () => {
  for (const initialStage of ["legacy", "expand"] as const) {
    const harness = rolloutHarness({ initialStage });
    await harness.seedStage();
    await assert.rejects(
      runOAuthProductionRollout({
        stage: "post-contract",
        apply: true,
        env: ENV,
        fetchImpl: harness.fetchImpl,
        nowMs: NOW,
        sourceIdentity: SOURCE_IDENTITY,
      }),
      /oauth_post_contract_precondition_failed/u,
    );
    assert.equal(
      harness.events.some(({ kind }) => kind === "migration"),
      false,
    );
  }
});

test("post-contract dry-run is read-only and apply sends only atomic 0095 after frozen deployment checks", async () => {
  const harness = rolloutHarness({ initialStage: "contract" });
  await harness.seedStage();
  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "post-contract",
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    {
      changed: false,
      stage: "post-contract",
      pending: [OAUTH_POST_CONTRACT_MIGRATION],
    },
  );
  assert.equal(
    harness.events.some(({ kind }) => kind === "migration"),
    false,
  );
  assert.ok(
    harness.events.some(
      ({ kind }) => kind === "deployment-identity-probe",
    ),
  );

  harness.events.length = 0;
  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "post-contract",
      apply: true,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    { changed: true, stage: "post-contract", pending: [] },
  );
  assert.equal(harness.stage(), "contract");
  assert.equal(harness.analyticsMaintenanceReady(), true);
  assert.equal(
    harness.receipts.has(OAUTH_POST_CONTRACT_MIGRATION),
    true,
  );
  assert.equal(
    harness.events.filter(({ kind }) => kind === "migration").length,
    1,
  );
  const sql = harness.events.find(
    ({ kind }) => kind === "migration",
  )?.sql;
  assert.ok(sql);
  assert.doesNotMatch(
    sql,
    /boss_paegi_oauth_post_contract_catalog_injection_point/u,
  );
  assert.doesNotMatch(
    sql,
    /boss_paegi_raw_post_contract_guard/u,
  );
  assert.ok(
    sql.indexOf(
      "-- boss_paegi_oauth_catalog_assertion_pre_post_contract",
    ) <
      sql.indexOf(
        "create or replace function public.telemetry_rollup_days",
      ),
  );
  assert.ok(
    sql.indexOf(
      "-- boss_paegi_oauth_catalog_assertion_post_post_contract",
    ) <
      sql.indexOf(
        "insert into public.schema_migration_journal",
      ),
  );
});

test("post-contract response loss converges only when 0095 receipt, maintenance fingerprint, and historical qualification agree", async () => {
  const harness = rolloutHarness({
    initialStage: "contract",
    unknownCommittedVersion: OAUTH_POST_CONTRACT_MIGRATION,
  });
  await harness.seedStage();
  const delays: number[] = [];
  assert.deepEqual(
    await runOAuthProductionRollout({
      stage: "post-contract",
      apply: true,
      env: ENV,
      fetchImpl: harness.fetchImpl,
      delayImpl: async (milliseconds) => {
        delays.push(milliseconds);
      },
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    { changed: true, stage: "post-contract", pending: [] },
  );
  assert.deepEqual(delays, []);
  assert.equal(harness.analyticsMaintenanceReady(), true);
  assert.equal(
    harness.receipts.has(OAUTH_POST_CONTRACT_MIGRATION),
    true,
  );
});

test("post-contract refuses raw-applied, receipt-only, and non-monotonic 0095 states instead of forging lineage", async () => {
  for (const [maintenanceReady, ownerOnlyReady] of [
    [true, true],
    [true, false],
    [false, true],
  ] as const) {
    const rawApplied = rolloutHarness({
      initialStage: "contract",
    });
    await rawApplied.seedStage();
    rawApplied.setAnalyticsMaintenanceReady(maintenanceReady);
    rawApplied.setPostContractOwnerOnlyRpcsReady(ownerOnlyReady);
    await assert.rejects(
      runOAuthProductionRollout({
        stage: "post-contract",
        apply: true,
        env: ENV,
        fetchImpl: rawApplied.fetchImpl,
        nowMs: NOW,
        sourceIdentity: SOURCE_IDENTITY,
      }),
      /oauth_database_journal_mismatch/u,
    );
    assert.equal(
      rawApplied.events.some(({ kind }) => kind === "migration"),
      false,
    );
  }

  const receiptOnly = rolloutHarness({
    initialStage: "post-contract",
  });
  await receiptOnly.seedStage();
  receiptOnly.setAnalyticsMaintenanceReady(false);
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "post-contract",
      env: ENV,
      fetchImpl: receiptOnly.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_database_journal_mismatch/u,
  );

  const foldedAclDrift = rolloutHarness({
    initialStage: "post-contract",
  });
  await foldedAclDrift.seedStage();
  foldedAclDrift.setPostContractOwnerOnlyRpcsReady(false);
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "post-contract",
      env: ENV,
      fetchImpl: foldedAclDrift.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_database_journal_mismatch/u,
  );
  assert.equal(
    foldedAclDrift.events.some(({ kind }) => kind === "migration"),
    false,
  );

  const nonMonotonic = rolloutHarness({
    initialStage: "post-contract",
  });
  await nonMonotonic.seedStage();
  const contractReceipt = nonMonotonic.receipts.get(
    OAUTH_CONTRACT_MIGRATION,
  );
  const postContractReceipt = nonMonotonic.receipts.get(
    OAUTH_POST_CONTRACT_MIGRATION,
  );
  assert.ok(contractReceipt);
  assert.ok(postContractReceipt);
  postContractReceipt.applied_at_ms =
    contractReceipt.applied_at_ms;
  await assert.rejects(
    runOAuthProductionRollout({
      stage: "post-contract",
      env: ENV,
      fetchImpl: nonMonotonic.fetchImpl,
      nowMs: NOW,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    /oauth_migration_journal_timeline_invalid/u,
  );
});
