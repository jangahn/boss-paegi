import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(
    HERE,
    "../../supabase/migrations/0073_generation_terminal_state_machine.sql",
  ),
  "utf8",
);
const recoveryRoute = readFileSync(
  join(HERE, "../../app/api/ops/gen-recover/route.ts"),
  "utf8",
);

function between(start: string, end: string): string {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing marker: ${start}`);
  assert.ok(to > from, `missing marker: ${end}`);
  return migration.slice(from, to);
}

test("failure/refund checks caller version before writes and refunds at post-transition version", () => {
  const fn = between(
    "create or replace function public.mark_generation_failed_and_refund",
    "create or replace function public.expire_generation",
  );
  const fence = fn.indexOf("g.version <> p_expected_version");
  const transition = fn.indexOf("set status = 'failed'");
  assert.ok(fence >= 0 && transition > fence);
  assert.match(fn, /returning version into v_refund_version/);
  assert.match(
    fn,
    /refund_gen_credit_v2\(p_gen_id, v_refund_version\)/,
  );
  assert.doesNotMatch(
    fn,
    /refund_gen_credit_v2\(p_gen_id, p_expected_version\)/,
  );
});

test("artifact cleanup is serialized behind a separate write lease and includes failed rows", () => {
  assert.match(
    migration,
    /create table if not exists public\.generation_artifact_write_leases/,
  );
  assert.match(
    migration,
    /create or replace function public\.claim_generation_artifact_write/,
  );
  assert.match(
    migration,
    /create or replace function public\.begin_generation_artifact_cleanup[\s\S]*'write_busy'/,
  );
  assert.match(
    migration,
    /create or replace function public\.reopen_generation_artifact_cleanup/,
  );
  assert.match(
    migration,
    /where status in \('failed', 'picked', 'expired'\)[\s\S]*artifacts_cleaned_at is null/,
  );
  assert.doesNotMatch(
    migration,
    /grant update \(artifacts_cleaned_at\)[\s\S]*to service_role/,
  );
});

test("deleted-owner sweep joins actual inflight work and has deterministic fair ordering", () => {
  const fn = between(
    "create or replace function public.list_deleted_owner_inflight_generations",
    "-- Keep the failure/refund RPC terminal-safe",
  );
  assert.match(
    fn,
    /from public\.ai_generations g[\s\S]*join public\.profiles p/,
  );
  assert.match(fn, /g\.status in \('queued', 'done'\)/);
  assert.match(fn, /order by g\.updated_at asc, g\.id asc/);
  assert.match(
    recoveryRoute,
    /rpc\(\s*"list_deleted_owner_inflight_generations"/,
  );
  assert.doesNotMatch(
    recoveryRoute,
    /\.from\("profiles"\)[\s\S]{0,300}\.limit\(1000\)/,
  );
});
