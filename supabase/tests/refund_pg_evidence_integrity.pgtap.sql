-- 0077 PortOne 환불 증거 무결성.
-- SUCCEEDED 실제 취소액이 계획액과 다르면 event/attempt/order/ledger 전이가 모두 0이어야 한다.

begin;
select plan(34);

select has_function(
  'public',
  'admin_refund_mark_pg_requested',
  array['uuid','bigint','bigint','bigint','jsonb','jsonb'],
  'exact preflight RPC exists'
);
select has_function(
  'public',
  'admin_refund_record_pg_result',
  array['uuid','text','text','text','bigint','text','jsonb','timestamp with time zone','timestamp with time zone'],
  'PG result evidence RPC exists'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)',
    'EXECUTE'
  ),
  'service_role can record PG result'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)',
    'EXECUTE'
  ),
  'anon cannot record PG result'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)',
    'EXECUTE'
  ),
  'authenticated cannot record PG result'
);
select matches(
  pg_catalog.pg_get_functiondef(
    'public.bp_0084_admin_refund_record_pg_result_impl(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)'::regprocedure
  ),
  'p_cancelled_amount <> a\.amount',
  'SUCCEEDED amount is compared with locked attempt amount'
);
select matches(
  pg_catalog.pg_get_functiondef(
    'public.bp_0084_admin_refund_mark_pg_requested_impl(uuid,bigint,bigint,bigint,jsonb,jsonb)'::regprocedure
  ),
  'p_request_body is distinct from v_expected_body',
  'persisted PortOne request body is exact'
);

-- 운영 config 변화와 독립적인 rollback-only 상품 snapshot.
insert into public.app_settings(key, value)
values (
  'growth_levers',
  pg_catalog.jsonb_build_object(
    'products',
     pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_object(
         'productId', 'credits_10',
         'goodname', 'pgTAP 생성권 10개',
         'price', 3000,
         'credits', 10,
         'active', true
       )
     )
  )
)
on conflict (key) do update
set value = excluded.value;

create temporary table refund_evidence_ctx (
  customer uuid not null,
  admin_user uuid not null,
  order_uuid uuid not null,
  request_id uuid not null,
  attempt_id uuid
) on commit drop;

insert into refund_evidence_ctx(customer, admin_user, order_uuid, request_id)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

select lives_ok($$
  insert into auth.users(id, email)
  select customer, 'refund-evidence-customer-' || customer || '@test.local'
    from refund_evidence_ctx
  union all
  select admin_user, 'refund-evidence-admin-' || admin_user || '@test.local'
    from refund_evidence_ctx;

  insert into public.member_accounts(user_id, gen_credits, is_admin)
  select customer, 0, false from refund_evidence_ctx
  union all
  select admin_user, 0, true from refund_evidence_ctx;
$$, 'fixture users and memberships are created');

select lives_ok($$
  select public.bp_0105_create_or_reuse_pending_order_impl(
    customer,
    order_uuid,
    'credits_10',
    3000,
    10,
    pg_catalog.replace(order_uuid::text, '-', ''),
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  )
  from refund_evidence_ctx;

  select public.mark_paid_and_grant(
    order_uuid,
    'pgtap_refund_evidence_tx',
    3000,
    pg_catalog.jsonb_build_object(
      'id',
      pg_catalog.replace(order_uuid::text, '-', ''),
      'status',
      'PAID',
      'transactionId',
      'pgtap_refund_evidence_tx',
      'paidAt',
      evidence.paid_at,
      'amount',
      pg_catalog.jsonb_build_object('total', 3000),
      'storeId',
      'store-qa',
      'currency',
      'KRW',
      'channel',
      pg_catalog.jsonb_build_object(
        'type', 'LIVE',
        'key', 'channel-card-live'
      )
    ),
    evidence.paid_at,
    'https://receipt.example/refund-evidence'
  )
  from refund_evidence_ctx
  cross join lateral (
    select pg_catalog.date_trunc(
      'milliseconds',
      pg_catalog.clock_timestamp()
    ) as paid_at
  ) evidence;
$$, 'paid order and purchase lot are created through real RPCs');

select lives_ok($$
  select public.admin_refund_begin(
    request_id,
    admin_user,
    customer,
    order_uuid,
    3,
    '0077 exact evidence QA',
    now(),
    'portone_cancel'
  )
  from refund_evidence_ctx;
$$, 'qty 3 refund attempt is prepared');

update refund_evidence_ctx c
   set attempt_id = a.id
  from public.order_refund_attempts a
 where a.request_id = c.request_id;

select is(
  (
    select a.amount
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  900::bigint,
  'config price 3000/10 and qty 3 produce exact amount 900'
);

select throws_ok($$
  select public.admin_refund_mark_pg_requested(
    attempt_id,
    3000,
    0,
    3000,
    '[]'::jsonb,
    pg_catalog.jsonb_build_object(
      'amount', 2700,
      'reason', 'BP_REFUND:' || attempt_id::text,
      'currentCancellableAmount', 3000
    )
  )
  from refund_evidence_ctx
$$, 'P0001', 'refund_preflight_mismatch',
  'wrong persisted cancellation body is rejected');

select is(
  (
    select a.state
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  'prepared',
  'wrong body leaves attempt prepared'
);
select ok(
  (
    select a.pg_preflight_at is null
       and a.pg_request_body is null
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  'wrong body persists no preflight evidence'
);

select lives_ok($$
  select public.admin_refund_mark_pg_requested(
    attempt_id,
    3000,
    0,
    3000,
    '[]'::jsonb,
    pg_catalog.jsonb_build_object(
      'amount', 900,
      'reason', 'BP_REFUND:' || attempt_id::text,
      'currentCancellableAmount', 3000
    )
  )
  from refund_evidence_ctx
$$, 'exact preflight and three-field request body enter pg_requested');

select is(
  (
    select a.state
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  'pg_requested',
  'attempt is pg_requested before result evidence'
);

select throws_ok($$
  select public.admin_refund_record_pg_result(
    attempt_id,
    'succeeded',
    'pgtap_refund_null',
    'SUCCEEDED',
    null::bigint,
    'https://receipt.example/cancel-null',
    '{}'::jsonb,
    null,
    null
  )
  from refund_evidence_ctx
$$, 'P0001', 'cancellation_amount_mismatch',
  'NULL SUCCEEDED cancellation amount is rejected');

select throws_ok($$
  select public.admin_refund_record_pg_result(
    attempt_id,
    'succeeded',
    'pgtap_refund_partial',
    'SUCCEEDED',
    899,
    'https://receipt.example/cancel-partial',
    '{}'::jsonb,
    null,
    null
  )
  from refund_evidence_ctx
$$, 'P0001', 'cancellation_amount_mismatch',
  'partial SUCCEEDED cancellation amount is rejected');

select throws_ok($$
  select public.admin_refund_record_pg_result(
    attempt_id,
    'succeeded',
    'pgtap_refund_over',
    'SUCCEEDED',
    901,
    'https://receipt.example/cancel-over',
    '{}'::jsonb,
    null,
    null
  )
  from refund_evidence_ctx
$$, 'P0001', 'cancellation_amount_mismatch',
  'excess SUCCEEDED cancellation amount is rejected');

select is(
  (
    select a.state
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  'pg_requested',
  'all amount mismatches leave attempt before pg_succeeded'
);
select is(
  (
    select count(*)::int
      from public.payment_cancellation_events e
      join refund_evidence_ctx c on c.order_uuid = e.order_uuid
  ),
  0,
  'all amount mismatches create zero cancellation events'
);
select is(
  (
    select o.refunded_amount::text || '|' || o.refunded_credits::text
      from public.orders o
      join refund_evidence_ctx c on c.order_uuid = o.order_uuid
  ),
  '0|0',
  'all amount mismatches commit zero order money and credits'
);
select is(
  (
    select count(*)::int
      from public.credit_ledger l
      join refund_evidence_ctx c on c.attempt_id = l.ref_attempt_id
     where l.event_type = 'refund_commit'
  ),
  0,
  'all amount mismatches write zero refund_commit ledger rows'
);
select is(
  (
    select l.refund_reserved
      from public.credit_lots l
      join refund_evidence_ctx c on c.order_uuid = l.order_uuid
     where l.source = 'purchase'
  ),
  3,
  'all amount mismatches preserve the reservation for safe retry'
);

select lives_ok($$
  select public.admin_refund_record_pg_result(
    attempt_id,
    'succeeded',
    'pgtap_refund_exact',
    'SUCCEEDED',
    900,
    'https://receipt.example/cancel-exact',
    '{}'::jsonb,
    null,
    null
  )
  from refund_evidence_ctx
$$, 'exact SUCCEEDED cancellation amount is accepted');

select is(
  (
    select a.state
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  'pg_succeeded',
  'exact result advances attempt to pg_succeeded'
);
select is(
  (
    select e.amount::text || '|' || e.resolution_state || '|' || e.matched_attempt_id::text
      from public.payment_cancellation_events e
      join refund_evidence_ctx c on c.attempt_id = e.matched_attempt_id
     where e.cancellation_id = 'pgtap_refund_exact'
  ),
  (
    select '900|matched|' || attempt_id::text
      from refund_evidence_ctx
  ),
  'exact event stores PG amount and is matched to the attempt'
);

select is(
  (
    select public.admin_refund_record_pg_result(
      attempt_id,
      'succeeded',
      'pgtap_refund_exact',
      'SUCCEEDED',
      900,
      'https://receipt.example/cancel-exact',
      '{}'::jsonb,
      null,
      null
    )->>'outcome'
    from refund_evidence_ctx
  ),
  'no_op',
  'exact SUCCEEDED result replay is idempotent'
);

select throws_ok($$
  select public.admin_refund_record_pg_result(
    attempt_id,
    'succeeded',
    'pgtap_refund_exact',
    'SUCCEEDED',
    899,
    'https://receipt.example/cancel-exact',
    '{}'::jsonb,
    null,
    null
  )
  from refund_evidence_ctx
$$, 'P0001', 'cancellation_amount_mismatch',
  'mismatched replay is rejected before idempotent no_op');

select is(
  (
    select a.state || '|' || e.amount::text || '|' || e.resolution_state
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
      join public.payment_cancellation_events e on e.matched_attempt_id = a.id
  ),
  'pg_succeeded|900|matched',
  'mismatched replay changes neither attempt nor event'
);

select lives_ok($$
  select public.admin_refund_commit(attempt_id)
  from refund_evidence_ctx
$$, 'exact PG evidence can commit');

select is(
  (
    select o.refunded_amount::text || '|' || o.refunded_credits::text
      from public.orders o
      join refund_evidence_ctx c on c.order_uuid = o.order_uuid
  ),
  '900|3',
  'commit records exactly 900 money and 3 credits'
);
select is(
  (
    select a.state
      from public.order_refund_attempts a
      join refund_evidence_ctx c on c.attempt_id = a.id
  ),
  'committed',
  'attempt reaches committed only after exact evidence'
);
select is(
  (
    select count(*)::int
      from public.credit_ledger l
      join refund_evidence_ctx c on c.attempt_id = l.ref_attempt_id
     where l.event_type = 'refund_commit'
  ),
  1,
  'exact evidence produces one refund_commit ledger row'
);

select * from finish();
rollback;
