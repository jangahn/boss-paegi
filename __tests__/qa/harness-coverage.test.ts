import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8")
) as { scripts: Record<string, string> };
const workflow = readFileSync(
  new URL(".github/workflows/quality.yml", root),
  "utf8"
);

test("local, CI, and Vercel builds share the Node 22 runtime contract", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  ) as { engines?: { node?: string } };
  const packageLock = JSON.parse(
    readFileSync(new URL("package-lock.json", root), "utf8"),
  ) as {
    packages?: Record<string, { engines?: { node?: string } }>;
  };
  const nvmrc = readFileSync(new URL(".nvmrc", root), "utf8").trim();

  assert.equal(packageJson.engines?.node, "22.x");
  assert.equal(packageLock.packages?.[""]?.engines?.node, "22.x");
  assert.equal(nvmrc, "22");
  assert.equal(
    (JSON.parse(
      readFileSync(new URL("package.json", root), "utf8"),
    ) as { scripts?: Record<string, string> }).scripts?.prebuild,
    "node scripts/qa/assert-node-major.mjs",
  );
  assert.match(
    readFileSync(
      new URL("scripts/qa/assert-node-major.mjs", root),
      "utf8",
    ),
    /major !== REQUIRED_NODE_MAJOR/,
  );
  assert.equal(
    [...workflow.matchAll(/node-version:\s*22\b/g)].length,
    2,
    "both CI jobs must install Node 22",
  );
});

test("every database executable harness is wired through package scripts and CI", () => {
  const raceFiles = readdirSync(new URL("scripts/qa", root))
    .filter((name) => name.startsWith("test-") && name.endsWith(".sh"))
    .sort();
  const directWorkflowHarnesses = new Set<string>([]);

  assert.ok(raceFiles.length > 0, "race harness discovery must not be empty");

  for (const file of raceFiles) {
    const owners = Object.entries(pkg.scripts).filter(([, command]) =>
      command.includes(`scripts/qa/${file}`)
    );
    if (directWorkflowHarnesses.has(file)) {
      assert.equal(owners.length, 0, `${file} must remain a direct CI gate`);
      assert.match(
        workflow,
        new RegExp(
          `bash scripts/qa/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
        ),
        `${file} must run directly in CI`
      );
      continue;
    }
    assert.equal(owners.length, 1, `${file} must have exactly one package script`);
    assert.match(
      workflow,
      new RegExp(`npm run ${owners[0][0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      `${owners[0][0]} must run in CI`
    );
  }
});

test("database integration runner rejects empty and NOTESTS suites in CI", () => {
  const runner = readFileSync(
    new URL("scripts/qa/run-local-pgtap.sh", root),
    "utf8"
  );

  assert.match(runner, /no pgTAP files found/);
  assert.match(runner, /Result: NOTESTS/);
  assert.match(runner, /plan mismatch/);
  assert.match(runner, /--only BASENAME[.]pgtap[.]sql/);
  assert.match(runner, /requested pgTAP file does not exist/);
  assert.match(runner, /db_name="\$\{QA_DB_NAME:-postgres\}"/);
  assert.match(runner, /-d "\$db_name"/);
  assert.match(runner, /create extension if not exists pgtap with schema extensions/);
  assert.match(workflow, /npm run test:db/);
});

test("CI applies the full schema once, then verifies it in a fixed order", () => {
  const orderedCommands = [
    "npm run qa:db:apply",
    "npm run test:db",
    "npm run qa:db:permanent-surface",
    "npm run qa:db:oauth-target-fence",
    "npm run qa:db:oauth-relation-fingerprint-tamper",
    "npm run qa:db:oauth-catalog-mutation-locks",
    "npm run qa:db:oauth-prune-lock-race",
    "npm run qa:db:oauth-migration-member-race",
    "npm run qa:db:analytics-maintenance-acl-upgrade",
    "npm run qa:db:analytics-maintenance-lock-race",
    "npm run qa:db:checkout-concurrency-race",
    "npm run qa:db:race",
  ];
  const workflowLines = workflow.split("\n").map((line) => line.trim());
  let previous = -1;
  for (const command of orderedCommands) {
    const index = workflowLines.findIndex(
      (line, candidateIndex) =>
        candidateIndex > previous && line === `run: ${command}`,
    );
    assert.ok(index > previous, `${command} must appear in verification order`);
    previous = index;
  }

  // 모든 마이그레이션이 CI 에서 적용된다 — 시대별 부분 적용 사다리는 존재하지 않는다.
  assert.equal(
    pkg.scripts["qa:db:apply"],
    "bash scripts/qa/apply-local-migrations.sh",
    "the CI command must apply every migration with no stage arguments"
  );
  assert.equal(
    Object.keys(pkg.scripts).filter((name) =>
      name.startsWith("qa:db:apply:"),
    ).length,
    0,
    "per-migration apply ladders must not exist — the full schema is applied once"
  );
  assert.equal(
    pkg.scripts["qa:prod:rollout:app-postflight"],
    "node scripts/qa/apply-production-rollout.mjs --stage app-postflight"
  );
  assert.equal(
    pkg.scripts["qa:db:oauth-prune-lock-race"],
    "bash scripts/qa/test-oauth-prune-lock-backlog.sh",
  );
  assert.equal(
    pkg.scripts["qa:db:oauth-migration-member-race"],
    "bash scripts/qa/test-oauth-migration-member-races.sh",
  );
  assert.equal(
    pkg.scripts["qa:prod:oauth:app-postflight"],
    "node scripts/qa/apply-oauth-production-rollout.mjs --stage app-postflight"
  );
});

test("implicit Supabase migration commands cannot false-green the staged rollout", () => {
  const config = readFileSync(
    new URL("supabase/config.toml", root),
    "utf8",
  );
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const report = readFileSync(
    new URL("docs/qa-validation-report.md", root),
    "utf8",
  );
  const migrationSection =
    config.match(/\[db\.migrations\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";

  assert.match(migrationSection, /\benabled\s*=\s*false\b/);
  for (const command of [
    "supabase db reset",
    "supabase db push",
    "supabase migration up",
  ]) {
    assert.match(migrationSection, new RegExp(command.replaceAll(" ", "\\s+")));
    assert.match(readme, new RegExp(command.replaceAll(" ", "\\s+")));
    assert.match(report, new RegExp(command.replaceAll(" ", "\\s+")));
    assert.doesNotMatch(workflow, new RegExp(command.replaceAll(" ", "\\s+")));
  }
  assert.match(
    workflow,
    /supabase start[\s\S]*npm run qa:db:apply[\s\S]*npm run test:db/,
  );

  const migrationFiles = readdirSync(
    new URL("supabase/migrations", root),
  )
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const versions = migrationFiles.map(
    (name) => name.match(/^([0-9]+)_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/)?.[1],
  );
  assert.equal(
    versions.every((version): version is string => typeof version === "string"),
    true,
    "every migration must use the official digits-only filename shape",
  );
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(
    [...migrationFiles].sort((left, right) => {
      const leftVersion = left.match(/^[0-9]+/)?.[0] ?? "";
      const rightVersion = right.match(/^[0-9]+/)?.[0] ?? "";
      return leftVersion < rightVersion
        ? -1
        : leftVersion > rightVersion
          ? 1
          : 0;
    }),
    migrationFiles,
    "official CLI filename order and staged runner digit-version order must match",
  );
});

test("OAuth contract rollout cannot bypass the 0093 app drain boundary", () => {
  const runner = readFileSync(
    new URL("scripts/qa/apply-oauth-production-rollout.mjs", root),
    "utf8",
  );
  const runbook = readFileSync(
    new URL("docs/oauth-flow-rollout.md", root),
    "utf8",
  );
  const migration = readFileSync(
    new URL("supabase/migrations/0093_oauth_flow_intents.sql", root),
    "utf8",
  );
  const contractMigration = readFileSync(
    new URL(
      "supabase/migrations/0094_oauth_flow_migration_contract.sql",
      root,
    ),
    "utf8",
  );
  const postContractMigration = readFileSync(
    new URL(
      "supabase/migrations/0095_analytics_maintenance_argument_bounds.sql",
      root,
    ),
    "utf8",
  );
  const targetFence = readFileSync(
    new URL("scripts/qa/test-oauth-target-fence-contract.sh", root),
    "utf8",
  );
  const catalogVerifier = readFileSync(
    new URL(
      "scripts/qa/render-oauth-catalog-integrity-query.mjs",
      root,
    ),
    "utf8",
  );
  const oauthPgtap = readFileSync(
    new URL("supabase/tests/oauth_flow_intents.pgtap.sql", root),
    "utf8",
  );
  const oauthCleanupPgtap = readFileSync(
    new URL("supabase/tests/oauth_anon_auth_cleanup.pgtap.sql", root),
    "utf8",
  );
  const allCommands = Object.values(pkg.scripts).join("\n");

  assert.match(runner, /OAUTH_EXPAND_MIGRATION = "0093_oauth_flow_intents"/);
  assert.match(
    runner,
    /OAUTH_CONTRACT_MIGRATION =\s*"0094_oauth_flow_migration_contract"/,
  );
  assert.match(
    runner,
    /OAUTH_POST_CONTRACT_MIGRATION =\s*"0095_analytics_maintenance_argument_bounds"/,
  );
  assert.match(runner, /postflight_is_read_only/);
  assert.match(
    runner,
    /MIN_DEPLOYMENT_DRAIN_MS = \(300 \+ 15 \* 60 \+ 300 \+ 5\) \* 1_000/,
  );
  assert.match(runner, /applied_at_ms/);
  assert.match(runner, /pg_catalog\.clock_timestamp\(\)/);
  assert.match(runner, /readVercelProductionAttestation/);
  assert.match(runner, /verifyOAuthReceiptSourceLineage/);
  assert.match(runner, /readOAuthReceiptMigrationSource/);
  assert.match(runner, /attestAndProbeDeployment\(/);
  assert.match(runner, /sameVercelProductionAttestation/);
  assert.match(runner, /expectedDeploymentIdentity/);
  assert.match(runner, /oauth_deployment_attestation_invalid/);
  assert.match(runner, /oauth_contract_precedes_drain/);
  assert.match(runner, /verifyFrozenSurfaces\(/);
  assert.match(
    runner,
    /probeOAuthApplication\(\s*checkedOrigin,\s*fetchImpl,\s*expectedApplicationIdentity/u,
  );
  assert.match(runner, /attestAndProbeCurrentDeployment/);
  assert.match(runner, /analytics_maintenance_bounds_ready/);
  assert.match(runner, /post_contract_owner_only_rpcs_ready/);
  assert.match(runner, /oauth_expand_incomplete/);
  assert.match(runner, /oauth_contract_precondition_failed/);
  assert.match(
    runner,
    /stage === "contract" \? expectedQualification : null/,
  );
  assert.match(
    runner,
    /insert into public\.oauth_rollout_deployment_qualifications/,
  );
  assert.match(
    runner,
    /provider_function_timeout_seconds[\s\S]*BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS/,
  );
  assert.match(
    migration,
    /provider_function_timeout_seconds[\s\S]*check[\s\S]*provider_function_timeout_seconds = 300/u,
  );
  assert.match(runner, /OAUTH_PRUNE_ACK_KEYS[\s\S]*terminalRetentionBacklog/);
  assert.match(oauthPgtap, /terminalRetentionBacklog/);
  assert.match(
    migration,
    /revoke all on function public\.reassign_anon_data\(uuid, uuid\)[\s\S]*grant execute on function public\.reassign_anon_data\(uuid, uuid\)\s+to service_role/u,
  );
  assert.match(
    migration,
    /create table public\.legacy_signup_migration_receipts[\s\S]*grant execute on function public\.consume_legacy_signup_migration\([\s\S]*to service_role/u,
  );
  assert.match(
    contractMigration,
    /revoke all on function public\.reassign_anon_data\(uuid, uuid\)[\s\S]*from public, anon, authenticated, service_role/u,
  );
  assert.match(
    contractMigration,
    /revoke all on function public\.consume_legacy_signup_migration\([\s\S]*from public, anon, authenticated, service_role/u,
  );
  assert.match(oauthCleanupPgtap, /legacy_signup_migration_receipts/u);
  assert.match(oauthPgtap, /consume_legacy_signup_migration/u);
  assert.match(
    runner,
    /target_auth_created_at[\s\S]*bp_0093_oauth_target_generation_matches[\s\S]*auth_user_generation_fences_ready[\s\S]*auth_session_generation_fence_ready/u,
  );
  assert.match(
    runner,
    /readOAuthExpandFunctionBodyManifest[\s\S]*oauth_function_bodies_ready/u,
  );
  assert.match(
    targetFence,
    /target_auth_created_at[\s\S]*bp_0093_oauth_target_generation_matches[\s\S]*target_generation_fences_ready/u,
  );
  assert.match(
    targetFence,
    /render-oauth-catalog-integrity-query\.mjs[\s\S]*--stage contract[\s\S]*catalog_integrity/u,
  );
  assert.match(
    catalogVerifier,
    /pg_catalog\.sha256[\s\S]*p\.prosecdef[\s\S]*p\.proconfig[\s\S]*p\.proowner/u,
  );
  assert.match(
    catalogVerifier,
    /pg_get_expr[\s\S]*oauth_flow_intents_target_identity_check[\s\S]*owner_integrity/u,
  );
  assert.match(
    runner,
    /t\.tgtype = 27[\s\S]*trg_oauth_rollout_deployment_qualification_append_only/u,
  );
  assert.match(
    runner,
    /t\.tgtype = 27[\s\S]*trg_legacy_signup_migration_receipt_append_only/u,
  );
  assert.match(
    targetFence,
    /trg_legacy_signup_migration_receipt_append_only[\s\S]*tgtype = 27/u,
  );
  assert.match(
    contractMigration,
    /boss_paegi_oauth_contract_qualification_injection_point[\s\S]*assert_oauth_rollout_deployment_qualification/u,
  );
  assert.match(
    postContractMigration,
    /boss_paegi_oauth_post_contract_catalog_injection_point[\s\S]*0095 requires the staged post-contract runner/u,
  );
  assert.match(
    postContractMigration,
    /aclexplode[\s\S]*a\.grantee = v_service_role_oid[\s\S]*a\.grantee not in \(p\.proowner, v_service_role_oid\)/u,
  );
  assert.match(
    allCommands,
    /apply-oauth-production-rollout\.mjs --stage post-contract --apply/u,
  );
  assert.doesNotMatch(allCommands, /--range 0093 0094/);
  assert.match(runbook, /0093과 0094를 한 요청[\s\S]*적용하는 것은\s*금지/);
  assert.match(
    runbook,
    /qa:prod:oauth:expand:apply[\s\S]*qa:prod:oauth:app-postflight[\s\S]*qa:prod:oauth:contract:apply[\s\S]*qa:prod:oauth:post-contract:apply/,
  );
  assert.match(
    runbook,
    /0093을 적용하는 release branch는 `origin\/main`의 후손/,
  );
  assert.match(runbook, /exact `HEAD:main`을 force 없이 \*\*fast-forward\*\* push/);
  assert.match(
    runbook,
    /rebase, cherry-pick, squash merge[\s\S]*receipt 조상을 제거하는 이력 재작성은 금지/,
  );
  assert.match(
    runbook,
    /0093 뒤[\s\S]*`origin\/main`이 움직이면[\s\S]*0093 receipt commit을 조상으로 보존/,
  );

  const grantedRpcSignatures = new Set(
    [...migration.matchAll(
      /grant execute on function\s+public\.([a-z0-9_]+)\(\s*([^()]*)\s*\)\s+to service_role;/gu,
    )]
      .map(
        ([, name, argumentsList]) =>
          `public.${name}(${argumentsList.replace(/\s+/gu, "").toLowerCase()})`,
      )
      .filter(
        (signature) =>
          !signature.startsWith("public.reassign_anon_data(") &&
          !signature.startsWith(
            "public.consume_legacy_signup_migration(",
          ),
      ),
  );
  const probedSignatures = (source: string) =>
    new Set(
      [...source.matchAll(
        // to_regprocedure 리터럴 / ::regprocedure 캐스팅 / 0-arg 직접 호출 —
        // 세 표기 모두 정확 시그니처 인벤토리로 인정한다.
        /(?:pg_catalog\.to_regprocedure\(\s*'([^']+)'\s*\)|'([^']+)'::regprocedure|(public\.[a-z0-9_]+\(\)))/gu,
      )]
        .map(([, direct, cast, call]) => direct ?? cast ?? call)
        .filter((signature) => grantedRpcSignatures.has(signature)),
    );
  assert.equal(grantedRpcSignatures.size, 25);
  assert.deepEqual(
    probedSignatures(runner),
    grantedRpcSignatures,
    "the production gate must inventory every flow-scoped service RPC",
  );
  assert.deepEqual(
    probedSignatures(oauthPgtap + oauthCleanupPgtap),
    grantedRpcSignatures,
    "the pgTAP suites must inventory every flow-scoped service RPC",
  );
  for (const source of [runner, oauthPgtap]) {
    assert.match(source, /public\.oauth_flow_intents/);
    assert.match(source, /public\.oauth_anon_auth_cleanup_jobs/);
    assert.match(
      source,
      /public\.oauth_rollout_deployment_qualifications/,
    );
  }
});

test("Node unit runner discovers test files recursively and deterministically", () => {
  const runner = readFileSync(
    new URL("scripts/qa/run-node-tests.mjs", root),
    "utf8"
  );

  assert.equal(pkg.scripts.test, "node scripts/qa/run-node-tests.mjs");
  assert.match(runner, /async function discover\(directory\)/);
  assert.match(runner, /entry\.isDirectory\(\)/);
  assert.match(runner, /testFilePattern\.test\(entry\.name\)/);
  assert.match(runner, /\.sort\(\(left, right\)/);
  assert.match(runner, /No Node test files discovered under __tests__/);
});

test("stateful QA harness cleanup is exact and cannot report false green", () => {
  const cleanupHardenedHarnesses = [
    "test-account-child-delete-race.sh",
    "test-admin-credit-adjust-race.sh",
    "test-admin-mutation-races.sh",
    "test-anon-reassign-race.sh",
    "test-anon-reassign-write-race.sh",
    "test-consent-delete-races.sh",
    "test-fal-submit-races.sh",
    "test-legal-state-machine-race.sh",
    "test-moderation-purge-races.sh",
    "test-oauth-migration-member-races.sh",
    "test-order-observation-races.sh",
    "test-public-score-report-quota-races.sh",
    "test-public-write-quota-races.sh",
    "test-reactivation-auth-api.sh",
    "test-report-submission-race.sh",
    "test-score-ban-race.sh",
  ];

  for (const file of cleanupHardenedHarnesses) {
    const absolute = new URL(`scripts/qa/${file}`, root);
    const harness = readFileSync(absolute, "utf8");
    const syntax = spawnSync("bash", ["-n", absolute.pathname], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, `${file}: ${syntax.stderr}`);
    assert.match(harness, /original_status=\$\?/);
    assert.match(harness, /cleanup_failed=0/);
    assert.match(harness, /cleanup_remaining=""/);
    assert.match(harness, /pg_catalog\.count\(\*\)/);
    assert.match(harness, /original_status == 0/);
    assert.match(harness, /exit 1/);
  }

  for (const file of [
    "test-account-child-delete-race.sh",
    "test-admin-credit-adjust-race.sh",
    "test-admin-mutation-races.sh",
    "test-consent-delete-races.sh",
    "test-fal-submit-races.sh",
    "test-moderation-purge-races.sh",
    "test-order-observation-races.sh",
    "test-public-score-report-quota-races.sh",
    "test-report-submission-race.sh",
  ]) {
    const harness = readFileSync(
      new URL(`scripts/qa/${file}`, root),
      "utf8",
    );
    assert.match(
      harness,
      /'boss_paegi\.privacy_retention_delete',[\s\S]*'008904:v1'/,
      `${file} must use the transaction-local retention cleanup capability`,
    );
  }

  const publicWrite = readFileSync(
    new URL("scripts/qa/test-public-write-quota-races.sh", root),
    "utf8",
  );
  assert.match(
    publicWrite,
    /telemetry_budget_backup_hex[\s\S]*json_populate_record[\s\S]*restored_budget_hex/,
  );

  const adminAdjust = readFileSync(
    new URL("scripts/qa/test-admin-credit-adjust-race.sh", root),
    "utf8",
  );
  assert.match(
    adminAdjust,
    /delete from public\.credit_ledger[\s\S]*delete from public\.credit_lots/,
    "credit-ledger children must be removed before their referenced lots",
  );
  assert.match(
    adminAdjust,
    /cleanup_remaining="\$\([\s\S]*from public\.credit_ledger[\s\S]*from public\.credit_lots/,
    "the exact cleanup postcondition must cover both ledger and lot rows",
  );

  const oauthMemberRace = readFileSync(
    new URL(
      "scripts/qa/test-oauth-migration-member-races.sh",
      root,
    ),
    "utf8",
  );
  assert.match(
    oauthMemberRace,
    /delete from public\.oauth_flow_intents[\s\S]*delete from public\.scores[\s\S]*delete from public\.member_accounts[\s\S]*delete from auth\.users/u,
    "OAuth member-race cleanup must remove flow children, score children, target members, then Auth users",
  );
  assert.match(
    oauthMemberRace,
    /cleanup_remaining="\$\([\s\S]*from public\.oauth_flow_intents[\s\S]*from public\.oauth_anon_auth_cleanup_jobs[\s\S]*from public\.scores[\s\S]*from public\.member_accounts[\s\S]*from auth\.users/u,
    "OAuth member-race cleanup must prove every owned durable fixture is absent",
  );

  for (const file of [
    "test-anon-reassign-race.sh",
    "test-anon-reassign-write-race.sh",
  ]) {
    const harness = readFileSync(
      new URL(`scripts/qa/${file}`, root),
      "utf8",
    );
    assert.match(
      harness,
      /delete from public\.oauth_anon_auth_cleanup_jobs[\s\S]*set local session_replication_role = replica[\s\S]*delete from public\.anon_data_reassignments/u,
      `${file} must remove cleanup-job children before disabling receipt cascade triggers`,
    );
    assert.match(
      harness,
      /cleanup_remaining="\$\([\s\S]*from public\.oauth_anon_auth_cleanup_jobs[\s\S]*from public\.anon_data_reassignments/u,
      `${file} must include cleanup jobs in its exact residue proof`,
    );
  }
});

test("checkout race owns and restores its deterministic product fixture", () => {
  const harness = readFileSync(
    new URL("scripts/qa/test-checkout-delete-race.sh", root),
    "utf8"
  );

  assert.match(harness, /row_to_json\(s\)/);
  assert.match(harness, /json_populate_record/);
  assert.match(harness, /qa_checkout_race/);
  assert.match(harness, /create_or_reuse_pending_order/);
  assert.doesNotMatch(harness, /select public\.create_pending_order\(/);
  assert.match(harness, /expected_store_id,expected_currency,expected_channel_key/);
  assert.match(harness, /failed to restore growth_levers/);

  const concurrency = readFileSync(
    new URL("scripts/qa/test-checkout-concurrency-races.sh", root),
    "utf8"
  );
  // 최신 스키마 단일 검증(v0.91): 영구 19-arg 경계의 동시 수렴 + response-loss
  // retry 가 현행 문구 계약(v2/v3)으로 검증된다. 시대(stage) 게이트는 없어야 한다.
  assert.match(concurrency, /create_or_reuse_pending_order/);
  assert.match(concurrency, /credits-offer-2026-08-19-v3/);
  assert.match(concurrency, /checkout-withdrawal-limit-2026-08-19-v2/);
  assert.match(
    concurrency,
    /reused\|\$uuid_withdrawal_owner\|\$owner_evidence\|\$withdrawal_request_id/,
  );
  assert.match(concurrency, /order and withdrawal evidence did not commit atomically/);
  assert.match(concurrency, /failed to restore growth_levers/);
  assert.match(concurrency, /source scripts\/qa\/lib\/wait-sync\.sh/);
  assert.doesNotMatch(concurrency, /rollout_stage/);
  assert.doesNotMatch(concurrency, /expand/);
});
