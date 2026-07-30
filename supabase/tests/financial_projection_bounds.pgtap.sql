-- 008902 bounded financial projection.
--
-- Both paths use the real payment/cancellation RPCs:
--   * a 100-event projection remains below 32 KiB and resolves atomically;
--   * a 125-event, 256-character-id projection exceeds 32 KiB and converges
--     to a durable ineligible batch without mutating the order or events.

begin;
select plan(29);

select has_function(
  'public',
  'bp_0084_resolve_external_cancellation_auto_full_impl',
  array['uuid'],
  'bounded private auto-full implementation exists'
);
select ok(
  not pg_catalog.has_function_privilege(
    'service_role',
    'public.bp_0084_resolve_external_cancellation_auto_full_impl(uuid)',
    'EXECUTE'
  ),
  'service role cannot bypass the locking auto-full wrapper'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.resolve_external_cancellation_auto_full(uuid)',
    'EXECUTE'
  ),
  'service role can execute the locking auto-full wrapper'
);

select lives_ok($$
  insert into public.app_settings(key, value)
  values (
    'growth_levers',
    pg_catalog.jsonb_build_object(
      'products',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'credits_3',
          'goodname', 'Projection QA credits',
          'price', 1000,
          'credits', 3,
          'active', true
        )
      )
    )
  )
  on conflict (key) do update set value = excluded.value
$$, 'canonical QA product is available');

create temporary table financial_projection_ctx (
  key text primary key,
  user_id uuid,
  order_uuid uuid,
  result jsonb
) on commit drop;

insert into financial_projection_ctx(key, user_id)
values
  ('admin', pg_catalog.gen_random_uuid()),
  ('within', pg_catalog.gen_random_uuid()),
  ('over', pg_catalog.gen_random_uuid());

select lives_ok($$
  insert into auth.users(id, email)
  select
    c.user_id,
    'projection-' || c.key || '-' || c.user_id::text || '@test.local'
  from financial_projection_ctx c;

  insert into public.member_accounts(user_id, gen_credits, is_admin)
  select
    c.user_id,
    0,
    c.key = 'admin'
  from financial_projection_ctx c
  on conflict (user_id) do update
    set is_admin = excluded.is_admin
$$, 'fixture users and memberships are created');

create function pg_temp.create_projection_paid_order(p_key text)
returns uuid
language plpgsql
as $fn$
declare
  v_user_id uuid;
  v_order_uuid uuid := pg_catalog.gen_random_uuid();
  v_payment_id text;
  v_paid_at timestamptz :=
    pg_catalog.date_trunc(
      'milliseconds',
      pg_catalog.clock_timestamp()
    );
begin
  select c.user_id
    into v_user_id
    from financial_projection_ctx c
   where c.key = p_key;
  v_payment_id := pg_catalog.replace(v_order_uuid::text, '-', '');

  perform public.bp_008905_create_or_reuse_pending_order_impl(
    v_user_id,
    v_order_uuid,
    'credits_3',
    1000,
    3,
    v_payment_id,
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
  perform public.mark_paid_and_grant(
    v_order_uuid,
    'projection-' || v_payment_id,
    1000,
    pg_catalog.jsonb_build_object(
      'id', v_payment_id,
      'status', 'PAID',
      'transactionId', 'projection-' || v_payment_id,
      'paidAt', v_paid_at,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE',
        'key', 'channel-card-live'
      )
    ),
    v_paid_at,
    'https://receipt.example/' || v_payment_id
  );
  update financial_projection_ctx
     set order_uuid = v_order_uuid
   where key = p_key;
  return v_order_uuid;
end;
$fn$;

select lives_ok(
  $$ select pg_temp.create_projection_paid_order('within') $$,
  'within-cap paid order is created'
);
select lives_ok($$
  select public.cancel_intent_begin(
    (select user_id from financial_projection_ctx where key = 'admin'),
    (select order_uuid from financial_projection_ctx where key = 'within'),
    pg_catalog.clock_timestamp(),
    'projection boundary automatic cancellation'
  )
$$, 'within-cap order has a cancellation intent');
select lives_ok($$
  select public.record_payment_cancellation_observation(
    (select order_uuid from financial_projection_ctx where key = 'within'),
    'within-' || pg_catalog.lpad(g::text, 3, '0'),
    'SUCCEEDED',
    10,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    '{}'::jsonb
  )
  from pg_catalog.generate_series(1, 100) g
$$, '100 within-cap cancellation events are recorded');
select lives_ok($$
  update financial_projection_ctx
     set result = public.resolve_external_cancellation_auto_full(order_uuid)
   where key = 'within'
$$, 'within-cap projection resolves without an exception');
select is(
  (
    select result->>'outcome'
      from financial_projection_ctx
     where key = 'within'
  ),
  'resolved_full',
  'within-cap projection is resolved'
);
select is(
  (
    select pg_catalog.jsonb_array_length(b.cancellation_projection)
      from public.cancellation_resolution_batches b
      join financial_projection_ctx c
        on b.id = (c.result->>'batch_id')::uuid
     where c.key = 'within'
  ),
  100,
  'within-cap batch preserves every event'
);
select ok(
  (
    select pg_catalog.octet_length(b.cancellation_projection::text) <= 32768
      from public.cancellation_resolution_batches b
      join financial_projection_ctx c
        on b.id = (c.result->>'batch_id')::uuid
     where c.key = 'within'
  ),
  'within-cap batch satisfies the immutable byte limit'
);
select is(
  (
    select o.status
      from public.orders o
      join financial_projection_ctx c
        on c.order_uuid = o.order_uuid
     where c.key = 'within'
  ),
  'canceled',
  'within-cap order reaches the canceled terminal state'
);
select is(
  (
    select pg_catalog.jsonb_build_array(
      o.refunded_amount,
      o.refunded_credits
    )
      from public.orders o
      join financial_projection_ctx c
        on c.order_uuid = o.order_uuid
     where c.key = 'within'
  ),
  '[1000, 3]'::jsonb,
  'within-cap order is fully refunded'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.payment_cancellation_events e
      join financial_projection_ctx c
        on c.order_uuid = e.order_uuid
     where c.key = 'within'
       and e.resolution_state = 'resolved'
  ),
  100,
  'every within-cap event is resolved'
);

select lives_ok(
  $$ select pg_temp.create_projection_paid_order('over') $$,
  'over-cap paid order is created'
);
select lives_ok($$
  select public.cancel_intent_begin(
    (select user_id from financial_projection_ctx where key = 'admin'),
    (select order_uuid from financial_projection_ctx where key = 'over'),
    pg_catalog.clock_timestamp(),
    'projection boundary manual cancellation'
  )
$$, 'over-cap order has a cancellation intent');
select lives_ok($$
  select public.record_payment_cancellation_observation(
    (select order_uuid from financial_projection_ctx where key = 'over'),
    'over-' || pg_catalog.lpad(g::text, 5, '0') || '-'
      || pg_catalog.repeat('x', 245),
    'SUCCEEDED',
    8,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    '{}'::jsonb
  )
  from pg_catalog.generate_series(1, 125) g
$$, '125 over-cap cancellation events are recorded');
select lives_ok($$
  update financial_projection_ctx
     set result = public.resolve_external_cancellation_auto_full(order_uuid)
   where key = 'over'
$$, 'over-cap projection converges without an exception');
select is(
  (
    select result->>'outcome'
      from financial_projection_ctx
     where key = 'over'
  ),
  'ineligible',
  'over-cap projection is explicitly ineligible'
);
select is(
  (
    select result->>'reason'
      from financial_projection_ctx
     where key = 'over'
  ),
  'projection_too_large',
  'over-cap result exposes the exact manual-review reason'
);
select is(
  (
    select (result->>'events')::integer
      from financial_projection_ctx
     where key = 'over'
  ),
  125,
  'over-cap result preserves the exact event count'
);
select ok(
  (
    select (result->>'projected_bytes')::numeric > 32768
      from financial_projection_ctx
     where key = 'over'
  ),
  'over-cap result exposes the exact projected byte count'
);
select is(
  (
    select b.cancellation_projection
      from public.cancellation_resolution_batches b
      join financial_projection_ctx c
        on b.id = (c.result->>'batch_id')::uuid
     where c.key = 'over'
  ),
  '[]'::jsonb,
  'over-cap durable batch does not materialize a partial projection'
);
select is(
  (
    select b.eligibility_hash_version::integer
      from public.cancellation_resolution_batches b
      join financial_projection_ctx c
        on b.id = (c.result->>'batch_id')::uuid
     where c.key = 'over'
  ),
  2,
  'over-cap durable batch uses the reason-bound hash contract'
);
select is(
  (
    select b.eligibility_hash
      from public.cancellation_resolution_batches b
      join financial_projection_ctx c
        on b.id = (c.result->>'batch_id')::uuid
     where c.key = 'over'
  ),
  (
    select public.bp_versioned_hash(
      pg_catalog.jsonb_build_object(
        'order_uuid', c.order_uuid::text,
        'eligible', false,
        'reason', 'projection_too_large',
        'event_count', (c.result->>'events')::bigint,
        'projected_bytes', (c.result->>'projected_bytes')::numeric,
        'total', 1000::numeric,
        'credits', 3
      ),
      2
    )
      from financial_projection_ctx c
     where c.key = 'over'
  ),
  'over-cap hash binds reason, count, bytes, total, and credits'
);
select is(
  (
    select pg_catalog.jsonb_build_array(
      o.status,
      o.refunded_amount,
      o.refunded_credits
    )
      from public.orders o
      join financial_projection_ctx c
        on c.order_uuid = o.order_uuid
     where c.key = 'over'
  ),
  '["paid", 0, 0]'::jsonb,
  'over-cap order has no partial financial mutation'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.payment_cancellation_events e
      join financial_projection_ctx c
        on c.order_uuid = e.order_uuid
     where c.key = 'over'
       and e.resolution_state = 'unmatched'
  ),
  125,
  'every over-cap event remains available for manual resolution'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.payment_cancellation_events e
      join financial_projection_ctx c
        on c.order_uuid = e.order_uuid
     where c.key = 'over'
       and e.resolution_batch_id is not null
  ),
  0,
  'over-cap path attaches no event to the ineligible batch'
);

select * from finish();
rollback;
