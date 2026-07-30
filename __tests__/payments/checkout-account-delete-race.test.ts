import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  matchesCheckoutOrderPostcondition,
  parseAtomicCheckoutReceipt,
} from "../../lib/pay/checkout-reuse.ts";
import { resolveFailClosedRead } from "../../lib/pay/fail-closed-read.ts";
import { CHECKOUT_WITHDRAWAL_CONFIRMATION } from "../../lib/pay/withdrawal-evidence.ts";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/0075_checkout_account_delete_serialization.sql",
    import.meta.url,
  ),
  "utf8",
);
const refundEvidenceMigration = readFileSync(
  new URL(
    "../../supabase/migrations/0077_refund_pg_evidence_integrity.sql",
    import.meta.url,
  ),
  "utf8",
);
const rolloutMigration = readFileSync(
  new URL(
    "../../supabase/migrations/008899_server_read_surface_rollout_gate.sql",
    import.meta.url,
  ),
  "utf8",
);
const rolloutContractMigration = readFileSync(
  new URL(
    "../../supabase/migrations/0092_rollout_contract_cleanup.sql",
    import.meta.url,
  ),
  "utf8",
);
const paymentEvidenceContractMigration = readFileSync(
  new URL(
    "../../supabase/migrations/0090_payment_evidence_contract_constraint.sql",
    import.meta.url,
  ),
  "utf8",
);
const paymentEvidenceContractValidationMigration = readFileSync(
  new URL(
    "../../supabase/migrations/0091_payment_evidence_contract_validate.sql",
    import.meta.url,
  ),
  "utf8",
);
const completePaymentContractMigrations =
  paymentEvidenceContractMigration +
  paymentEvidenceContractValidationMigration +
  rolloutContractMigration;
const checkoutRoute = readFileSync(
  new URL("../../app/api/pay/checkout/route.ts", import.meta.url),
  "utf8",
);
const orderStatusRoute = readFileSync(
  new URL("../../app/api/pay/order-status/route.ts", import.meta.url),
  "utf8",
);
const webhookRoute = readFileSync(
  new URL("../../app/api/pay/webhook/route.ts", import.meta.url),
  "utf8",
);
const reconcileRoute = readFileSync(
  new URL("../../app/api/ops/reconcile/route.ts", import.meta.url),
  "utf8",
);

test("원자 checkout receipt는 후보/재사용 전체 금융 snapshot을 정확히 검증한다", () => {
  const candidateOrderUuid = "11111111-1111-4111-8111-111111111111";
  const expected = {
    candidateOrderUuid,
    userId: "22222222-2222-4222-8222-222222222222",
    productId: "credits_10",
    amount: 3000,
    credits: 10,
    paymentId: "11111111111141118111111111111111",
    isTest: false,
    payChannel: "CARD",
    expectedStoreId: "store_boss_paegi",
    expectedCurrency: "KRW",
    expectedChannelKey: "channel_live_card",
    checkoutRequestId: "44444444-4444-4444-8444-444444444444",
    productName: "캐릭터 생성권 10개",
    payMode: "live" as const,
    offerEvidenceId: "55555555-5555-4555-8555-555555555555",
    offerSnapshotSha256: "a".repeat(64),
    withdrawalCopyVersion:
      CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
    withdrawalCopy: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
  };
  const ready = {
    ok: true,
    outcome: "ready",
    order_uuid: candidateOrderUuid,
    user_id: expected.userId,
    product_id: expected.productId,
    amount: expected.amount,
    credits: expected.credits,
    status: "pending",
    provider: "portone",
    payment_id: expected.paymentId,
    is_test: expected.isTest,
    pay_channel: expected.payChannel,
    expected_store_id: expected.expectedStoreId,
    expected_currency: expected.expectedCurrency,
    expected_channel_key: expected.expectedChannelKey,
    withdrawal_evidence_id:
      "66666666-6666-4666-8666-666666666666",
    checkout_request_id: expected.checkoutRequestId,
    withdrawal_product_name: expected.productName,
    withdrawal_pay_mode: expected.payMode,
    withdrawal_offer_evidence_id: expected.offerEvidenceId,
    withdrawal_offer_snapshot_sha256: expected.offerSnapshotSha256,
    withdrawal_copy_version: expected.withdrawalCopyVersion,
    withdrawal_confirmation_copy: expected.withdrawalCopy,
    withdrawal_confirmed: true,
    withdrawal_accepted_at: "2026-07-30T00:00:00.000Z",
    paid_at: null,
    canceled_at: null,
  };

  assert.deepEqual(parseAtomicCheckoutReceipt(ready, expected), {
    orderUuid: candidateOrderUuid,
    paymentId: ready.payment_id,
    amount: expected.amount,
    credits: expected.credits,
    status: "pending",
    reused: false,
    expectedStoreId: expected.expectedStoreId,
    expectedCurrency: "KRW",
    expectedChannelKey: expected.expectedChannelKey,
    withdrawalEvidenceId: ready.withdrawal_evidence_id,
    checkoutRequestId: expected.checkoutRequestId,
    withdrawalAcceptedAt: ready.withdrawal_accepted_at,
  });
  assert.deepEqual(
    parseAtomicCheckoutReceipt(
      {
        ...ready,
        outcome: "replayed",
        expected_store_id: "store_previous_deploy",
        expected_channel_key: "channel_previous_deploy",
      },
      expected,
    ),
    {
      orderUuid: candidateOrderUuid,
      paymentId: ready.payment_id,
      amount: expected.amount,
      credits: expected.credits,
      status: "pending",
      reused: true,
      expectedStoreId: "store_previous_deploy",
      expectedCurrency: "KRW",
      expectedChannelKey: "channel_previous_deploy",
      withdrawalEvidenceId: ready.withdrawal_evidence_id,
      checkoutRequestId: expected.checkoutRequestId,
      withdrawalAcceptedAt: ready.withdrawal_accepted_at,
    },
  );
  const reusedOrderUuid = "33333333-3333-4333-8333-333333333333";
  const reused = {
    ...ready,
    outcome: "reused",
    order_uuid: reusedOrderUuid,
    payment_id: reusedOrderUuid.replaceAll("-", ""),
    amount: 1000,
    credits: 3,
    status: "failed",
  };
  assert.deepEqual(parseAtomicCheckoutReceipt(reused, expected), {
    orderUuid: reusedOrderUuid,
    paymentId: reused.payment_id,
    amount: 1000,
    credits: 3,
    status: "failed",
    reused: true,
    expectedStoreId: expected.expectedStoreId,
    expectedCurrency: "KRW",
    expectedChannelKey: expected.expectedChannelKey,
    withdrawalEvidenceId: ready.withdrawal_evidence_id,
    checkoutRequestId: expected.checkoutRequestId,
    withdrawalAcceptedAt: ready.withdrawal_accepted_at,
  });
  assert.deepEqual(
    parseAtomicCheckoutReceipt(
      {
        ...reused,
        expected_store_id: "store_previous_deploy",
        expected_channel_key: "channel_previous_deploy",
      },
      expected,
    ),
    {
      orderUuid: reusedOrderUuid,
      paymentId: reused.payment_id,
      amount: 1000,
      credits: 3,
      status: "failed",
      reused: true,
      expectedStoreId: "store_previous_deploy",
      expectedCurrency: "KRW",
      expectedChannelKey: "channel_previous_deploy",
      withdrawalEvidenceId: ready.withdrawal_evidence_id,
      checkoutRequestId: expected.checkoutRequestId,
      withdrawalAcceptedAt: ready.withdrawal_accepted_at,
    },
  );

  for (const mutation of [
    { ok: false },
    { outcome: "unknown" },
    { outcome: "reused" },
    { outcome: "replayed", order_uuid: "33333333-3333-4333-8333-333333333333" },
    { order_uuid: "not-a-uuid" },
    { payment_id: "different" },
    { user_id: "33333333-3333-4333-8333-333333333333" },
    { amount: 1 },
    { credits: 1 },
    { status: "paid" },
    { provider: "other" },
    { is_test: true },
    { pay_channel: "other" },
    { expected_store_id: "" },
    { expected_store_id: "bad\nstore" },
    { expected_store_id: "other" },
    { expected_currency: "USD" },
    { expected_channel_key: "bad\nchannel" },
    { expected_channel_key: "other" },
    { withdrawal_evidence_id: "not-a-uuid" },
    { checkout_request_id: "77777777-7777-4777-8777-777777777777" },
    { withdrawal_product_name: "다른 상품" },
    { withdrawal_pay_mode: "test" },
    { withdrawal_offer_evidence_id: "77777777-7777-4777-8777-777777777777" },
    { withdrawal_offer_snapshot_sha256: "b".repeat(64) },
    { withdrawal_copy_version: "old" },
    { withdrawal_confirmation_copy: "다른 문구" },
    { withdrawal_confirmed: false },
    { withdrawal_accepted_at: "invalid" },
    { paid_at: "2026-07-29T00:00:00Z" },
    { canceled_at: "2026-07-29T00:00:00Z" },
  ]) {
    assert.equal(
      parseAtomicCheckoutReceipt({ ...ready, ...mutation }, expected),
      null,
    );
  }
});

test("checkout은 RPC receipt 뒤 durable pending postcondition도 다시 증명한다", () => {
  const expected = {
    orderUuid: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    productId: "credits_10",
    amount: 3000,
    credits: 10,
    paymentId: "11111111111141118111111111111111",
    isTest: false,
    payChannel: "CARD",
    expectedStoreId: "store_boss_paegi",
    expectedCurrency: "KRW",
    expectedChannelKey: "channel_live_card",
    status: "pending" as const,
  };
  const row = {
    order_uuid: expected.orderUuid,
    user_id: expected.userId,
    product_id: expected.productId,
    amount: expected.amount,
    credits: expected.credits,
    status: "pending",
    provider: "portone",
    payment_id: expected.paymentId,
    is_test: expected.isTest,
    pay_channel: expected.payChannel,
    expected_store_id: expected.expectedStoreId,
    expected_currency: expected.expectedCurrency,
    expected_channel_key: expected.expectedChannelKey,
    paid_at: null,
    canceled_at: null,
  };
  assert.equal(matchesCheckoutOrderPostcondition(row, expected), true);
  assert.equal(
    matchesCheckoutOrderPostcondition(
      { ...row, status: "failed" },
      { ...expected, status: "failed" },
    ),
    true,
  );
  for (const mutation of [
    { status: "paid" },
    { user_id: "33333333-3333-4333-8333-333333333333" },
    { amount: 1 },
    { credits: 1 },
    { payment_id: "other" },
    { is_test: true },
    { expected_store_id: "other" },
    { expected_currency: "USD" },
    { expected_channel_key: "other" },
    { paid_at: "2026-07-29T00:00:00Z" },
    { canceled_at: "2026-07-29T00:00:00Z" },
  ]) {
    assert.equal(
      matchesCheckoutOrderPostcondition({ ...row, ...mutation }, expected),
      false,
    );
  }
});

test("공통 금융 read 경계는 resolved error와 throw를 모두 실패로 정규화한다", async () => {
  const resolvedError = { code: "PGRST000", message: "read failed" };
  assert.deepEqual(
    await resolveFailClosedRead(async () => ({
      data: null,
      error: resolvedError,
    })),
    { ok: false, error: resolvedError },
  );

  const thrown = new Error("transport failed");
  assert.deepEqual(
    await resolveFailClosedRead(async () => {
      throw thrown;
    }),
    { ok: false, error: thrown },
  );

  assert.deepEqual(
    await resolveFailClosedRead(async () => ({
      data: { id: "ok" },
      error: null,
    })),
    { ok: true, data: { id: "ok" } },
  );
});

test("refund saga fault injection은 attempt/order/sweep read 실패 뒤 외부 PG를 0회 호출한다", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const loader = fileURLToPath(
    new URL("../telemetry/node-loader.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL("./refund-read-fault-injection.mts", import.meta.url),
  );
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-loader",
      loader,
      fixture,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.equal(
    run.status,
    0,
    `fault injection failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.match(run.stdout, /refund read fault injection passed/);
});

test("pgTAP runner는 0개 파일/NOTESTS를 성공으로 처리하지 않는다", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const script = fileURLToPath(
    new URL("../../scripts/qa/run-local-pgtap.sh", import.meta.url),
  );
  const run = spawnSync("bash", [script, "--self-test-empty"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no pgTAP files found/);

  const notests = spawnSync("bash", [script, "--self-test-notests"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(notests.status, 0);
  assert.match(notests.stdout, /Files=0, Tests=0/);
  assert.match(notests.stderr, /reported NOTESTS/);
});

test("checkout route는 분리 SELECT 없이 DB 원자 get-or-create만 호출한다", () => {
  assert.match(
    checkoutRoute,
    /admin\s*\.rpc\(\s*"create_or_reuse_pending_order"/,
  );
  assert.doesNotMatch(checkoutRoute, /resolveReusablePendingOrder/);
  assert.doesNotMatch(
    checkoutRoute,
    /\.from\("orders"\)[\s\S]*\.gte\("created_at"/,
  );
});

test("checkout route는 주문 RPC ack와 durable snapshot을 증명한 뒤에만 PG 파라미터를 반환한다", () => {
  const createRpc = checkoutRoute.indexOf(
    '"create_or_reuse_pending_order"',
  );
  const ack = checkoutRoute.indexOf(
    "parseAtomicCheckoutReceipt(mutationResult",
    createRpc,
  );
  const proof = checkoutRoute.indexOf(
    "matchesCheckoutOrderPostcondition(persisted",
    ack,
  );
  const response = checkoutRoute.lastIndexOf(
    "return NextResponse.json({",
  );
  assert.ok(createRpc >= 0);
  assert.ok(ack > createRpc);
  assert.ok(proof > ack);
  assert.ok(response > proof);
});

test("0087 원자 checkout은 검증·잠금·완전한 INSERT를 한 함수에서 수행하고 replay/reuse를 구분한다", () => {
  const start = rolloutMigration.indexOf(
    "create or replace function public.create_or_reuse_pending_order",
  );
  const end = rolloutMigration.indexOf(
    "revoke all on function public.create_or_reuse_pending_order",
    start,
  );
  const fn = rolloutMigration.slice(start, end);
  const objectLock = fn.indexOf("public.bp_mutation_object_lock");
  const configLock = fn.indexOf("public.bp_checkout_config_lock");
  const userLock = fn.indexOf("public.bp_user_mutation_lock");
  const productLookup = fn.indexOf("from public.app_settings");
  const profileLookup = fn.indexOf("from public.profiles");
  const insert = fn.indexOf("insert into public.orders");
  assert.ok(start >= 0);
  assert.ok(objectLock >= 0);
  assert.ok(configLock > objectLock);
  assert.ok(userLock > configLock);
  assert.ok(productLookup > userLock);
  assert.ok(profileLookup > productLookup);
  assert.ok(insert > profileLookup);
  assert.doesNotMatch(fn, /bp_0084_create_pending_order_impl/);
  for (const validation of [
    "invalid_payment_evidence_snapshot",
    "invalid_product",
    "product_amount_mismatch",
    "account_not_found",
    "account_deleted",
    "for key share",
  ]) {
    assert.ok(fn.includes(validation), `missing atomic validation: ${validation}`);
  }
  assert.match(
    fn,
    /where o\.payment_id = p_payment_id[\s\S]*v_outcome := 'replayed'/,
  );
  assert.match(
    fn,
    /v_candidate_count = 1[\s\S]*v_outcome := 'reused'/,
  );
  assert.match(
    fn,
    /insert into public\.orders \([\s\S]*expected_store_id,[\s\S]*expected_currency,[\s\S]*expected_channel_key[\s\S]*v_outcome := 'ready'/,
  );
  assert.ok(
    (fn.match(/raise exception 'legacy_checkout_refresh_required'/g) ?? [])
      .length >= 3,
    "same-candidate, different-candidate and receipt postcondition must all reject legacy NULL evidence",
  );
  assert.match(
    fn,
    /v_outcome = 'ready'[\s\S]*v_order\.expected_store_id is distinct from p_expected_store_id[\s\S]*v_order\.expected_channel_key is distinct from[\s\S]*p_expected_channel_key/,
  );
  for (const invariant of [
    "o.user_id = p_user",
    "o.status in ('pending', 'failed')",
    "limit 2",
    "checkout_reuse_ambiguous",
    "checkout_prior_intent_unresolved",
    "'expected_store_id', v_order.expected_store_id",
    "'expected_currency', v_order.expected_currency",
    "'expected_channel_key', v_order.expected_channel_key",
  ]) {
    assert.ok(fn.includes(invariant), `missing atomic predicate: ${invariant}`);
  }
  for (const unsafeWindowPredicate of [
    "o.amount = p_amount",
    "o.credits = p_credits",
    "interval '10 minutes'",
  ]) {
    assert.equal(
      fn.includes(unsafeWindowPredicate),
      false,
      `charge-capable prior intent must not be bypassed by ${unsafeWindowPredicate}`,
    );
  }
});

test("0087 provider-backed legacy adoption is bounded, exact, and removed by 0092", () => {
  const start = rolloutMigration.indexOf(
    "create or replace function public.backfill_portone_order_payment_evidence(",
  );
  const end = rolloutMigration.indexOf(
    "grant execute on function public.backfill_portone_order_payment_evidence",
    start,
  );
  const fn = rolloutMigration.slice(start, end);
  assert.ok(start >= 0);
  for (const invariant of [
    "security definer",
    "public.bp_mutation_object_lock",
    "v_order.payment_id is distinct from p_payment_id",
    "v_order.amount is distinct from p_amount",
    "v_order.is_test is distinct from p_is_test",
    "v_order.pay_channel is distinct from p_pay_channel",
    "o.pay_channel is not distinct from p_pay_channel",
    "o.expected_store_id is null",
    "o.expected_currency is null",
    "o.expected_channel_key is null",
    "payment_evidence_snapshot_conflict",
    "'already_exact'",
    "payment_evidence_backfill_postcondition_failed",
    "'pay_channel', v_order.pay_channel",
  ]) {
    assert.ok(fn.includes(invariant), `missing backfill invariant: ${invariant}`);
  }
  assert.match(
    rolloutMigration,
    /drop function if exists public\.backfill_portone_order_payment_evidence\(\s*uuid,\s*text,\s*integer,\s*boolean,\s*text,\s*text,\s*text\s*\)/,
  );
  assert.match(
    rolloutMigration,
    /create or replace function public\.backfill_portone_order_payment_evidence\(\s*p_order_uuid uuid,\s*p_payment_id text,\s*p_amount integer,\s*p_is_test boolean,\s*p_pay_channel text,\s*p_expected_store_id text,\s*p_expected_currency text,\s*p_expected_channel_key text\s*\)/,
  );
  assert.match(
    rolloutMigration,
    /revoke all on function public\.backfill_portone_order_payment_evidence\([\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute on function public\.backfill_portone_order_payment_evidence\([\s\S]*to service_role;/,
  );
  assert.match(
    completePaymentContractMigrations,
    /orders_portone_payment_evidence_required_check[\s\S]*revoke all on function public\.backfill_portone_order_payment_evidence\([\s\S]*drop function if exists public\.backfill_portone_order_payment_evidence\(/,
  );
  assert.match(
    paymentEvidenceContractMigration,
    /payment_id is not null[\s\S]*payment_id =\s*pg_catalog\.replace\(order_uuid::text, '-', ''\)[\s\S]*expected_store_id is not null[\s\S]*expected_currency is not null[\s\S]*expected_channel_key is not null/,
  );
});

test("0075는 0065 상품/결제 불변식을 보존하고 profile→orders 잠금 순서를 강제한다", () => {
  const fnStart = migration.indexOf(
    "create or replace function public.create_pending_order",
  );
  const fnEnd = migration.indexOf(
    "revoke all on function public.create_pending_order",
    fnStart,
  );
  const fn = migration.slice(fnStart, fnEnd);

  for (const invariant of [
    "public.app_settings",
    "invalid_product",
    "product_amount_mismatch",
    "invalid_provider",
    "invalid_channel",
    "payment_id_format",
    "request_conflict",
    "checkout_reuse_required",
    "o.credits = p_credits",
    "interval '10 minutes'",
    "coalesce(p_is_test, false)",
  ]) {
    assert.match(fn, new RegExp(invariant.replace(/[()]/g, "\\$&")));
  }

  const profileLock = fn.indexOf("for key share");
  const deletedReject = fn.indexOf("raise exception 'account_deleted'");
  const orderLookup = fn.indexOf(
    "select * into v_existing from public.orders",
  );
  const orderInsert = fn.indexOf("insert into public.orders");
  assert.ok(profileLock >= 0);
  assert.ok(deletedReject > profileLock);
  assert.ok(orderLookup > deletedReject);
  assert.ok(orderInsert > orderLookup);
  assert.match(
    migration,
    /create trigger trg_app_settings_checkout_config_lock[\s\S]*for each statement/,
  );
});

test("0075 direct INSERT backstop은 deleted/missing profile을 막고 금융 guard를 교체하지 않는다", () => {
  assert.match(
    migration,
    /create or replace function public\.bp_reject_deleted_order_insert\(\)[\s\S]*security definer[\s\S]*new\.user_id[\s\S]*for key share/,
  );
  assert.match(migration, /raise exception 'account_not_found'/);
  assert.match(migration, /raise exception 'account_deleted'/);
  assert.match(
    migration,
    /create trigger trg_orders_account_lifecycle_guard[\s\S]*before insert on public\.orders/,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\.orders_insert_guard\(\)/,
  );
  assert.match(migration, /tgname = 'trg_orders_insert_guard'/);
});

test("exact payment-evidence mismatch 감사 UPDATE 실패는 각 HTTP/cron 경계에서 명시 처리된다", () => {
  assert.match(
    orderStatusRoute,
    /if \(!markerResult\.ok\)[\s\S]*pay\.poll_evidence_mismatch_record_fail[\s\S]*errInfo\(markerResult\.error\)/,
  );
  assert.match(
    orderStatusRoute,
    /pay\.poll_evidence_mismatch_record_fail[\s\S]*state_record_failed[\s\S]*status: 500/,
  );
  assert.match(
    webhookRoute,
    /if \(!markerResult\.ok\)[\s\S]*pay\.wh_evidence_mismatch_record_fail[\s\S]*errInfo\(markerResult\.error\)/,
  );
  assert.match(
    webhookRoute,
    /pay\.wh_evidence_mismatch_record_fail[\s\S]*state_record_failed[\s\S]*status: 500/,
  );
  assert.match(
    reconcileRoute,
    /if \(!markerResult\.ok\)[\s\S]*pay\.reconcile_evidence_mismatch_record_fail[\s\S]*errInfo\(markerResult\.error\)/,
  );
  for (const route of [
    orderStatusRoute,
    webhookRoute,
    reconcileRoute,
  ]) {
    assert.match(
      route,
      /classifyPortoneEvidenceForRollout\([\s\S]*payment_evidence_/,
    );
    assert.match(route, /legacy_deferred/);
  }
});

test("취소 관측·PG 금액 증거 실패는 성공/빈 결과로 축소되지 않는다", () => {
  assert.match(
    orderStatusRoute,
    /res\.outcome === "error"[\s\S]*payment_unavailable[\s\S]*status: 503/,
  );
  assert.match(
    webhookRoute,
    /parsePaidOrderPostcondition\(current\)[\s\S]*pay\.wh_paid_transition_incomplete[\s\S]*paid_transition_incomplete[\s\S]*status: 500/,
  );
  assert.match(
    reconcileRoute,
    /pay\.reconcile_cancellation_fail[\s\S]*unresolved\.push\(row\.order_uuid\)/,
  );
  assert.match(
    refundEvidenceMigration,
    /p_cancelled_amount is null[\s\S]*p_cancelled_amount <= 0[\s\S]*p_cancelled_amount <> a\.amount[\s\S]*cancellation_amount_mismatch/,
  );
  assert.match(
    refundEvidenceMigration,
    /p_request_body is distinct from v_expected_body[\s\S]*refund_preflight_mismatch/,
  );
});

test("PAID 웹훅의 paid_at 증거 누락은 2xx ACK로 영구 미지급 처리하지 않는다", () => {
  assert.match(
    webhookRoute,
    /pay\.paid_at_missing[\s\S]*payment_evidence_incomplete[\s\S]*status: 503/,
  );
});

test("mark_paid_and_grant false는 paid 종단을 재증명하기 전 2xx 멱등 성공이 아니다", () => {
  assert.match(
    webhookRoute,
    /grantAck === false[\s\S]*pay\.wh_paid_idempotent/,
  );
  assert.match(
    webhookRoute,
    /select\("status, paid_at, error_message"\)[\s\S]*parsePaidOrderPostcondition\(current\)[\s\S]*paid_transition_incomplete[\s\S]*status: 500/,
  );
});
