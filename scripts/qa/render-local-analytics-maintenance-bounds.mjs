#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MARKER =
  "-- boss_paegi_oauth_post_contract_catalog_injection_point";
const RAW_GUARD = [
  "do $boss_paegi_raw_post_contract_guard$",
  "begin",
  "  raise exception '0095 requires the staged post-contract runner'",
  "    using errcode = 'P0001';",
  "end;",
  "$boss_paegi_raw_post_contract_guard$;",
].join("\n");
const AUTHORIZATION_BOUNDARY = `${MARKER}\n${RAW_GUARD}`;

export async function renderLocalAnalyticsMaintenanceBoundsFixture() {
  const sql = await readFile(
    new URL(
      "../../supabase/migrations/0095_analytics_maintenance_argument_bounds.sql",
      import.meta.url,
    ),
    "utf8",
  );
  if (
    sql.split(MARKER).length - 1 !== 1 ||
    sql.split(RAW_GUARD).length - 1 !== 1 ||
    sql.split(AUTHORIZATION_BOUNDARY).length - 1 !== 1
  ) {
    throw new Error(
      "local_analytics_maintenance_bounds_authorization_invalid",
    );
  }
  const rendered = sql.replace(
    AUTHORIZATION_BOUNDARY,
    [
      "-- Local disposable-DB post-contract authorization fixture;",
      "-- never production rollout authority or a migration receipt.",
    ].join("\n"),
  );
  if (
    rendered === sql ||
    rendered.includes(MARKER) ||
    rendered.includes(RAW_GUARD)
  ) {
    throw new Error(
      "local_analytics_maintenance_bounds_render_invalid",
    );
  }
  return rendered;
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length !== 0 ||
    process.env
      .BOSS_PAEGI_LOCAL_ANALYTICS_MAINTENANCE_BOUNDS_FIXTURE !== "1"
  ) {
    console.error(
      "Local analytics maintenance bounds fixture blocked: explicit local runner fence missing.",
    );
    return 2;
  }
  try {
    process.stdout.write(
      await renderLocalAnalyticsMaintenanceBoundsFixture(),
    );
    return 0;
  } catch {
    console.error(
      "Local analytics maintenance bounds fixture rendering failed.",
    );
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
