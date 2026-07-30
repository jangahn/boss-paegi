import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function migration(name: string): string {
  return readFileSync(
    new URL(`../../supabase/migrations/${name}`, import.meta.url),
    "utf8"
  );
}

test("credit adjustment rollout keeps old and new servers live across the deploy boundary", () => {
  const expand = migration("0082_admin_credit_adjust_idempotency.sql");
  const lockOrder = migration("0084_user_mutation_lock_order.sql");
  const gate = migration("008899_server_read_surface_rollout_gate.sql");
  const contract = migration("0092_rollout_contract_cleanup.sql");

  assert.match(
    expand,
    /grant execute on function public\.admin_adjust_credits\(uuid, uuid, int, text\)\s+to service_role;/
  );
  assert.match(
    expand,
    /grant execute on function public\.admin_adjust_credits\(uuid, uuid, int, text, uuid\)\s+to service_role;/
  );
  assert.match(
    lockOrder,
    /create function public\.admin_adjust_credits\(\s*p_admin uuid,\s*p_target uuid,\s*p_delta integer,\s*p_reason text\s*\)/
  );
  assert.match(
    gate,
    /public\.admin_adjust_credits\(uuid,uuid,integer,text\)/
  );
  assert.match(
    contract,
    /drop function if exists public\.admin_adjust_credits\(uuid, uuid, int, text\);/
  );
  assert.match(
    contract,
    /to_regprocedure\(\s*'public\.admin_adjust_credits\(uuid,uuid,integer,text\)'/
  );
});

test("rollout compatibility DML is retained only until the contract migration", () => {
  const score = migration("0074_score_submission_integrity.sql");
  const storage = migration("0079_storage_cleanup_intents.sql");
  const report = migration("0080_atomic_content_report_submission.sql");
  const reviewer = migration("0083_reviewer_account_saga.sql");
  const contract = migration("0092_rollout_contract_cleanup.sql");

  assert.match(score, /legacy_score_submission/);
  assert.match(score, /legacyRollingSubmission/);
  assert.match(storage, /grant delete on table public\.dolls to authenticated/);
  assert.match(report, /grant insert on table public\.content_reports to service_role/);
  assert.match(
    reviewer,
    /grant select, insert, update, delete on table public\.reviewer_accounts/
  );

  assert.match(
    contract,
    /as \$\$\s*select false;\s*\$\$;/
  );
  assert.match(
    contract,
    /revoke delete on table public\.dolls from authenticated/
  );
  assert.match(
    contract,
    /revoke insert on table public\.content_reports from service_role/
  );
  assert.match(
    contract,
    /revoke insert, update, delete on table public\.reviewer_accounts/
  );
});

test("0087 function-definition postflight accepts PostgreSQL whitespace while checking the full cancel intent payload", () => {
  const gate = migration("008899_server_read_surface_rollout_gate.sql");

  assert.match(
    gate,
    /v_atomic_def !~ \(\s*'v_order\[.\]cancel_requested_at\[\[:space:\]\]\+is\[\[:space:\]\]\+not'[\s\S]*'p_customer_requested_at'\s*\)/,
  );
  assert.match(
    gate,
    /v_atomic_def !~ \(\s*'v_order\[.\]cancel_intent_reason\[\[:space:\]\]\+is\[\[:space:\]\]\+not'[\s\S]*p_reason'\s*\)/,
  );
  assert.doesNotMatch(
    gate,
    /strpos\(\s*v_atomic_def,\s*'v_order\.cancel_requested_at is not distinct from p_customer_requested_at'/,
  );
});

test("permanent purge keeps the old server in expand and closes only its direct contract surface", () => {
  const expand = migration("0085_admin_mutation_idempotency.sql");
  const gate = migration("008899_server_read_surface_rollout_gate.sql");
  const contract = migration("0092_rollout_contract_cleanup.sql");

  assert.match(
    expand,
    /grant execute on function public\.admin_begin_doll_purge\(\s*uuid, uuid, text\s*\) to service_role;/,
  );
  assert.match(
    expand,
    /grant execute on function public\.admin_begin_doll_purge_idempotent\(\s*uuid, uuid, text, text, bigint, uuid\s*\) to service_role;/,
  );
  assert.match(
    expand,
    /grant execute on function public\.get_moderation_purge_status\(\s*uuid, uuid, uuid\s*\) to service_role;/,
  );
  assert.match(gate, /public\.admin_begin_doll_purge\(uuid,uuid,text\)/);
  assert.match(
    contract,
    /revoke all on function public\.admin_begin_doll_purge\(uuid, uuid, text\)\s+from public, anon, authenticated, service_role;/,
  );
  assert.match(
    contract,
    /public\.admin_begin_doll_purge_idempotent\(uuid,uuid,text,text,bigint,uuid\)/,
  );
  assert.match(
    contract,
    /public\.get_moderation_purge_status\(uuid,uuid,uuid\)/,
  );
});

test("reactivation worker expands beside the old complete RPC then contracts to fenced RPC-only access", () => {
  const expand = migration("0085_admin_mutation_idempotency.sql");
  const gate = migration("008899_server_read_surface_rollout_gate.sql");
  const contract = migration("0092_rollout_contract_cleanup.sql");

  assert.match(
    expand,
    /grant execute on function public\.admin_complete_account_reactivation\(\s*uuid, uuid, uuid\s*\) to service_role;/,
  );
  assert.match(
    expand,
    /grant execute on function public\.admin_begin_account_reactivation\(\s*uuid, uuid, text, text, timestamptz, bigint, uuid\s*\) to service_role;/,
  );
  for (const signature of [
    "claim_account_reactivation_job",
    "arm_account_reactivation_auth_fence",
    "finish_account_reactivation_job",
    "get_account_reactivation_status",
    "get_account_reactivation_queue_health",
    "request_account_reactivation_cancellation",
    "claim_account_reactivation_legacy_repair",
    "arm_account_reactivation_legacy_repair_auth_fence",
    "finish_account_reactivation_legacy_repair",
    "get_account_reactivation_legacy_repair_status",
  ]) {
    assert.match(
      expand,
      new RegExp(
        `grant execute on function\\s+public\\.${signature}`,
      ),
    );
    assert.match(gate, new RegExp(`public\\.${signature}`));
    assert.match(contract, new RegExp(`public\\.${signature}`));
  }
  assert.match(
    contract,
    /revoke all on function public\.admin_complete_account_reactivation\(\s*uuid, uuid, uuid\s*\) from public, anon, authenticated, service_role;/,
  );
  assert.match(
    contract,
    /'public\.admin_complete_account_reactivation\(uuid,uuid,uuid\)'/,
  );
  assert.match(
    contract,
    /revoke all on function public\.admin_begin_account_reactivation\(\s*uuid, uuid, text, text, timestamptz, uuid\s*\) from public, anon, authenticated, service_role;/,
  );
  assert.match(
    expand,
    /revoke all on table public\.account_reactivation_jobs\s+from public, anon, authenticated, service_role;/,
  );
  assert.match(
    expand,
    /revoke all on table public\.account_reactivation_legacy_repairs\s+from public, anon, authenticated, service_role;/,
  );
  assert.match(
    expand,
    /grant execute on function public\.admin_reactivate_account\(\s*uuid, uuid, text, text\s*\) to service_role;/,
  );
  assert.match(
    gate,
    /public\.admin_reactivate_account\(uuid,uuid,text,text\)/,
  );
  assert.match(
    contract,
    /revoke all on function public\.admin_reactivate_account\(\s*uuid, uuid, text, text\s*\) from public, anon, authenticated, service_role;/,
  );
  const expandFence = expand.slice(
    expand.indexOf(
      "create or replace function public.bp_fence_account_reactivation_auth_email",
    ),
    expand.indexOf(
      "revoke all on function public.bp_fence_account_reactivation_auth_email",
    ),
  );
  const contractFence = contract.slice(
    contract.indexOf(
      "create or replace function public.bp_fence_account_reactivation_auth_email",
    ),
    contract.indexOf(
      "revoke all on function public.bp_fence_account_reactivation_auth_email",
    ),
  );
  assert.match(
    expandFence,
    /Rolling compatibility is safe only[\s\S]*p\.deleted_at is null[\s\S]*m\.email/,
  );
  assert.doesNotMatch(
    contractFence,
    /Rolling compatibility is safe only/,
  );
  for (const body of [expandFence, contractFence]) {
    assert.match(
      body,
      /j\.lease_token::text = v_fence->>'lease_token'[\s\S]*j\.lease_version[\s\S]*j\.leased_until > pg_catalog\.clock_timestamp\(\)[\s\S]*expected_withdrawal_generation/,
    );
    assert.match(
      body,
      /v_fence->>'action' = 'legacy_repair'[\s\S]*account_reactivation_legacy_repairs[\s\S]*v_new_email =[\s\S]*j\.resolved_email/,
    );
  }
});

test("reactivation contract closes the rolling route only after a locked zero-orphan gate", () => {
  const expand = migration("0085_admin_mutation_idempotency.sql");
  const contract = migration("0092_rollout_contract_cleanup.sql");

  assert.match(
    expand,
    /perform public\.bp_mutation_object_lock\(\s*'reactivation-email-namespace', 'global'\s*\);[\s\S]*insert into public\.account_reactivation_legacy_repairs/,
  );
  assert.match(
    expand,
    /create constraint trigger\s+trg_profiles_enqueue_legacy_account_reactivation_repair[\s\S]*deferrable initially deferred/,
  );
  assert.match(
    contract,
    /perform public\.bp_mutation_object_lock\(\s*'reactivation-email-namespace', 'global'\s*\);[\s\S]*account_reactivation_legacy_repairs[\s\S]*active account Auth email mismatch remains/,
  );
  assert.match(
    expand,
    /left join auth\.users u on u\.id = p\.id[\s\S]*lower\(pg_catalog\.btrim\(u\.email\)\)[\s\S]*is distinct from[\s\S]*lower\(pg_catalog\.btrim\(m\.email\)\)/,
  );
  assert.match(
    contract,
    /left join auth\.users u on u\.id = p\.id[\s\S]*lower\(pg_catalog\.btrim\(u\.email\)\)[\s\S]*is distinct from[\s\S]*lower\(pg_catalog\.btrim\(m\.email\)\)/,
  );
  assert.match(
    expand,
    /create or replace function\s+public\.bp_account_reactivation_auth_transition_lock[\s\S]*create or replace function public\.admin_soft_delete_account[\s\S]*bp_account_reactivation_auth_transition_lock/,
  );
  assert.match(
    contract,
    /create or replace function public\.bp_fence_account_reactivation_auth_email[\s\S]*bp_account_reactivation_auth_transition_lock/,
  );
  assert.match(
    contract,
    /create or replace function public\.bp_rollout_compatibility_enabled[\s\S]*select false;/,
  );
  for (const permanent of [
    "claim_account_reactivation_legacy_repair",
    "arm_account_reactivation_legacy_repair_auth_fence",
    "finish_account_reactivation_legacy_repair",
    "get_account_reactivation_legacy_repair_status",
  ]) {
    assert.doesNotMatch(
      contract,
      new RegExp(
        `revoke all on function public\\.${permanent}[^;]*from service_role`,
      ),
    );
  }
});
