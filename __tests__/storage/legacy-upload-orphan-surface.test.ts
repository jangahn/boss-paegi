import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("legacy upload recovery is finite, contract-gated, and RPC-only", () => {
  const expand = source(
    "supabase/migrations/0079_storage_cleanup_intents.sql",
  );
  const scanner = source(
    "supabase/migrations/008899_server_read_surface_rollout_gate.sql",
  );
  const contract = source(
    "supabase/migrations/0092_rollout_contract_cleanup.sql",
  );

  assert.match(expand, /storage_legacy_upload_sweep_control/);
  assert.match(expand, /inventory_floor_at timestamptz not null/);
  assert.match(expand, /enable row level security/);
  assert.match(
    scanner,
    /create or replace function public\.enqueue_legacy_signed_upload_orphans/,
  );
  assert.match(
    scanner,
    /o\.created_at >= v_control\.inventory_floor_at[\s\S]*?o\.created_at <= v_control\.window_ends_at/,
  );
  assert.match(scanner, /interval '2 hours 15 minutes'/);
  assert.match(
    scanner,
    /pg_advisory_xact_lock[\s\S]*?bp_storage_path_is_referenced[\s\S]*?'pending'/,
  );
  assert.match(
    scanner,
    /revoke all on function public\.enqueue_legacy_signed_upload_orphans\(integer\)[\s\S]*?grant execute[\s\S]*?to service_role/,
  );
  assert.match(
    contract,
    /window_ends_at[\s\S]*?interval '2 hours 5 minutes'/,
  );
  assert.match(
    contract,
    /contract_reference_snapshot[\s\S]*?bp_rollout_compatibility_enabled/,
  );
});

test("content maintenance exposes disabled, malformed, backlog, and error states", () => {
  const route = source("app/api/ops/content-maintain/route.ts");
  const rpc = route.indexOf('"enqueue_legacy_signed_upload_orphans"');
  const parse = route.indexOf("parseLegacyUploadOrphanSweep(", rpc);
  const disabled = route.indexOf("!sweep.enabled", parse);
  const retry = route.indexOf(
    "result.legacyUploadOrphansEnqueued +",
    disabled,
  );
  assert.ok(rpc >= 0 && parse > rpc, "RPC result must be parsed");
  assert.ok(disabled > parse, "disabled rollout gate must fail visibly");
  assert.ok(retry > disabled, "new durable receipts must remain retry work");
  assert.match(route, /legacyUploadSweepErrors \+= 1/);
  assert.match(
    route,
    /boundedBatchMayHaveMore\([\s\S]*?sweep\.examined,[\s\S]*?LEGACY_UPLOAD_SWEEP_LIMIT/,
  );
});

test("both advisory-lock orderings have a real PostgreSQL race harness", () => {
  const script = source(
    "scripts/qa/test-legacy-upload-orphan-races.sh",
  );
  assert.match(script, /reference→scan/);
  assert.match(script, /scan→reference/);
  assert.match(script, /wait_event_type = 'Lock'/);
  assert.match(script, /upload_cleanup_in_progress/);
  assert.doesNotMatch(script, /\bsleep [1-9][0-9]*(?:\.[0-9]+)?\b/);
});
