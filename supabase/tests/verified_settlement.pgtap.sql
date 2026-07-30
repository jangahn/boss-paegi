-- Verified administrator settlement: provider evidence, accounting timestamp,
-- channel-mode fence, response-loss receipt, and exactly-once convergence.

begin;
select plan(47);

select has_function(
  'public',
  'admin_settle_stuck_order_verified',
  array[
    'uuid',
    'uuid',
    'text',
    'uuid',
    'timestamp with time zone',
    'text',
    'text',
    'jsonb'
  ],
  'verified settlement RPC exists'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
    'EXECUTE'
  ),
  'only service role can invoke verified settlement'
);
select ok(
  (
    select p.prosecdef
       and p.proconfig = array['search_path=""']::text[]
      from pg_catalog.pg_proc p
     where p.oid =
       'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)'::regprocedure
  ),
  'verified settlement is SECURITY DEFINER with empty search_path'
);

create temporary table verified_settlement_ctx (
  admin_id uuid not null,
  owner_id uuid not null,
  live_owner_id uuid not null,
  missing_owner_id uuid not null,
  quarantine_owner_id uuid not null,
  good_order uuid not null,
  live_order uuid not null,
  missing_order uuid not null,
  quarantine_order uuid not null,
  legacy_order uuid not null,
  missing_payment_order uuid not null,
  foreign_payment_order uuid not null,
  paid_at timestamptz not null,
  request_id uuid not null,
  second_request_id uuid not null,
  quarantine_request_id uuid not null,
  quarantine_second_request_id uuid not null,
  refund_request_id uuid not null,
  good_result jsonb,
  quarantine_result jsonb
) on commit drop;

insert into verified_settlement_ctx
select
  gen_random_uuid(), -- admin_id
  gen_random_uuid(), -- owner_id
  gen_random_uuid(), -- live_owner_id
  gen_random_uuid(), -- missing_owner_id
  gen_random_uuid(), -- quarantine_owner_id
  gen_random_uuid(), -- good_order
  gen_random_uuid(), -- live_order
  gen_random_uuid(), -- missing_order
  gen_random_uuid(), -- quarantine_order
  gen_random_uuid(), -- legacy_order
  gen_random_uuid(), -- missing_payment_order
  gen_random_uuid(), -- foreign_payment_order
  pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.clock_timestamp() - interval '8 days'
  ), -- paid_at
  gen_random_uuid(), -- request_id
  gen_random_uuid(), -- second_request_id
  gen_random_uuid(), -- quarantine_request_id
  gen_random_uuid(), -- quarantine_second_request_id
  gen_random_uuid(), -- refund_request_id
  null, -- good_result
  null; -- quarantine_result

insert into auth.users(id, email, raw_app_meta_data)
select
  admin_id,
  'verified-admin-' || admin_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from verified_settlement_ctx
union all
select
  owner_id,
  'verified-owner-' || owner_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from verified_settlement_ctx
union all
select
  live_owner_id,
  'verified-live-owner-' || live_owner_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from verified_settlement_ctx
union all
select
  missing_owner_id,
  'verified-missing-owner-' || missing_owner_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from verified_settlement_ctx
union all
select
  quarantine_owner_id,
  'verified-quarantine-owner-' || quarantine_owner_id::text || '@test.local',
  '{"provider":"email"}'::jsonb
  from verified_settlement_ctx;

insert into public.member_accounts(user_id, gen_credits, email, is_admin)
select
  admin_id,
  0,
  'verified-admin-' || admin_id::text || '@test.local',
  true
  from verified_settlement_ctx
union all
select
  owner_id,
  0,
  'verified-owner-' || owner_id::text || '@test.local',
  false
  from verified_settlement_ctx
union all
select
  live_owner_id,
  0,
  'verified-live-owner-' || live_owner_id::text || '@test.local',
  false
  from verified_settlement_ctx
union all
select
  missing_owner_id,
  0,
  'verified-missing-owner-' || missing_owner_id::text || '@test.local',
  false
  from verified_settlement_ctx
union all
select
  quarantine_owner_id,
  0,
  'verified-quarantine-owner-' || quarantine_owner_id::text || '@test.local',
  false
  from verified_settlement_ctx;

insert into public.orders(
  order_uuid,
  user_id,
  product_id,
  amount,
  credits,
  status,
  provider,
  payment_id,
  is_test,
  pay_channel,
  expected_store_id,
  expected_currency,
  expected_channel_key,
  created_at
)
select
  order_id,
  fixture_owner_id,
  'verified-pack',
  1000,
  3,
  'pending',
  'portone',
  pg_catalog.replace(order_id::text, '-', ''),
  is_test,
  'card',
  'store-qa',
  'KRW',
  case when is_test then 'channel-card-test' else 'channel-card-live' end,
  c.paid_at - interval '1 minute'
from verified_settlement_ctx c
cross join lateral (
  values
    (c.good_order, c.owner_id, true),
    (c.live_order, c.live_owner_id, false),
    (c.missing_order, c.missing_owner_id, true),
    (c.quarantine_order, c.quarantine_owner_id, true)
) fixture(order_id, fixture_owner_id, is_test);

select lives_ok(
  $test$
    do $body$
    declare
      c verified_settlement_ctx%rowtype;
      v_constraint text;
    begin
      select * into strict c from verified_settlement_ctx;
      begin
        insert into public.orders(
          order_uuid,
          user_id,
          product_id,
          amount,
          credits,
          status,
          provider,
          payment_id,
          is_test,
          pay_channel,
          created_at
        )
        values (
          c.legacy_order,
          c.admin_id,
          'verified-legacy-pack',
          1000,
          3,
          'pending',
          'portone',
          pg_catalog.replace(c.legacy_order::text, '-', ''),
          true,
          'card',
          c.paid_at - interval '1 minute'
        );
        raise exception 'legacy PortOne NULL evidence insert succeeded';
      exception
        when check_violation then
          get stacked diagnostics v_constraint = constraint_name;
          if v_constraint is distinct from
               'orders_portone_payment_evidence_required_check' then
            raise;
          end if;
      end;

      begin
        insert into public.orders(
          order_uuid,
          user_id,
          product_id,
          amount,
          credits,
          status,
          provider,
          payment_id,
          is_test,
          pay_channel,
          expected_store_id,
          expected_currency,
          expected_channel_key,
          created_at
        )
        values (
          c.missing_payment_order,
          c.admin_id,
          'verified-missing-payment-pack',
          1000,
          3,
          'pending',
          'portone',
          null,
          true,
          'card',
          'store-qa',
          'KRW',
          'channel-card-test',
          c.paid_at - interval '1 minute'
        );
        raise exception 'PortOne NULL payment id insert succeeded';
      exception
        when check_violation then
          get stacked diagnostics v_constraint = constraint_name;
          if v_constraint is distinct from
               'orders_portone_payment_evidence_required_check' then
            raise;
          end if;
      end;

      begin
        insert into public.orders(
          order_uuid,
          user_id,
          product_id,
          amount,
          credits,
          status,
          provider,
          payment_id,
          is_test,
          pay_channel,
          expected_store_id,
          expected_currency,
          expected_channel_key,
          created_at
        )
        values (
          c.foreign_payment_order,
          c.admin_id,
          'verified-foreign-payment-pack',
          1000,
          3,
          'pending',
          'portone',
          (
            case
              when pg_catalog.left(
                     pg_catalog.replace(
                       c.foreign_payment_order::text,
                       '-',
                       ''
                     ),
                     1
                   ) = '0'
                then '1'
              else '0'
            end
          ) || pg_catalog.substr(
            pg_catalog.replace(c.foreign_payment_order::text, '-', ''),
            2
          ),
          true,
          'card',
          'store-qa',
          'KRW',
          'channel-card-test',
          c.paid_at - interval '1 minute'
        );
        raise exception 'foreign PortOne payment id insert succeeded';
      exception
        when check_violation then
          get stacked diagnostics v_constraint = constraint_name;
          if v_constraint is distinct from
               'orders_portone_payment_evidence_required_check' then
            raise;
          end if;
      end;
    end;
    $body$
  $test$,
  'contract required CHECK enforces UUID-derived id and complete PortOne evidence'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.orders o
      join verified_settlement_ctx c
        on o.order_uuid in (
          c.legacy_order,
          c.missing_payment_order,
          c.foreign_payment_order
        )
  ),
  0,
  'rejected incomplete or foreign PortOne identities persist no order'
);

select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.live_order,
    'verified live mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-live-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.live_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-live-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-live'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'TEST-channel evidence cannot settle a live order'
)
from verified_settlement_ctx c;
select is(
  (
    select o.status
      from public.orders o
      join verified_settlement_ctx c on c.live_order = o.order_uuid
  ),
  'pending',
  'channel mismatch leaves the live order untouched'
);

select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.missing_order,
    'verified missing channel',
    gen_random_uuid(),
    c.paid_at,
    'tx-missing-channel',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.missing_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-missing-channel',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW'
    )::text
  ),
  'invalid_payment_evidence',
  'missing channel evidence fails closed'
)
from verified_settlement_ctx c;
select is(
  (
    select o.status
      from public.orders o
      join verified_settlement_ctx c on c.missing_order = o.order_uuid
  ),
  'pending',
  'missing channel evidence leaves the order untouched'
);

select throws_ok(
  pg_catalog.format(
    'select public.mark_paid_and_grant(%L::uuid,%L,1000,%L::jsonb,%L::timestamptz,null)',
    c.good_order,
    'tx-direct-store-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-direct-store-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-other',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text,
    c.paid_at
  ),
  'invalid_payment_evidence',
  'direct paid transition cannot bypass the checkout store snapshot'
)
from verified_settlement_ctx c;

select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified payment id mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-payment-id-mismatch',
    pg_catalog.jsonb_build_object(
      'id', 'different-payment-id',
      'status', 'PAID',
      'transactionId', 'tx-payment-id-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement rejects a different provider payment id'
)
from verified_settlement_ctx c;
select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified provider status mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-status-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'READY',
      'transactionId', 'tx-status-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement rejects a non-PAID provider status'
)
from verified_settlement_ctx c;
select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified transaction id mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-scalar-value',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-raw-value',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement requires the scalar and raw transaction ids to match'
)
from verified_settlement_ctx c;
select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified provider amount mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-amount-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-amount-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1001),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement rejects a different provider amount'
)
from verified_settlement_ctx c;

select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified store mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-store-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-store-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-other',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement rejects a different PortOne store'
)
from verified_settlement_ctx c;
select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified currency mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-currency-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-currency-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'USD',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement rejects a different payment currency'
)
from verified_settlement_ctx c;
select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified channel key mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-channel-key-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-channel-key-mismatch',
      'paidAt', c.paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-other'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'verified settlement rejects a different PortOne channel key'
)
from verified_settlement_ctx c;

select throws_ok(
  pg_catalog.format(
    'select public.admin_settle_stuck_order_verified(%L::uuid,%L::uuid,%L,%L::uuid,%L::timestamptz,%L,null,%L::jsonb)',
    c.admin_id,
    c.good_order,
    'verified timestamp mismatch',
    gen_random_uuid(),
    c.paid_at,
    'tx-timestamp-mismatch',
    pg_catalog.jsonb_build_object(
      'id', pg_catalog.replace(c.good_order::text, '-', ''),
      'status', 'PAID',
      'transactionId', 'tx-timestamp-mismatch',
      'paidAt', c.paid_at + interval '1 second',
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'TEST',
        'key', 'channel-card-test'
      )
    )::text
  ),
  'invalid_payment_evidence',
  'argument and raw paidAt must match exactly'
)
from verified_settlement_ctx c;
select is(
  (
    select o.status
      from public.orders o
      join verified_settlement_ctx c on c.good_order = o.order_uuid
  ),
  'pending',
  'timestamp mismatch leaves the order untouched'
);

update verified_settlement_ctx c
   set good_result = public.admin_settle_stuck_order_verified(
     c.admin_id,
     c.good_order,
     'verified provider settlement',
     c.request_id,
     c.paid_at,
     'tx-verified-good',
     'https://example.test/receipt',
     pg_catalog.jsonb_build_object(
       'id', pg_catalog.replace(c.good_order::text, '-', ''),
       'status', 'PAID',
       'transactionId', 'tx-verified-good',
       'paidAt', c.paid_at,
       'receiptUrl', 'https://example.test/receipt',
       'amount', pg_catalog.jsonb_build_object('total', 1000),
       'storeId', 'store-qa',
       'currency', 'KRW',
       'channel', pg_catalog.jsonb_build_object(
         'type', 'TEST',
         'key', 'channel-card-test'
       )
     )
   );

select is(
  (select (good_result->>'credits')::integer from verified_settlement_ctx),
  3,
  'verified settlement grants the configured credits'
);
select is(
  (
    select o.status
      from public.orders o
      join verified_settlement_ctx c on c.good_order = o.order_uuid
  ),
  'paid',
  'verified settlement reaches paid state'
);
select is(
  (
    select o.paid_at
      from public.orders o
      join verified_settlement_ctx c on c.good_order = o.order_uuid
  ),
  (select paid_at from verified_settlement_ctx),
  'order keeps the provider paidAt rather than administrator verification time'
);
select is(
  (
    select o.pg_tx_id
      from public.orders o
      join verified_settlement_ctx c on c.good_order = o.order_uuid
  ),
  'tx-verified-good',
  'order keeps the exact provider transaction id'
);
select is(
  (
    select o.raw->>'paidAt'
      from public.orders o
      join verified_settlement_ctx c on c.good_order = o.order_uuid
  )::timestamptz,
  (select paid_at from verified_settlement_ctx),
  'order keeps the raw paidAt evidence'
);
select is(
  (
    select m.gen_credits
      from public.member_accounts m
      join verified_settlement_ctx c on c.owner_id = m.user_id
  ),
  3,
  'verified settlement updates the live credit cache once'
);
select is(
  (
    select l.granted_at
      from public.credit_lots l
      join verified_settlement_ctx c on c.good_order = l.order_uuid
  ),
  (select paid_at from verified_settlement_ctx),
  'purchase lot grant time is the provider paidAt'
);
select is(
  (
    select l.expires_at
      from public.credit_lots l
      join verified_settlement_ctx c on c.good_order = l.order_uuid
  ),
  (select paid_at + interval '1 year' from verified_settlement_ctx),
  'purchase lot expiry derives from provider paidAt'
);
select is(
  (
    select (l.metadata->>'provider_paid_at')::timestamptz
      from public.admin_actions_ledger l
      join verified_settlement_ctx c on c.good_order = l.order_uuid
     where l.action_type = 'settle_stuck'
  ),
  (select paid_at from verified_settlement_ctx),
  'financial audit ledger preserves provider paidAt'
);
select is(
  (
    select public.get_admin_settlement_receipt(
      c.admin_id,
      c.good_order,
      'verified provider settlement',
      c.request_id
    ) #>> '{result,after}'
      from verified_settlement_ctx c
  ),
  '3',
  'completed result has a durable recovery receipt'
);
select is(
  (
    select public.admin_settle_stuck_order_verified(
      c.admin_id,
      c.good_order,
      'verified provider settlement',
      c.request_id,
      c.paid_at,
      'tx-verified-good',
      'https://example.test/receipt',
      pg_catalog.jsonb_build_object(
        'id', pg_catalog.replace(c.good_order::text, '-', ''),
        'status', 'PAID',
        'transactionId', 'tx-verified-good',
        'paidAt', c.paid_at,
        'receiptUrl', 'https://example.test/receipt',
        'amount', pg_catalog.jsonb_build_object('total', 1000),
        'storeId', 'store-qa',
        'currency', 'KRW',
        'channel', pg_catalog.jsonb_build_object(
          'type', 'TEST',
          'key', 'channel-card-test'
        )
      )
    )->>'idempotent'
      from verified_settlement_ctx c
  ),
  'true',
  'exact response-loss replay returns the durable receipt'
);
select is(
  (
    select public.admin_settle_stuck_order_verified(
      c.admin_id,
      c.good_order,
      'verified provider settlement',
      c.second_request_id,
      c.paid_at,
      'tx-verified-good',
      'https://example.test/receipt',
      pg_catalog.jsonb_build_object(
        'id', pg_catalog.replace(c.good_order::text, '-', ''),
        'status', 'PAID',
        'transactionId', 'tx-verified-good',
        'paidAt', c.paid_at,
        'receiptUrl', 'https://example.test/receipt',
        'amount', pg_catalog.jsonb_build_object('total', 1000),
        'storeId', 'store-qa',
        'currency', 'KRW',
        'channel', pg_catalog.jsonb_build_object(
          'type', 'TEST',
          'key', 'channel-card-test'
        )
      )
    )->>'noOp'
      from verified_settlement_ctx c
  ),
  'true',
  'a distinct stale administrator request converges on the settlement ledger'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.credit_lots l
      join verified_settlement_ctx c on c.good_order = l.order_uuid
  ),
  1,
  'all settlement replays create exactly one purchase lot'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.admin_actions_ledger l
      join verified_settlement_ctx c on c.good_order = l.order_uuid
     where l.action_type = 'settle_stuck'
  ),
  1,
  'all settlement replays create exactly one financial audit row'
);
select is(
  (
    select m.gen_credits
      from public.member_accounts m
      join verified_settlement_ctx c on c.owner_id = m.user_id
  ),
  3,
  'all settlement replays keep the credit cache exactly once'
);

update public.orders o
   set cancel_requested_at = c.paid_at - interval '30 seconds',
       cancel_requested_by = c.admin_id,
       cancel_intent_created_at = c.paid_at - interval '30 seconds',
       cancel_intent_reason = 'verified cancellation intent'
  from verified_settlement_ctx c
 where o.order_uuid = c.quarantine_order;

update verified_settlement_ctx c
   set quarantine_result = public.admin_settle_stuck_order_verified(
     c.admin_id,
     c.quarantine_order,
     'verified quarantined settlement',
     c.quarantine_request_id,
     c.paid_at,
     'tx-verified-quarantine',
     'https://example.test/quarantine-receipt',
     pg_catalog.jsonb_build_object(
       'id', pg_catalog.replace(c.quarantine_order::text, '-', ''),
       'status', 'PAID',
       'transactionId', 'tx-verified-quarantine',
       'paidAt', c.paid_at,
       'receiptUrl', 'https://example.test/quarantine-receipt',
       'amount', pg_catalog.jsonb_build_object('total', 1000),
       'storeId', 'store-qa',
       'currency', 'KRW',
       'channel', pg_catalog.jsonb_build_object(
         'type', 'TEST',
         'key', 'channel-card-test'
       )
     )
   );

select is(
  (select (quarantine_result->>'credits')::integer
     from verified_settlement_ctx),
  0,
  'cancel-intent settlement grants zero live credits'
);
select is(
  (select (quarantine_result->>'requestedCredits')::integer
     from verified_settlement_ctx),
  3,
  'quarantined result preserves the requested credit amount'
);
select is(
  (select (quarantine_result->>'quarantined')::boolean
     from verified_settlement_ctx),
  true,
  'cancel-intent settlement is explicitly quarantined'
);
select is(
  (
    select (quarantine_result->>'after')::integer
         - (quarantine_result->>'before')::integer
      from verified_settlement_ctx
  ),
  0,
  'quarantined result proves the balance did not change'
);
select is(
  (
    select m.gen_credits
      from public.member_accounts m
      join verified_settlement_ctx c
        on c.quarantine_owner_id = m.user_id
  ),
  0,
  'quarantined settlement leaves the live credit cache unchanged'
);
select is(
  (
    select o.error_message
      from public.orders o
      join verified_settlement_ctx c
        on c.quarantine_order = o.order_uuid
  ),
  'cancel_intent_no_grant',
  'quarantined settlement preserves the durable no-grant marker'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.reconciliation_issues i
      join verified_settlement_ctx c
        on c.quarantine_order = i.order_uuid
     where i.type = 'late_paid'
       and i.state = 'open'
  ),
  1,
  'quarantined settlement keeps one durable open late-paid issue'
);
select ok(
  (
    select public.get_admin_settlement_receipt(
             c.admin_id,
             c.quarantine_order,
             'verified quarantined settlement',
             c.quarantine_request_id
           ) #>> '{result,quarantined}' = 'true'
       and public.get_admin_settlement_receipt(
             c.admin_id,
             c.quarantine_order,
             'verified quarantined settlement',
             c.quarantine_request_id
           ) #>> '{result,requestedCredits}' = '3'
      from verified_settlement_ctx c
  ),
  'durable receipt preserves the quarantine discriminant and request amount'
);
select ok(
  (
    select
      public.admin_settle_stuck_order_verified(
        c.admin_id,
        c.quarantine_order,
        'verified quarantined settlement',
        c.quarantine_request_id,
        c.paid_at,
        'tx-verified-quarantine',
        'https://example.test/quarantine-receipt',
        pg_catalog.jsonb_build_object(
          'id', pg_catalog.replace(c.quarantine_order::text, '-', ''),
          'status', 'PAID',
          'transactionId', 'tx-verified-quarantine',
          'paidAt', c.paid_at,
          'receiptUrl', 'https://example.test/quarantine-receipt',
          'amount', pg_catalog.jsonb_build_object('total', 1000),
          'storeId', 'store-qa',
          'currency', 'KRW',
          'channel', pg_catalog.jsonb_build_object(
            'type', 'TEST',
            'key', 'channel-card-test'
          )
        )
      ) @> '{"idempotent":true,"quarantined":true,"requestedCredits":3}'::jsonb
      from verified_settlement_ctx c
  ),
  'exact response-loss replay cannot lose the quarantine outcome'
);
select ok(
  (
    select
      public.admin_settle_stuck_order_verified(
        c.admin_id,
        c.quarantine_order,
        'verified quarantined settlement',
        c.quarantine_second_request_id,
        c.paid_at,
        'tx-verified-quarantine',
        'https://example.test/quarantine-receipt',
        pg_catalog.jsonb_build_object(
          'id', pg_catalog.replace(c.quarantine_order::text, '-', ''),
          'status', 'PAID',
          'transactionId', 'tx-verified-quarantine',
          'paidAt', c.paid_at,
          'receiptUrl', 'https://example.test/quarantine-receipt',
          'amount', pg_catalog.jsonb_build_object('total', 1000),
          'storeId', 'store-qa',
          'currency', 'KRW',
          'channel', pg_catalog.jsonb_build_object(
            'type', 'TEST',
            'key', 'channel-card-test'
          )
        )
      ) @> '{"noOp":true,"quarantined":true,"requestedCredits":3}'::jsonb
      from verified_settlement_ctx c
  ),
  'distinct stale request reconstructs the quarantined ledger result exactly'
);
select ok(
  (
    select pg_catalog.count(*) = 1
       and pg_catalog.min(l.credit_delta) = 0
      from public.admin_actions_ledger l
      join verified_settlement_ctx c
        on c.quarantine_order = l.order_uuid
     where l.action_type = 'settle_stuck'
  ),
  'quarantined replays keep one zero-delta financial audit row'
);

select is(
  (
    select public.admin_refund_begin(
      c.refund_request_id,
      c.admin_id,
      c.owner_id,
      c.good_order,
      1,
      'refund after verified settlement',
      c.paid_at + interval '8 days',
      'manual_transfer'
    )->>'rate_bps'
      from verified_settlement_ctx c
  ),
  '9000',
  'refund policy uses the actual provider paidAt across the seven-day boundary'
);
select is(
  (
    select a.paid_at_snapshot
      from public.order_refund_attempts a
      join verified_settlement_ctx c
        on c.refund_request_id = a.request_id
  ),
  (select paid_at from verified_settlement_ctx),
  'refund attempt freezes the exact provider paidAt'
);

select * from finish();
rollback;
