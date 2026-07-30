import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

const migration = source(
  "supabase/migrations/008902_financial_projection_bounds.sql",
);
const contractMigration = source(
  "supabase/migrations/0092_rollout_contract_cleanup.sql",
);
const pgtap = source(
  "supabase/tests/financial_projection_bounds.pgtap.sql",
);

test("auto-full computes exact projection bytes before bounded aggregation", () => {
  assert.match(
    migration,
    /pg_catalog\.octet_length\(\s*pg_catalog\.jsonb_build_object\(/,
  );
  assert.match(
    migration,
    /\+ \(2::numeric \* \(pg_catalog\.count\(\*\) - 1\)::numeric\)/,
  );
  const boundCheck = migration.indexOf("v_projected_bytes > 32768::numeric");
  const boundedAggregate = migration.indexOf(
    "select pg_catalog.jsonb_agg(",
  );
  assert.ok(boundCheck >= 0);
  assert.ok(boundedAggregate > boundCheck);
  assert.match(
    migration,
    /if pg_catalog\.octet_length\(v_projection::text\) <> v_projected_bytes/,
  );
});

test("over-cap cancellation converges to reason-bound immutable evidence", () => {
  assert.match(migration, /then 'projection_too_large'/);
  assert.match(migration, /'reason', v_ineligible_reason/);
  assert.match(migration, /'event_count', v_count/);
  assert.match(migration, /'projected_bytes', v_projected_bytes/);
  assert.match(migration, /'total', v_total_numeric/);
  assert.match(migration, /'credits', o\.credits/);
  assert.match(
    migration,
    /'ineligible',\s+v_hash,\s+2,\s+null[\s\S]*return pg_catalog\.jsonb_build_object/,
  );
  assert.match(
    migration,
    /revoke all on function\s+public\.bp_0084_resolve_external_cancellation_auto_full_impl\(uuid\)[\s\S]*service_role/,
  );
});

test("real SQL regression covers both a 100-event success and 125-event overflow", () => {
  assert.match(pgtap, /generate_series\(1, 100\)/);
  assert.match(pgtap, /generate_series\(1, 125\)/);
  assert.match(pgtap, /repeat\('x', 245\)/);
  assert.match(pgtap, /'resolved_full'/);
  assert.match(pgtap, /'projection_too_large'/);
  assert.match(pgtap, /\["paid", 0, 0\]/);
  assert.match(pgtap, /resolution_batch_id is not null/);
});

test("0092 retires the caller-free unbounded live-lot RPC after request drain", () => {
  assert.match(
    contractMigration,
    /revoke all on function public\.get_my_credits\(uuid\)[\s\S]*drop function if exists public\.get_my_credits\(uuid\)/,
  );
  assert.match(
    contractMigration,
    /to_regprocedure\(\s*'public\.get_my_credits\(uuid\)'\s*\) is not null[\s\S]*unbounded credit-lot RPC still exists/,
  );
});
