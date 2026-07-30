import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function assertOrdered(
  body: string,
  fragments: readonly string[],
  message: string,
): void {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = body.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${message}: missing/out-of-order ${fragment}`);
    cursor = next;
  }
}

test("event, config, integrity, and moderation routes use receipt-bearing RPCs", () => {
  const event = source("app/api/admin/events/route.ts");
  assert.match(event, /"admin_save_event_idempotent"/);
  assert.match(event, /"admin_transition_event_idempotent"/);
  assert.doesNotMatch(event, /\.rpc\("admin_save_event"/);
  assert.doesNotMatch(event, /\.rpc\("admin_publish_event"/);

  const config = source("lib/config/write.ts");
  assert.match(config, /"admin_update_app_setting_idempotent"/);
  assert.doesNotMatch(config, /\.rpc\("admin_update_app_setting"/);

  for (const action of ["clear", "void", "ban", "unban"]) {
    const body = source(`app/api/admin/integrity/${action}/route.ts`);
    assert.match(body, /"admin_integrity_action_idempotent"/);
    assert.match(body, /p_expected_state/);
    assert.match(body, /p_expected_version/);
  }
  const integrityUi = source("components/admin/IntegrityActions.tsx");
  assert.match(integrityUi, /parseAdminIntegrityMutationResult\(body\)/);
  assert.match(
    integrityUi,
    /result\?\.nextStatus === expectedNextState\[submittedMode\]/,
  );
  assert.match(
    integrityUi,
    /const requestBody = JSON\.stringify\(payload\)[\s\S]*attempt: deliver,[\s\S]*reconcile: deliver/,
  );
  assert.doesNotMatch(integrityUi, /if \(res\.ok\) \{\s*setMode\(null\)/);

  for (const action of ["takedown", "dismiss", "restore"]) {
    const body = source(`app/api/admin/moderation/${action}/route.ts`);
    assert.match(body, /"admin_moderation_action_idempotent"/);
    assert.match(body, /p_expected_state/);
    assert.match(body, /p_expected_version/);
  }
  const moderationUi = source(
    "components/admin/ModerationQueueTable.tsx",
  );
  assert.match(moderationUi, /parseAdminModerationMutationResult\(body\)/);
  assert.match(
    moderationUi,
    /const requestBody = JSON\.stringify\(payload\)[\s\S]*attempt: deliver,[\s\S]*reconcile: deliver/,
  );
  assert.match(moderationUi, /if \(outcome\.kind === "confirmed"\)/);

  const permanent = source(
    "app/api/admin/moderation/permanent-delete/route.ts",
  );
  assert.match(permanent, /"admin_begin_doll_purge_idempotent"/);
  assert.match(permanent, /p_expected_state/);
  assert.match(permanent, /p_expected_version/);
  assert.match(permanent, /p_request_id/);
  assert.doesNotMatch(permanent, /\.rpc\("admin_begin_doll_purge"/);
  assertOrdered(
    permanent,
    [
      "await processModerationPurgeJob(admin, jobId)",
      'if (outcome.kind === "idle")',
      'admin.rpc("get_moderation_purge_status"',
      "parseModerationPurgeStatus(",
      "moderationPurgeHttpStatus(outcome, authoritativeStatus) === 200",
      "return NextResponse.json({ ok: true, purged: true, failed: 0 })",
    ],
    "terminal response-loss retry must read job status before returning 200",
  );
});

test("permanent purge replays its receipt before hidden/version CAS and legacy begin", () => {
  const migration = source(
    "supabase/migrations/0085_admin_mutation_idempotency.sql",
  );
  const start = migration.indexOf(
    "create or replace function public.admin_begin_doll_purge_idempotent",
  );
  assert.ok(start >= 0);
  const body = migration.slice(
    start,
    migration.indexOf("-- ── 5.", start),
  );
  assertOrdered(
    body,
    [
      "v_replay := public.bp_admin_mutation_replay",
      "if v_replay is not null",
      "for update;",
      "v_current := case",
      "v_doll.moderation_version <> p_expected_version",
      "v_result := public.admin_begin_doll_purge",
      "public.bp_admin_mutation_store_completed",
    ],
    "permanent purge receipt/CAS order",
  );
  assert.match(body, /p_expected_state is distinct from 'hidden'/);
  assert.match(body, /'moderation_permanent_delete'/);
  assert.match(
    migration,
    /create or replace function public\.get_moderation_purge_status\([\s\S]*where j\.id = p_job_id[\s\S]*and j\.doll_id = p_doll_id[\s\S]*and j\.admin_user_id = p_admin_id;/,
  );
});

test("event response-loss recovery is scoped to the current editor intent", () => {
  const editor = source("components/admin/EventEditor.tsx");
  assertOrdered(
    editor,
    [
      "const pending = readPendingEventSave();",
      "const matchesPage = event",
      "if (!matchesPage)",
      "recoverPendingEventSave(pending, signal)",
    ],
    "event editor must reject another page's pending intent before recovery",
  );
  const saveStart = editor.indexOf(
    "const save = async (): Promise<{ id: string; version: number } | null>",
  );
  assert.ok(saveStart >= 0);
  assertOrdered(
    editor.slice(saveStart),
    [
      "if (existing)",
      "recoverPendingEventSave(existing, signal)",
      "clearPendingEventSave();",
      "createPendingEventSave(eventId)",
      "savePayload(pending, eventId, eventVersion)",
    ],
    "same-tab retries must resolve an ambiguous delivery before creating another intent",
  );

  const migration = source(
    "supabase/migrations/0085_admin_mutation_idempotency.sql",
  );
  assertOrdered(
    migration,
    [
      "'event-create-intent'",
      "where r.operation = 'event_save'",
      "v_existing.request_payload is distinct from v_payload",
      "bp_admin_mutation_store_completed",
    ],
    "rotated event delivery IDs must converge under the create-intent lock",
  );
});

test("reactivation route hands pending receipts to the durable fenced worker", () => {
  const route = source("app/api/admin/reactivate/route.ts");
  const userDetail = source("app/admin/users/[id]/page.tsx");
  const form = source("components/admin/ReactivateAccountForm.tsx");
  const adminUsers = source("lib/admin-users.ts");
  const authApiHarness = source(
    "scripts/qa/test-reactivation-auth-api.sh",
  );
  const authApiStep = source(
    "scripts/qa/reactivation-auth-api-step.mjs",
  );
  const raceHarness = source("scripts/qa/test-admin-mutation-races.sh");
  const qualityWorkflow = source(".github/workflows/quality.yml");
  assertOrdered(
    route,
    [
      '"admin_begin_account_reactivation"',
      "processAccountReactivationJob(",
      "getAccountReactivationStatus(",
    ],
    "reactivation saga order",
  );
  assert.doesNotMatch(route, /updateUserById/);
  assert.doesNotMatch(
    route,
    /\.rpc\("admin_complete_account_reactivation"/,
  );
  assert.match(
    route,
    /const expectedDeletedAt = parseExactTimestampFence\([\s\S]*body\?\.expectedDeletedAt/,
  );
  assert.match(
    route,
    /expectedWithdrawalGeneration[\s\S]*p_expected_withdrawal_generation/,
  );
  assert.match(
    route,
    /createAccountReactivationDeadline\(50_000\)[\s\S]*processAccountReactivationJob\([\s\S]*workerDeadline[\s\S]*getAccountReactivationStatus\([\s\S]*workerDeadline/,
  );
  assert.doesNotMatch(
    route,
    /new Date\(deletedMs\)\.toISOString\(\)/,
    "the exact PostgreSQL microsecond deletion fence must not be truncated",
  );
  assert.doesNotMatch(route, /recoverCommittedReactivation/);
  assert.doesNotMatch(route, /"admin_reactivate_account"/);
  assert.match(
    route,
    /"request_account_reactivation_cancellation"[\s\S]*processAccountReactivationJob\([\s\S]*getAccountReactivationStatus\(/,
  );
  assert.match(
    adminUsers,
    /getPendingAccountReactivation[\s\S]*"get_pending_account_reactivation"[\s\S]*parsePendingAccountReactivation/,
  );
  assertOrdered(
    userDetail,
    [
      "getPendingAccountReactivation(gate.user.id, id)",
      "initialPending=",
      "pendingReactivation.found",
    ],
    "admin detail reload restores the server-authorized pending correlation",
  );
  assert.match(
    form,
    /useState<PendingOperation \| null>\(initialPending\)/,
  );
  assert.match(
    form,
    /const submittedPending = pendingOperation;[\s\S]*operationRequestId: submittedPending\.operationRequestId[\s\S]*expectedDeletedAt: submittedPending\.expectedDeletedAt[\s\S]*submittedPending\.expectedWithdrawalGeneration/,
  );
  assert.ok(
    authApiHarness.includes(
      '^http://(127\\.0\\.0\\.1|localhost):[0-9]+$',
    ),
  );
  assert.match(
    authApiHarness,
    /insert into auth\.users\([\s\S]*instance_id[\s\S]*aud[\s\S]*role[\s\S]*00000000-0000-0000-0000-000000000000/,
    "direct Auth fixtures must be visible to the local GoTrue instance",
  );
  assert.match(
    authApiHarness,
    /activate_user_id[\s\S]*reactivation-auth-api-step\.mjs[\s\S]*activation_state[\s\S]*stale[\s\S]*third/,
  );
  assert.match(
    authApiHarness,
    /p\.display_name = 'Activate QA'[\s\S]*p\.avatar_url = 'https:\/\/example\.test\/activate\.png'[\s\S]*account_admin_actions_ledger/,
  );
  assert.match(
    authApiStep,
    /identity_id[\s\S]*providerIdentity\(current\.identities, "google"\)[\s\S]*email_confirm: true[\s\S]*transactionally rolled back[\s\S]*changed the non-email identity/,
  );
  assert.match(
    qualityWorkflow,
    /Run reactivation against the real local GoTrue Admin API[\s\S]*qa:db:reactivation-auth-api/,
  );
  assert.match(
    raceHarness,
    /reactivation_finish_wins[\s\S]*reactivation_cancel_wins[\s\S]*legacy_auth_transition_wins[\s\S]*legacy_withdrawal_wins[\s\S]*12 deterministic interleavings/,
  );
  const worker = source("lib/account-reactivation-job.ts");
  assertOrdered(
    worker,
    [
      '"arm_account_reactivation_auth_fence"',
      "current = await readAuthUser",
      "email: lease.email",
      "const observed = await readAuthUser",
    ],
    "GoTrue metadata fence is persisted before its email-first update path",
  );
  assert.doesNotMatch(
    worker,
    /updateUserById\([\s\S]{0,300}app_metadata/,
    "the worker must not replay a stale whole app_metadata map",
  );
  assert.equal(
    worker.match(/email_confirm: true/g)?.length,
    3,
    "activate, cancel, and legacy-repair Auth email changes stay verified",
  );
  assertOrdered(
    worker,
    [
      '"arm_account_reactivation_legacy_repair_auth_fence"',
      "current = await readAuthUser",
      "email: lease.email",
      "exactLegacyRepairAuthFence(current, lease)",
    ],
    "a delayed old-route repair keeps an exact permanent Auth fence",
  );
  assert.match(
    worker,
    /get_account_reactivation_legacy_repair_status[\s\S]*status === "completed" \|\| status === "superseded"/,
  );

  const migration = source(
    "supabase/migrations/0085_admin_mutation_idempotency.sql",
  );
  const beginStart = migration.indexOf(
    "create or replace function public.admin_begin_account_reactivation",
  );
  const completeCoreStart = migration.indexOf(
    "create or replace function public.bp_complete_account_reactivation_job",
  );
  assert.ok(beginStart >= 0 && completeCoreStart > beginStart);
  const beginBody = migration.slice(beginStart, completeCoreStart);
  assert.doesNotMatch(beginBody, /bp_0084_admin_reactivate_account_impl/);
  assert.match(
    beginBody,
    /p_expected_withdrawal_generation[\s\S]*expected_withdrawal_generation/,
  );
  assertOrdered(
    beginBody,
    [
      "insert into public.admin_mutation_requests",
      "insert into public.account_reactivation_jobs",
    ],
    "begin atomically persists receipt before external job",
  );
  const completeBody = migration.slice(
    completeCoreStart,
    migration.indexOf(
      "create or replace function public.admin_complete_account_reactivation",
      completeCoreStart,
    ),
  );
  assertOrdered(
    completeBody,
    [
      "from auth.users",
      "v_current_email := public.bp_prepare_account_reactivation_email",
      "reactivation_email_changed",
      "auth_email_not_synchronized",
      "bp_reactivation_fence",
      "auth_reactivation_fence_invalid",
      "set status = 'completed'",
      "update public.profiles",
      "update public.member_accounts",
      "insert into public.account_admin_actions_ledger",
      "set state = 'completed'",
    ],
    "fenced completion verifies Auth and atomically releases lifecycle fence",
  );
  assert.doesNotMatch(
    completeBody,
    /v_data := public\.bp_0084_admin_reactivate_account_impl/,
  );
  assert.match(
    completeBody,
    /from auth\.identities i[\s\S]*order by i\.id[\s\S]*for update[\s\S]*from auth\.users u[\s\S]*for update/,
  );
  assert.match(
    completeBody,
    /from public\.member_accounts m[\s\S]*for update[\s\S]*member_not_found/,
  );
  assert.match(
    completeBody,
    /auth_reactivation_fence_invalid[\s\S]*v_auth_meta :=[\s\S]*- 'bp_reactivation_fence'[\s\S]*raw_app_meta_data = v_auth_meta/,
  );
  assert.match(
    migration,
    /create or replace function public\.claim_account_reactivation_job\([\s\S]*v_job\.admin_user_id is distinct from p_admin_id[\s\S]*v_job\.user_id is distinct from p_user_id[\s\S]*j\.leased_until <= clock_timestamp\(\)/,
  );
  assert.match(
    migration,
    /create or replace function public\.finish_account_reactivation_job\([\s\S]*v_job\.lease_token is distinct from p_lease_token[\s\S]*v_job\.lease_version <> p_lease_version[\s\S]*v_job\.leased_until <= clock_timestamp\(\)/,
  );
  assert.match(
    migration,
    /create trigger trg_profiles_fence_account_reactivation_lifecycle/,
  );
  assert.match(
    migration,
    /create trigger trg_profiles_advance_withdrawal_generation/,
  );
  assert.match(
    migration,
    /old\.expected_withdrawal_generation is distinct from\s+new\.expected_withdrawal_generation/,
  );
  assert.match(
    migration,
    /create trigger trg_auth_users_fence_account_reactivation/,
  );
  assert.match(
    migration,
    /create or replace function public\.arm_account_reactivation_auth_fence[\s\S]*set raw_app_meta_data =[\s\S]*coalesce\(u\.raw_app_meta_data, '\{\}'::jsonb\)[\s\S]*\|\| pg_catalog\.jsonb_build_object\([\s\S]*'bp_reactivation_fence'/,
  );
  assert.match(
    migration,
    /request_account_reactivation_cancellation[\s\S]*status = 'pending'[\s\S]*lease_token = null[\s\S]*cancel_requested_at/,
  );
  assert.match(
    migration,
    /get_pending_account_reactivation[\s\S]*bp_assert_active_admin\(p_admin_id\)[\s\S]*join public\.admin_mutation_requests r[\s\S]*j\.user_id = p_user_id[\s\S]*'request_id', v_request_id[\s\S]*'cancel_requested'/,
  );
  assert.match(
    migration,
    /bp_cancel_account_reactivation_job[\s\S]*v_auth_email is distinct from v_marker[\s\S]*set status = 'cancelled'[\s\S]*set state = 'cancelled'/,
  );
  assert.match(
    migration,
    /create constraint trigger\s+trg_profiles_enqueue_legacy_account_reactivation_repair[\s\S]*deferrable initially deferred/,
  );
  assert.match(
    migration,
    /arm_account_reactivation_legacy_repair_auth_fence[\s\S]*'action', 'legacy_repair'[\s\S]*'legacy_repair_job_id', v_job\.id/,
  );
  assert.match(
    migration,
    /finish_account_reactivation_legacy_repair[\s\S]*auth_email_not_synchronized[\s\S]*- 'bp_reactivation_fence'[\s\S]*set status = 'completed'/,
  );
  assert.match(
    migration,
    /lease_counter_exhausted[\s\S]*9999-12-31 23:59:59\+00/,
  );
  assert.match(
    migration,
    /bp_account_reactivation_auth_transition_lock[\s\S]*admin_soft_delete_account[\s\S]*bp_0084_admin_soft_delete_account_impl/,
  );
  assert.match(
    migration,
    /'preflight_error', v_preflight_error/,
  );
  assert.match(
    migration,
    /i\.created_at desc nulls last,\s+i\.id desc/,
  );
  assert.match(migration, /not like '%@deleted\.invalid'/);
});

test("settlement recovers a receipt before any PortOne dependency", () => {
  const body = source("app/api/admin/settle/route.ts");
  const resultContract = source("lib/admin-mutation.ts");
  const adminUi = source("components/admin/StalePendingTable.tsx");
  assertOrdered(
    body,
    [
      '"get_admin_settlement_receipt"',
      "if (receipt.found)",
      "portoneCancelConfigured()",
      "getPortonePaymentSnapshot(",
      "classifyPortoneEvidenceForRollout(",
      "payment_evidence_incomplete",
      "snapshot.raw.paidAt",
      '"admin_settle_stuck_order_verified"',
      "isAdminSettlementReceiptProof(",
    ],
    "settlement response-loss recovery order",
  );
  assert.doesNotMatch(body, /\.rpc\("admin_settle_stuck_order"/);
  assert.match(
    body,
    /expected_store_id[\s\S]*expected_currency[\s\S]*expected_channel_key[\s\S]*classifyPortoneEvidenceForRollout/,
  );
  assert.match(
    body,
    /evidence\.kind === "legacy_deferred"[\s\S]*return NextResponse\.json\([\s\S]*payment_evidence_incomplete[\s\S]*status: 503[\s\S]*admin_settle_stuck_order_verified/,
  );

  const migration = source(
    "supabase/migrations/008899_server_read_surface_rollout_gate.sql",
  );
  assert.match(
    migration,
    /create or replace function public\.admin_settle_stuck_order_verified\(/,
  );
  assert.match(
    migration,
    /create or replace function public\.admin_settle_stuck_order\([\s\S]*client_refresh_required/,
  );
  assertOrdered(
    migration,
    [
      "create or replace function public.admin_settle_stuck_order_verified(",
      "public.bp_admin_mutation_replay(",
      "public.bp_mutation_object_lock(",
      "public.bp_user_mutation_lock(",
      "public.bp_0087_admin_settle_stuck_order_verified_impl(",
    ],
    "verified settlement evidence and lock order",
  );
  assert.match(
    migration,
    /create or replace function public\.bp_0087_admin_settle_stuck_order_verified_impl\([\s\S]*p_raw->>'id' is distinct from v_order\.payment_id[\s\S]*v_raw_paid_at is distinct from p_paid_at[\s\S]*p_raw #>> '\{channel,type\}' = 'TEST'[\s\S]*public\.bp_0084_mark_paid_and_grant_impl\([\s\S]*'provider_paid_at', p_paid_at[\s\S]*public\.bp_admin_mutation_store_completed\(/,
  );
  assert.match(
    migration,
    /if found then[\s\S]*'requestedCredits', v_order\.credits[\s\S]*'quarantined', v_ledger\.credit_delta = 0[\s\S]*'noOp', true/,
  );
  assert.match(
    resultContract,
    /row\.quarantined === true[\s\S]*row\.credits !== 0[\s\S]*row\.after !== row\.before[\s\S]*row\.quarantined === false[\s\S]*row\.credits !== row\.requestedCredits/,
  );
  assert.match(
    resultContract,
    /receipt\.result\.requestedCredits === result\.requestedCredits[\s\S]*receipt\.result\.quarantined === result\.quarantined/,
  );
  assert.match(
    adminUi,
    /if \(outcome\.kind === "confirmed"\)[\s\S]*if \(outcome\.value\.quarantined\)[\s\S]*setSettlementReview\(outcome\.value\)[\s\S]*격리됐고 대사 이슈가 생성됐으므로 같은 지급을 다시 실행하지 말고[\s\S]*href="\/admin\/refunds"/,
  );
});

test("event and site uploads persist cleanup intent before signed token", () => {
  for (const file of [
    "app/api/admin/event-image/route.ts",
    "app/api/admin/site-asset/route.ts",
  ]) {
    const body = source(file);
    assertOrdered(
      body,
      [
        '"create_admin_storage_upload_intent"',
        ".createSignedUploadUrl(path)",
      ],
      `${file} upload intent order`,
    );
    assertOrdered(
      body,
      [
        ".info(path)",
        "imageContentTypeMatchesPath(",
        '"confirm_admin_storage_upload_intent"',
      ],
      `${file} finalize validation order`,
    );
  }
});
