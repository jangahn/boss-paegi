import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../../app/api/admin/cancel/route.ts", import.meta.url),
  "utf8",
);
const expandMigration = readFileSync(
  new URL(
    "../../supabase/migrations/008899_server_read_surface_rollout_gate.sql",
    import.meta.url,
  ),
  "utf8",
);
const contractMigration = readFileSync(
  new URL(
    "../../supabase/migrations/0092_rollout_contract_cleanup.sql",
    import.meta.url,
  ),
  "utf8",
);

test("admin cancel keeps every non-terminal PortOne payment id unresolved", () => {
  const nonPortoneStart = route.indexOf(
    'if (order.provider !== "portone")',
  );
  const snapshotStart = route.indexOf(
    "const snapRes = await getPortonePaymentSnapshot",
  );
  assert.ok(nonPortoneStart > 0 && snapshotStart > nonPortoneStart);

  const preSnapshot = route.slice(nonPortoneStart, snapshotStart);
  assert.match(preSnapshot, /return localCancel\(/);
  assert.match(
    preSnapshot,
    /if \(!order\.payment_id \|\| !portoneCancelConfigured\(\)\)/,
  );
  assert.equal(
    (route.match(/return localCancel\(/g) ?? []).length,
    1,
    "only the explicit non-PortOne branch may call localCancel",
  );

  const notFoundStart = route.indexOf(
    'if (snapRes.kind === "not_found")',
  );
  const evidenceStart = route.indexOf(
    "const snapshot = snapRes.snapshot",
  );
  const notFoundBranch = route.slice(notFoundStart, evidenceStart);
  assert.match(notFoundBranch, /status: "NOT_FOUND"/);
  assert.match(notFoundBranch, /error: "pg_state_pending"/);
  assert.doesNotMatch(notFoundBranch, /localCancel\(/);

  const retryableStart = route.indexOf('case "READY":');
  const defaultStart = route.indexOf("default:", retryableStart);
  const retryableBranch = route.slice(retryableStart, defaultStart);
  assert.match(retryableBranch, /case "PENDING":/);
  assert.match(retryableBranch, /case "FAILED":/);
  assert.match(retryableBranch, /error: "pg_state_pending"/);
  assert.doesNotMatch(retryableBranch, /localCancel\(/);
});

test("only exact CANCELLED observation owns PortOne unpaid terminalization", () => {
  const cancelledStart = route.indexOf('case "CANCELLED":');
  const paidStart = route.indexOf('case "PAID":', cancelledStart);
  const cancelledBranch = route.slice(cancelledStart, paidStart);
  assert.match(cancelledBranch, /handleObservedCancellation\(/);
  assert.doesNotMatch(cancelledBranch, /localCancel\(/);
});

test("both administrative SQL overloads reject PortOne local cancellation", () => {
  const fiveArg = expandMigration.indexOf(
    "create or replace function public.admin_cancel_order(\n" +
      "  p_admin uuid,\n" +
      "  p_order_uuid uuid,\n" +
      "  p_clawback boolean,\n" +
      "  p_reason text,\n" +
      "  p_pg_done boolean",
  );
  const fourArg = expandMigration.indexOf(
    "create or replace function public.admin_cancel_order(\n" +
      "  p_admin uuid,\n" +
      "  p_order_uuid uuid,\n" +
      "  p_clawback boolean,\n" +
      "  p_reason text\n)",
    fiveArg + 1,
  );
  assert.ok(fiveArg > 0 && fourArg > fiveArg);

  for (const body of [
    expandMigration.slice(fiveArg, fourArg),
    expandMigration.slice(
      fourArg,
      expandMigration.indexOf(
        "-- Expand-only provider-evidence adoption",
        fourArg,
      ),
    ),
  ]) {
    assert.match(body, /if v_provider = 'portone' then/);
    assert.match(
      body,
      /portone_cancellation_requires_provider_observation/,
    );
    assert.match(body, /public\.bp_0084_admin_cancel_order_impl\(/);
  }
  assert.match(
    contractMigration,
    /0092 postflight: PortOne local cancellation fence drift/,
  );
});
