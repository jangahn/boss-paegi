import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("remote observation writes use status, paid-at, and marker CAS with a durable reread", () => {
  const source = read("lib/pay/order-observation-write.ts");
  const migration = read(
    "supabase/migrations/008899_server_read_surface_rollout_gate.sql",
  );

  assert.match(source, /record_unsettled_order_observation/);
  assert.match(source, /isObservationAck\(ack\)/);
  assert.match(
    source,
    /\.select\("status, paid_at, error_message, pg_status, raw"\)[\s\S]*parsePaidOrderPostcondition\(current\)/,
  );
  assert.match(source, /current\.error_message === postcondition\.errorMessage/);
  assert.match(
    source,
    /current\.pg_status === postcondition\.pgStatus[\s\S]*raw\?\.verified_status === postcondition\.pgStatus/,
  );
  assert.match(
    migration,
    /record_unsettled_order_observation[\s\S]*for update[\s\S]*o\.status is distinct from p_expected_status[\s\S]*o\.error_message is distinct from p_expected_error_message/,
  );
  assert.match(migration, /o\.paid_at is not null/);
});

test("payment surfaces do not directly overwrite observation columns", () => {
  for (const path of [
    "app/api/pay/webhook/route.ts",
    "app/api/pay/order-status/route.ts",
    "app/api/ops/reconcile/route.ts",
  ]) {
    const source = read(path);
    assert.doesNotMatch(
      source,
      /\.from\("orders"\)[\s\S]{0,180}\.update\(\{[\s\S]{0,180}(?:error_message|pg_status|raw)/,
      `${path} must use the fenced observation writer`,
    );
    assert.match(source, /recordOrderEvidenceMarkerIfUnsettled/);
  }

  const webhook = read("app/api/pay/webhook/route.ts");
  assert.match(webhook, /recordOrderProviderStateIfUnsettled/);
});

test("late-paid reconciliation closure requires economic proof and repairs legacy closures", () => {
  const gate = read(
    "supabase/migrations/008899_server_read_surface_rollout_gate.sql",
  );
  const cleanup = read("supabase/migrations/0092_rollout_contract_cleanup.sql");
  const actions = read("components/admin/RefundQueueActions.tsx");

  assert.match(
    gate,
    /if i\.type = 'late_paid'[\s\S]*p_resolution = 'ignored'[\s\S]*economic_resolution_required/,
  );
  assert.match(
    gate,
    /v_order\.refunded_credits[\s\S]*v_order\.credits[\s\S]*v_order\.refunded_amount[\s\S]*v_order\.amount/,
  );
  for (const source of [gate, cleanup]) {
    assert.match(
      source,
      /update public\.reconciliation_issues i[\s\S]*economic_reopen_reason[\s\S]*late_paid_refund_incomplete/,
    );
  }
  assert.match(
    actions,
    /props\.issueType === "late_paid"[\s\S]*\["reconcile", "resolve"\][\s\S]*\["resolve"\]/,
  );
});

test("observation-finalizer races run as a real two-session CI gate", () => {
  const harness = read("scripts/qa/test-order-observation-races.sh");
  const packageJson = read("package.json");
  const workflow = read(".github/workflows/quality.yml");

  assert.match(packageJson, /"qa:db:order-observation-race"/);
  assert.match(workflow, /npm run qa:db:order-observation-race/);
  assert.match(harness, /stale observer after READY read/);
  assert.match(harness, /stale observer did not return terminal after PAID won/);
  assert.match(harness, /paid finalizer waiting on observation row lock/);
  assert.match(harness, /pg_catalog\.pg_blocking_pids/);
  assert.match(harness, /deadlocks_after/);
  assert.match(harness, /paid\|PAID\|NULL\|\$record_tx\|3\|1\|1/);
});
