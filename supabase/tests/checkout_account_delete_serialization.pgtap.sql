-- 0075 lifecycle + 0087/008800 unresolved-intent index + 008899 atomic checkout
-- + 0092 payment-evidence contract + 0105 단일 검증 계층.
-- 단일 세션 pgTAP은 catalog·ACL·replay/reuse·prior-intent needs_provider_resolution
-- 반환 계약·p_prior_resolutions 종단·삭제·직접 INSERT 계약을 검증한다.
-- 실제 lock wait 양 방향은 scripts/qa/test-checkout-delete-race.sh가 별도 2세션으로 검증한다.

begin;
select plan(57);

select has_function(
  'public',
  'create_pending_order',
  array['uuid','uuid','text','integer','integer','text','text','text','boolean'],
  'create_pending_order keeper signature exists'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
  ),
  'create_pending_order remains SECURITY DEFINER'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'EXECUTE'
  ),
  'contract stage closes the legacy create_pending_order service surface'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot execute create_pending_order'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot execute create_pending_order'
);
select has_function(
  'public',
  'bp_0105_create_or_reuse_pending_order_impl',
  array[
    'uuid','uuid','text','integer','integer','text','text','text','boolean',
    'text','text','text'
  ],
  'private atomic checkout core signature exists'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid =
       'public.bp_0105_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'::regprocedure
  ),
  'private atomic checkout core remains SECURITY DEFINER'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_0105_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
    'EXECUTE'
  ),
  'service_role cannot bypass the affirmative checkout wrapper'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.bp_0105_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
    'EXECUTE'
  ),
  'anon cannot execute atomic checkout'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bp_0105_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot execute atomic checkout'
);
select is(
  pg_catalog.to_regprocedure(
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
  ),
  null::regprocedure,
  'superseded nine-argument atomic checkout overload is absent'
);
select is(
  pg_catalog.to_regprocedure(
    'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
  ),
  null::regprocedure,
  '0105 drops the nineteen-argument checkout wrapper overload'
);
select is(
  pg_catalog.to_regprocedure(
    'public.bp_008905_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
  ),
  null::regprocedure,
  '0105 drops the superseded 008905 atomic checkout core'
);
select is(
  pg_catalog.to_regprocedure(
    'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
  ),
  null::regprocedure,
  'superseded seven-argument payment-evidence backfill overload is absent'
);
select is(
  pg_catalog.to_regprocedure(
    'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
  ),
  null::regprocedure,
  'contract removes the temporary eight-argument payment-evidence backfill RPC'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.orders'::regclass
       and c.conname = 'orders_portone_payment_evidence_required_check'
       and c.contype = 'c'
       and c.convalidated
  ),
  'contract validates the complete PortOne evidence requirement'
);
select ok(
  (
    select normalized like '%providerisdistinctfrom''portone''%'
       and normalized like '%payment_idisnotnull%'
       and normalized like '%payment_id=replace%order_uuid%-%'
       and normalized like '%expected_store_idisnotnull%'
       and normalized like '%expected_currencyisnotnull%'
       and normalized like '%expected_channel_keyisnotnull%'
      from (
        select pg_catalog.replace(
                 pg_catalog.regexp_replace(
                   pg_catalog.lower(
                     pg_catalog.pg_get_constraintdef(c.oid)
                   ),
                   '[[:space:]()]',
                   '',
                   'g'
                 ),
                 '::text',
                 ''
               ) as normalized
          from pg_catalog.pg_constraint c
         where c.conrelid = 'public.orders'::regclass
           and c.conname =
                 'orders_portone_payment_evidence_required_check'
      ) definition
  ),
  'required CHECK binds PortOne payment id to the order UUID and complete tuple'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.orders'::regclass
       and tgname = 'trg_orders_account_lifecycle_guard'
       and tgenabled = 'O'
       and not tgisinternal
  ),
  'orders lifecycle trigger is enabled'
);
select ok(
  (
    select p.prosecdef
      from pg_catalog.pg_proc p
     where p.oid = 'public.bp_reject_deleted_order_insert()'::regprocedure
  ),
  'direct INSERT lifecycle trigger is SECURITY DEFINER'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_reject_deleted_order_insert()',
    'EXECUTE'
  ),
  'service_role cannot invoke lifecycle trigger function directly'
);
select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.orders'::regclass
       and tgname = 'trg_orders_insert_guard'
       and tgenabled = 'O'
       and not tgisinternal
  ),
  '0062 financial INSERT guard remains enabled'
);
select matches(
  pg_catalog.pg_get_functiondef(
    'public.bp_0084_create_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
  ),
  'public\.app_settings',
  '0065 config-backed product source is preserved'
);
select matches(
  pg_catalog.lower(
    pg_catalog.pg_get_functiondef(
      'public.bp_0084_create_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
    )
  ),
  'for key share',
  'create_pending_order locks profile FOR KEY SHARE'
);

-- Fresh migration-only databases intentionally have no seeded app_settings rows.
-- Make this rollback-local fixture independent of production/bootstrap seed state.
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

create temporary table checkout_delete_ctx (
  active_user uuid not null,
  deleted_user uuid not null,
  atomic_user uuid not null,
  atomic_order_one uuid not null,
  atomic_order_two uuid not null,
  atomic_order_credit_change uuid not null,
  atomic_order_channel uuid not null,
  atomic_order_mode uuid not null,
  atomic_order_window uuid not null,
  atomic_order_product uuid not null,
  atomic_order_price_change uuid not null,
  atomic_order_resolved uuid not null,
  atomic_order_second uuid not null,
  atomic_order_multi uuid not null,
  atomic_checkout_request uuid not null,
  product_id text not null,
  amount int not null,
  credits int not null
) on commit drop;

with product as (
  select elem->>'productId' as product_id,
         (elem->>'price')::int as amount,
         (elem->>'credits')::int as credits
    from public.app_settings s
         cross join lateral pg_catalog.jsonb_array_elements(s.value->'products') elem
   where s.key = 'growth_levers'
     and coalesce((elem->>'active')::boolean, false)
   order by elem->>'productId'
   limit 1
),
ids as (
  select gen_random_uuid() as active_user,
         gen_random_uuid() as deleted_user,
         gen_random_uuid() as atomic_user,
         gen_random_uuid() as atomic_order_one,
         gen_random_uuid() as atomic_order_two,
         gen_random_uuid() as atomic_order_credit_change,
         gen_random_uuid() as atomic_order_channel,
         gen_random_uuid() as atomic_order_mode,
         gen_random_uuid() as atomic_order_window,
         gen_random_uuid() as atomic_order_product,
         gen_random_uuid() as atomic_order_price_change,
         gen_random_uuid() as atomic_order_resolved,
         gen_random_uuid() as atomic_order_second,
         gen_random_uuid() as atomic_order_multi,
         gen_random_uuid() as atomic_checkout_request
)
insert into checkout_delete_ctx
select ids.active_user, ids.deleted_user, ids.atomic_user,
       ids.atomic_order_one, ids.atomic_order_two,
       ids.atomic_order_credit_change, ids.atomic_order_channel,
       ids.atomic_order_mode, ids.atomic_order_window,
       ids.atomic_order_product, ids.atomic_order_price_change,
       ids.atomic_order_resolved, ids.atomic_order_second,
       ids.atomic_order_multi, ids.atomic_checkout_request,
       product.product_id, product.amount, product.credits
  from ids cross join product;

insert into auth.users(id, email)
select active_user, 'checkout-active-' || active_user || '@test.local'
  from checkout_delete_ctx
union all
select deleted_user, 'checkout-deleted-' || deleted_user || '@test.local'
  from checkout_delete_ctx
union all
select atomic_user, 'checkout-atomic-' || atomic_user || '@test.local'
  from checkout_delete_ctx;

update public.profiles p
   set deleted_at = now()
  from checkout_delete_ctx c
 where p.id = c.deleted_user;

select throws_ok(
  format(
    'select public.bp_0105_create_or_reuse_pending_order_impl(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L)',
    active_user,
    v_order,
    product_id,
    amount + 1,
    credits,
    pg_catalog.replace(v_order::text, '-', ''),
    'portone',
    'card',
    'store-qa',
    'KRW',
    'channel-card'
  ),
  'P0001',
  'product_amount_mismatch',
  'atomic checkout validates the canonical product amount before insert'
)
from (
  select c.*, gen_random_uuid() as v_order
    from checkout_delete_ctx c
) q;

select throws_ok(
  format(
    'select public.bp_0105_create_or_reuse_pending_order_impl(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L)',
    deleted_user,
    v_order,
    product_id,
    amount,
    credits,
    pg_catalog.replace(v_order::text, '-', ''),
    'portone',
    'card',
    'store-qa',
    'KRW',
    'channel-card'
  ),
  'P0001',
  'account_deleted',
  'atomic checkout rejects a deleted account before order lookup/insert'
)
from (
  select c.*, gen_random_uuid() as v_order
    from checkout_delete_ctx c
) q;

select throws_ok(
  format(
    'insert into public.orders(order_uuid,user_id,product_id,amount,credits,status,provider,payment_id,is_test,pay_channel,expected_store_id,expected_currency,expected_channel_key) '
    || 'values(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L,%L)',
    v_order,
    deleted_user,
    product_id,
    amount,
    credits,
    'pending',
    'portone',
    pg_catalog.replace(v_order::text, '-', ''),
    'card',
    'store-qa',
    'KRW',
    'channel-card'
  ),
  'P0001',
  'account_deleted',
  'direct orders INSERT rejects a deleted owner'
)
from (
  select c.*, gen_random_uuid() as v_order
    from checkout_delete_ctx c
) q;

select throws_ok(
  format(
    'insert into public.orders(order_uuid,user_id,product_id,amount,credits,status,provider,payment_id,is_test,pay_channel,expected_store_id,expected_currency,expected_channel_key) '
    || 'values(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L,%L)',
    v_order,
    missing_user,
    product_id,
    amount,
    credits,
    'pending',
    'portone',
    pg_catalog.replace(v_order::text, '-', ''),
    'card',
    'store-qa',
    'KRW',
    'channel-card'
  ),
  'P0001',
  'account_not_found',
  'direct orders INSERT rejects a missing owner before FK fallthrough'
)
from (
  select c.*, gen_random_uuid() as v_order, gen_random_uuid() as missing_user
    from checkout_delete_ctx c
) q;

select throws_ok(
  format(
    'insert into public.orders(order_uuid,user_id,product_id,amount,credits,status,provider,payment_id,is_test,pay_channel,expected_store_id,expected_currency,expected_channel_key) '
    || 'values(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L,%L)',
    v_order,
    active_user,
    product_id,
    amount,
    credits,
    'paid',
    'portone',
    pg_catalog.replace(v_order::text, '-', ''),
    'card',
    'store-qa',
    'KRW',
    'channel-card'
  ),
  'P0001',
  'orders_insert_must_be_pending',
  'existing financial INSERT guard still rejects non-pending creation'
)
from (
  select c.*, gen_random_uuid() as v_order
    from checkout_delete_ctx c
) q;

select lives_ok(
  $test$
    do $body$
    declare
      c checkout_delete_ctx%rowtype;
      v_order uuid := pg_catalog.gen_random_uuid();
      v_constraint text;
    begin
      select * into strict c from checkout_delete_ctx;
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
          expected_channel_key
        )
        values (
          v_order,
          c.active_user,
          c.product_id,
          c.amount,
          c.credits,
          'pending',
          'portone',
          null,
          false,
          'card',
          'store-qa',
          'KRW',
          'channel-card'
        );
        raise exception 'PortOne order without a payment id was inserted';
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
  'required CHECK rejects a PortOne order without a payment id'
);

select lives_ok(
  $test$
    do $body$
    declare
      c checkout_delete_ctx%rowtype;
      v_order uuid := pg_catalog.gen_random_uuid();
      v_constraint text;
    begin
      select * into strict c from checkout_delete_ctx;
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
          expected_channel_key
        )
        values (
          v_order,
          c.active_user,
          c.product_id,
          c.amount,
          c.credits,
          'pending',
          'portone',
          (
            case
              when pg_catalog.left(
                     pg_catalog.replace(v_order::text, '-', ''),
                     1
                   ) = '0'
                then '1'
              else '0'
            end
          ) || pg_catalog.substr(
            pg_catalog.replace(v_order::text, '-', ''),
            2
          ),
          false,
          'card',
          'store-qa',
          'KRW',
          'channel-card'
        );
        raise exception 'PortOne order with a foreign payment id was inserted';
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
  'required CHECK binds each PortOne payment id to its order UUID'
);

select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      ack->>'order_uuid'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_one,
          c.product_id,
          c.amount,
          c.credits,
          pg_catalog.replace(c.atomic_order_one::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) created
  ),
  (
    select 'ready|' || atomic_order_one::text
      from checkout_delete_ctx
  ),
  'first atomic checkout creates and returns its candidate receipt'
);
select is(
  (
    select concat_ws(
      '|',
      o.expected_store_id,
      o.expected_currency,
      o.expected_channel_key
    )
      from public.orders o
      join checkout_delete_ctx c
        on c.atomic_order_one = o.order_uuid
  ),
  'store-qa|KRW|channel-card',
  'atomic checkout persists the exact PortOne namespace snapshot'
);
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      ack->>'order_uuid',
      ack->>'expected_store_id',
      ack->>'expected_channel_key'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_one,
          c.product_id,
          c.amount,
          c.credits,
          pg_catalog.replace(c.atomic_order_one::text, '-', ''),
          'portone',
          'card',
          false,
          'store-rotated',
          'KRW',
          'channel-rotated'
        ) as ack
          from checkout_delete_ctx c
      ) replayed
  ),
  (
    select 'replayed|' || atomic_order_one::text ||
           '|store-qa|channel-card'
      from checkout_delete_ctx
  ),
  'same-candidate replay preserves its prior immutable namespace after config rotation'
);
select throws_ok(
  (
    select pg_catalog.format(
      $sql$
        update public.orders
           set expected_channel_key = 'channel-rebound'
         where order_uuid = %L::uuid
      $sql$,
      c.atomic_order_one
    )
      from checkout_delete_ctx c
  ),
  'P0001',
  'payment_evidence_snapshot_immutable',
  'a complete checkout evidence snapshot is immutable'
);
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      ack->>'order_uuid'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_two,
          c.product_id,
          c.amount,
          c.credits,
          pg_catalog.replace(c.atomic_order_two::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) reused
  ),
  (
    select 'reused|' || atomic_order_one::text
      from checkout_delete_ctx
  ),
  'second candidate atomically reuses the exact pending snapshot'
);
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      ack->>'order_uuid',
      ack->>'expected_channel_key'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_two,
          c.product_id,
          c.amount,
          c.credits,
          pg_catalog.replace(c.atomic_order_two::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-rotated'
        ) as ack
          from checkout_delete_ctx c
      ) reused
  ),
  (
    select 'reused|' || atomic_order_one::text || '|channel-card'
      from checkout_delete_ctx
  ),
  'atomic reuse preserves the prior immutable PortOne namespace snapshot'
);
select is(
  (
    select count(*)::int
      from public.orders o
      join checkout_delete_ctx c on c.atomic_user = o.user_id
  ),
  1,
  'same atomic checkout slot persists exactly one order'
);

-- Once a charge-capable payment id has reached a browser, config drift must
-- preserve that exact unresolved intent rather than minting a second id.
update public.app_settings
   set value = pg_catalog.jsonb_build_object(
     'products',
     pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_object(
         'productId', 'credits_10',
         'goodname', 'pgTAP 생성권 11개',
         'price', 3000,
         'credits', 11,
         'active', true
       )
     )
   )
 where key = 'growth_levers';
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      ack->>'order_uuid',
      ack->>'credits'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_credit_change,
          c.product_id,
          c.amount,
          11,
          pg_catalog.replace(c.atomic_order_credit_change::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) changed
  ),
  (
    select 'reused|' || atomic_order_one::text || '|10'
      from checkout_delete_ctx
  ),
  'credit config drift reuses the frozen unresolved financial snapshot'
);
select is(
  (
    select count(*)::int
      from public.orders o
      join checkout_delete_ctx c on c.atomic_user = o.user_id
  ),
  1,
  'credit config drift cannot mint a second charge-capable order'
);
-- 0105: an unreusable prior intent is no longer an exception. The impl returns
-- outcome=needs_provider_resolution with the unresolved inventory so the caller
-- can resolve each intent against the provider and retry in one wrapper call.
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      pg_catalog.jsonb_array_length(ack->'intents')::text,
      ack->'intents'->0->>'order_uuid',
      ack->'intents'->0->>'payment_id'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_channel,
          c.product_id,
          c.amount,
          11,
          pg_catalog.replace(c.atomic_order_channel::text, '-', ''),
          'portone',
          'tosspay',
          false,
          'store-qa',
          'KRW',
          'channel-tosspay'
        ) as ack
          from checkout_delete_ctx c
      ) channel_case
  ),
  (
    select 'needs_provider_resolution|1|' || atomic_order_one::text
           || '|' || pg_catalog.replace(atomic_order_one::text, '-', '')
      from checkout_delete_ctx
  ),
  'a different channel surfaces the unresolved intent for provider resolution'
);
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      pg_catalog.jsonb_array_length(ack->'intents')::text,
      ack->'intents'->0->>'order_uuid'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_mode,
          c.product_id,
          c.amount,
          11,
          pg_catalog.replace(c.atomic_order_mode::text, '-', ''),
          'portone',
          'card',
          true,
          'store-qa',
          'KRW',
          'channel-card-test'
        ) as ack
          from checkout_delete_ctx c
      ) mode_case
  ),
  (
    select 'needs_provider_resolution|1|' || atomic_order_one::text
      from checkout_delete_ctx
  ),
  'a different TEST/LIVE mode surfaces the unresolved intent for provider resolution'
);
select is(
  (
    select count(*)::int
      from public.orders o
      join checkout_delete_ctx c on c.atomic_user = o.user_id
  ),
  1,
  'needs_provider_resolution leaves no durable second order'
);
update public.orders o
   set created_at =
     pg_catalog.transaction_timestamp() - interval '11 minutes'
  from checkout_delete_ctx c
 where o.order_uuid = c.atomic_order_credit_change;
select is(
  (
    select concat_ws('|', ack->>'outcome', ack->>'order_uuid')
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_window,
          c.product_id,
          c.amount,
          11,
          pg_catalog.replace(c.atomic_order_window::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) window_case
  ),
  (
    select 'reused|' || atomic_order_one::text
      from checkout_delete_ctx
  ),
  'an old pending browser intent is reused without a time-window bypass'
);

update public.app_settings
   set value = pg_catalog.jsonb_build_object(
     'products',
     pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_object(
         'productId', 'credits_10',
         'goodname', 'pgTAP 생성권 11개',
         'price', 3000,
         'credits', 11,
         'active', true
       ),
       pg_catalog.jsonb_build_object(
         'productId', 'credits_other',
         'goodname', 'pgTAP 다른 상품',
         'price', 3000,
         'credits', 11,
         'active', true
       )
     )
   )
 where key = 'growth_levers';
select is(
  (
    select concat_ws(
      '|',
      ack->>'outcome',
      pg_catalog.jsonb_array_length(ack->'intents')::text,
      ack->'intents'->0->>'order_uuid'
    )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_product,
          'credits_other',
          3000,
          11,
          pg_catalog.replace(c.atomic_order_product::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) product_case
  ),
  (
    select 'needs_provider_resolution|1|' || atomic_order_one::text
      from checkout_delete_ctx
  ),
  'a different product surfaces the sole unresolved intent for provider resolution'
);

update public.app_settings
   set value = pg_catalog.jsonb_set(
     value,
     '{products,0,price}',
     '3100'::jsonb
   )
 where key = 'growth_levers';
select is(
  (
    select concat_ws('|', ack->>'outcome', ack->>'order_uuid')
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_price_change,
          c.product_id,
          3100,
          11,
          pg_catalog.replace(c.atomic_order_price_change::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) price_case
  ),
  (
    select 'reused|' || atomic_order_one::text
      from checkout_delete_ctx
  ),
  'price config drift reuses the frozen unresolved financial snapshot'
);

update public.orders o
   set status = 'failed'
  from checkout_delete_ctx c
 where o.order_uuid = c.atomic_order_one;
select is(
  (
    select concat_ws('|', ack->>'outcome', ack->>'order_uuid', ack->>'status')
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_price_change,
          c.product_id,
          3100,
          11,
          pg_catalog.replace(c.atomic_order_price_change::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) failed_case
  ),
  (
    select 'reused|' || atomic_order_one::text || '|failed'
      from checkout_delete_ctx
  ),
  'a quasi-terminal failed PortOne id is reused instead of reminted'
);

select throws_ok(
  (
    select pg_catalog.format(
      'insert into public.orders(order_uuid,user_id,product_id,amount,credits,status,provider,payment_id,is_test,pay_channel,expected_store_id,expected_currency,expected_channel_key) '
      || 'values(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L,%L)',
      c.atomic_order_two,
      c.atomic_user,
      c.product_id,
      c.amount,
      c.credits,
      'pending',
      'portone',
      pg_catalog.replace(c.atomic_order_two::text, '-', ''),
      'card',
      'store-qa',
      'KRW',
      'channel-card'
    )
      from checkout_delete_ctx c
  ),
  '23505',
  'duplicate key value violates unique constraint "orders_one_unresolved_portone_intent_per_user_uidx"',
  'the named unique index blocks a second pending intent while failed remains charge-capable'
);
update public.orders o
   set status = 'canceled',
       canceled_at = pg_catalog.clock_timestamp()
  from checkout_delete_ctx c
 where o.order_uuid = c.atomic_order_one;
select lives_ok(
  (
    select pg_catalog.format(
      'insert into public.orders(order_uuid,user_id,product_id,amount,credits,status,provider,payment_id,is_test,pay_channel,expected_store_id,expected_currency,expected_channel_key) '
      || 'values(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L,%L)',
      c.atomic_order_two,
      c.atomic_user,
      c.product_id,
      c.amount,
      c.credits,
      'pending',
      'portone',
      pg_catalog.replace(c.atomic_order_two::text, '-', ''),
      'card',
      'store-qa',
      'KRW',
      'channel-card'
    )
      from checkout_delete_ctx c
  ),
  'a canceled terminal row does not consume the user unresolved-intent slot'
);
select throws_ok(
  (
    select pg_catalog.format(
      'update public.orders set status = %L, canceled_at = null, paid_at = null where order_uuid = %L::uuid',
      'failed',
      c.atomic_order_one
    )
      from checkout_delete_ctx c
  ),
  '23505',
  'duplicate key value violates unique constraint "orders_one_unresolved_portone_intent_per_user_uidx"',
  'the named unique index blocks a second failed intent while pending remains charge-capable'
);
select lives_ok(
  (
    select pg_catalog.format(
      'update public.orders set status = %L, canceled_at = null, paid_at = pg_catalog.clock_timestamp() where order_uuid = %L::uuid',
      'paid',
      c.atomic_order_one
    )
      from checkout_delete_ctx c
  ),
  'a paid terminal row can coexist with one unresolved PortOne intent'
);
select is(
  (
    select concat_ws('|', ack->>'outcome', ack->>'order_uuid')
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_price_change,
          c.product_id,
          3100,
          11,
          pg_catalog.replace(c.atomic_order_price_change::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) recovered
  ),
  (
    select 'reused|' || atomic_order_two::text
      from checkout_delete_ctx
  ),
  'terminal history leaves deterministic reuse of the sole unresolved intent'
);
select throws_ok(
  format(
    'select public.bp_0105_create_or_reuse_pending_order_impl(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L)',
    atomic_user,
    v_order,
    product_id,
    3100,
    11,
    pg_catalog.replace(v_order::text, '-', ''),
    'other-provider',
    'card',
    'store-qa',
    'KRW',
    'channel-card'
  ),
  'P0001',
  'invalid_payment_evidence_snapshot',
  'atomic checkout rejects a non-canonical provider'
)
from (
  select c.*, pg_catalog.gen_random_uuid() as v_order
    from checkout_delete_ctx c
) invalid_provider_case;
select throws_ok(
  format(
    'select public.bp_0105_create_or_reuse_pending_order_impl(%L::uuid,%L::uuid,%L,%s,%s,%L,%L,%L,false,%L,%L,%L)',
    atomic_user,
    v_order,
    product_id,
    3100,
    11,
    pg_catalog.replace(v_order::text, '-', ''),
    'portone',
    'cash',
    'store-qa',
    'KRW',
    'channel-cash'
  ),
  'P0001',
  'invalid_payment_evidence_snapshot',
  'atomic checkout rejects a non-canonical channel'
)
from (
  select c.*, pg_catalog.gen_random_uuid() as v_order
    from checkout_delete_ctx c
) invalid_channel_case;

-- 0105 p_prior_resolutions: the twenty-argument wrapper terminates provider-
-- observed non-PAID prior intents and opens the next order in one call.
-- Ownership is validated first — a foreign order_uuid must be rejected.
select throws_ok(
  (
    select pg_catalog.format(
      $sql$
        select public.create_or_reuse_pending_order(
          %L::uuid, %L::uuid, %L, %s, %s, %L, 'portone', 'card', false,
          'store-qa', 'KRW', 'channel-card', %L::uuid, %L, %L::uuid, %L,
          %L, %L, true,
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'order_uuid', %L::uuid,
              'pg_status', 'FAILED',
              'raw', '{}'::jsonb
            )
          )
        )
      $sql$,
      q.active_user,
      q.v_order,
      'credits_other',
      3000,
      11,
      pg_catalog.replace(q.v_order::text, '-', ''),
      q.v_request,
      'pgTAP 다른 상품',
      q.v_offer,
      pg_catalog.repeat('0', 64),
      'checkout-withdrawal-limit-2026-08-19-v2',
      '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
      q.atomic_order_two
    )
      from (
        select c.*,
               pg_catalog.gen_random_uuid() as v_order,
               pg_catalog.gen_random_uuid() as v_request,
               pg_catalog.gen_random_uuid() as v_offer
          from checkout_delete_ctx c
      ) q
  ),
  'P0001',
  'checkout_resolution_invalid',
  'a foreign-owned prior order cannot be resolved by another user checkout'
);

-- 유효 종단: 미해결 1건(다른 상품)을 비-PAID 실측 결과와 함께 넘기면
-- 같은 호출이 구 intent 를 canceled 로 종단하고 새 주문을 연다.
create temporary table qa_resolution_offer as
select public.record_commerce_display_evidence(
  'credits_offer',
  pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'copyVersion', 'credits-offer-2026-08-19-v3',
    'surface', 'credits_offer',
    'payMode', 'live',
    'products', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'productId', 'credits_other',
        'goodname', 'pgTAP 다른 상품',
        'priceKrwVatIncluded', 3000,
        'credits', 11
      )
    ),
    'channels', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'method', 'card',
        'label', '카드'
      )
    ),
    'displayCopy', pg_catalog.jsonb_build_object(
      'supply',
        '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.',
      'validity',
        '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.',
      'refund',
        '미사용 생성권은 환불받을 수 있어요(무료 지급분 제외, 일부 사용 시 남은 수량만큼).',
      'refundReferencePrefix',
        '기준·차감 순서·절차는',
      'termsLinkLabel', '이용약관 제10조',
      'refundReferenceSuffix', '를 확인해주세요.'
    )
  )
) as result;

create temporary table qa_resolution_checkout as
select public.create_or_reuse_pending_order(
  c.atomic_user,
  c.atomic_order_resolved,
  'credits_other',
  3000,
  11,
  pg_catalog.replace(c.atomic_order_resolved::text, '-', ''),
  'portone',
  'card',
  false,
  'store-qa',
  'KRW',
  'channel-card',
  c.atomic_checkout_request,
  'pgTAP 다른 상품',
  (select (result->>'evidence_id')::uuid from qa_resolution_offer),
  (select result->>'snapshot_sha256' from qa_resolution_offer),
  'checkout-withdrawal-limit-2026-08-19-v2',
  '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
  true,
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'order_uuid', c.atomic_order_two,
      'pg_status', 'FAILED',
      'raw', '{}'::jsonb
    )
  )
) as result
  from checkout_delete_ctx c;

select is(
  (
    select concat_ws(
      '|',
      result->>'outcome',
      result->>'order_uuid',
      result->>'withdrawal_confirmed'
    )
      from qa_resolution_checkout
  ),
  (
    select 'ready|' || atomic_order_resolved::text || '|true'
      from checkout_delete_ctx
  ),
  'one twenty-argument call resolves the prior intent and opens the next order'
);
select is(
  (
    select concat_ws('|', o.status, (o.canceled_at is not null)::text)
      from public.orders o
      join checkout_delete_ctx c on c.atomic_order_two = o.order_uuid
  ),
  'canceled|true',
  'the provider-resolved prior intent is terminally canceled in the same call'
);

-- 다건 미해결 재고: unique partial index 가 정상 경로에서 두 번째 intent 를
-- 차단하므로, rollback 로컬로 인덱스를 걷어내고 방어 계층(재고 전체 나열)만
-- 검증한다. 파일 전체가 rollback 이라 인덱스는 원복된다.
drop index public.orders_one_unresolved_portone_intent_per_user_uidx;
insert into public.orders(
  order_uuid, user_id, product_id, amount, credits, status, provider,
  payment_id, is_test, pay_channel, expected_store_id, expected_currency,
  expected_channel_key
)
select c.atomic_order_second, c.atomic_user, c.product_id, 3100, 11,
       'pending', 'portone',
       pg_catalog.replace(c.atomic_order_second::text, '-', ''),
       false, 'card', 'store-qa', 'KRW', 'channel-card'
  from checkout_delete_ctx c;
select ok(
  (
    select ack->>'outcome' = 'needs_provider_resolution'
       and pg_catalog.jsonb_array_length(ack->'intents') = 2
       and ack->'intents' @> pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'order_uuid', c2.atomic_order_resolved,
               'payment_id',
               pg_catalog.replace(c2.atomic_order_resolved::text, '-', '')
             ),
             pg_catalog.jsonb_build_object(
               'order_uuid', c2.atomic_order_second,
               'payment_id',
               pg_catalog.replace(c2.atomic_order_second::text, '-', '')
             )
           )
      from (
        select public.bp_0105_create_or_reuse_pending_order_impl(
          c.atomic_user,
          c.atomic_order_multi,
          'credits_other',
          3000,
          11,
          pg_catalog.replace(c.atomic_order_multi::text, '-', ''),
          'portone',
          'card',
          false,
          'store-qa',
          'KRW',
          'channel-card'
        ) as ack
          from checkout_delete_ctx c
      ) multi_case
      cross join checkout_delete_ctx c2
  ),
  'multiple unresolved intents are surfaced together for provider resolution'
);

select * from finish();
rollback;
