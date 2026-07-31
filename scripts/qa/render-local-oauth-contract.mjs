#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MARKER =
  "-- boss_paegi_oauth_contract_qualification_injection_point";
const EXPAND_VERSION = "0093_oauth_flow_intents";
const CONTRACT_VERSION = "0094_oauth_flow_migration_contract";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function renderLocalOAuthContractFixture() {
  const [expandSql, contractSql] = await Promise.all([
    readFile(
      new URL(
        "../../supabase/migrations/0093_oauth_flow_intents.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../supabase/migrations/0094_oauth_flow_migration_contract.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  if (
    contractSql.split(MARKER).length !== 2 ||
    !contractSql.includes(
      "select public.assert_oauth_rollout_deployment_qualification(",
    )
  ) {
    throw new Error("local_oauth_contract_marker_invalid");
  }
  const fixture = [
    "-- Local disposable-DB qualification fixture; never production evidence.",
    "insert into public.oauth_rollout_deployment_qualifications (",
    "  contract_version, expand_version,",
    "  expand_migration_hash, expand_manifest_hash,",
    "  expand_app_commit, deployment_app_commit,",
    "  deployment_source_tree, provider, provider_team_id,",
    "  provider_project_id, provider_deployment_id,",
    "  provider_deployment_url, production_alias, alias_uid,",
    "  provider_function_timeout_seconds,",
    "  deployment_created_at, provider_ready_at,",
    "  alias_current_since, evidence_sha256, qualified_at",
    ") values (",
    `  '${CONTRACT_VERSION}',`,
    `  '${EXPAND_VERSION}',`,
    `  '${sha256(expandSql)}',`,
    `  '${"f".repeat(64)}',`,
    `  '${"a".repeat(40)}',`,
    `  '${"b".repeat(40)}',`,
    `  '${"c".repeat(40)}',`,
    "  'vercel',",
    "  'team_NmYBq4k4t5BbaQKQNAHRgu8a',",
    "  'prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU',",
    "  'dpl_localfixture000000',",
    "  'boss-paegi-local-oauth-contract.vercel.app',",
    "  'boss-paegi.vercel.app',",
    `  '${"d".repeat(64)}',`,
    "  300,",
    "  pg_catalog.clock_timestamp() - interval '1800 seconds',",
    "  pg_catalog.clock_timestamp() - interval '1700 seconds',",
    "  pg_catalog.clock_timestamp() - interval '1510 seconds',",
    `  '${"e".repeat(64)}',`,
    "  pg_catalog.clock_timestamp()",
    ");",
  ].join("\n");
  const rendered = contractSql.replace(MARKER, fixture);
  if (
    rendered === contractSql ||
    rendered.includes(MARKER) ||
    rendered.indexOf(
      "insert into public.oauth_rollout_deployment_qualifications",
    ) >
      rendered.indexOf(
        "select public.assert_oauth_rollout_deployment_qualification(",
      )
  ) {
    throw new Error("local_oauth_contract_render_invalid");
  }
  return rendered;
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length !== 0 ||
    process.env.BOSS_PAEGI_LOCAL_OAUTH_CONTRACT_FIXTURE !== "1"
  ) {
    console.error(
      "Local OAuth contract fixture blocked: explicit local runner fence missing.",
    );
    return 2;
  }
  try {
    process.stdout.write(await renderLocalOAuthContractFixture());
    return 0;
  } catch {
    console.error("Local OAuth contract fixture rendering failed.");
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
