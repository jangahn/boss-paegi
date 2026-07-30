-- 008899_server_read_surface_rollout_gate.sql
--
-- Final expand checkpoint applied before the app deployment. It fixes fresh
-- Supabase's deny-by-default service read gaps and proves that both the old
-- server and the new server can coexist. 0092 is deliberately applied only
-- after deployment, smoke checks, and old-request drain.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

grant select on table
  public.profiles,
  public.dolls,
  public.reviewer_accounts,
  public.score_flags
to service_role;

-- Doll persistence is still a server write, but 0079's trigger requires and
-- consumes the exact owner/subject/path upload intent before attachment.
grant insert (id, owner_id, image_url, style_meta, role)
  on table public.dolls
  to service_role;

-- The short 0087/008800 phases already installed and validated the
-- immutable tuple and the user-wide unresolved-intent unique index. Refuse to
-- run this large function/ACL phase out of order; it intentionally performs no
-- orders-table DDL and therefore holds no long ACCESS EXCLUSIVE lock.
do $$
declare
  v_constraint_def text;
  v_index_def text;
begin
  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_constraint_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.orders'::regclass
     and c.conname = 'orders_payment_evidence_snapshot_check'
     and c.contype = 'c'
     and c.convalidated;

  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_index_def
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
   where i.indrelid = 'public.orders'::regclass
     and idx.relname =
           'orders_one_unresolved_portone_intent_per_user_uidx'
     and i.indisunique
     and i.indisvalid
     and i.indisready;

  if v_constraint_def is distinct from
       'check((((expected_store_idisnull)and(expected_currencyisnull)and(expected_channel_keyisnull))or((expected_store_idisnotnull)and(expected_currencyisnotnull)and(expected_channel_keyisnotnull)and((char_length(expected_store_id)>=1)and(char_length(expected_store_id)<=128))and(expected_store_id=btrim(expected_store_id))and(expected_store_id!~''[[:cntrl:]]''::text)and(expected_currency=''krw''::text)and((char_length(expected_channel_key)>=1)and(char_length(expected_channel_key)<=256))and(expected_channel_key=btrim(expected_channel_key))and(expected_channel_key!~''[[:cntrl:]]''::text))))'
     or v_index_def is distinct from
          'createuniqueindexorders_one_unresolved_portone_intent_per_user_uidxonpublic.ordersusingbtree(user_id)where((provider=''portone''::text)and(status=any(array[''pending''::text,''failed''::text]))and(paid_atisnull)and(canceled_atisnull))'
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.orders'::regclass
          and t.tgname = 'trg_orders_payment_evidence_snapshot'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgtype = 19
          and t.tgfoid =
                'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
          and t.tgattr = (
            select pg_catalog.string_agg(
                     a.attnum::text,
                     ' '
                     order by a.attnum
                   )::pg_catalog.int2vector
              from pg_catalog.pg_attribute a
             where a.attrelid = 'public.orders'::regclass
               and a.attname in (
                 'expected_store_id',
                 'expected_currency',
                 'expected_channel_key'
               )
               and not a.attisdropped
          )
     )
     or not exists (
       select 1
         from pg_catalog.pg_proc p
        where p.oid =
                'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
          and p.prosecdef
          and p.proconfig = array['search_path=""']::text[]
          and pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) =
                '048f737fe9b3bea8393389935a1aa31e'
          and not pg_catalog.has_function_privilege(
            'public',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'anon',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'service_role',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
     ) then
    raise exception '0087 preflight: payment evidence DDL phases missing';
  end if;
end;
$$;

-- Preserve the old-server RPC during expand, but close SQL three-valued-logic
-- holes in its historical implementation. In particular, NULL payment/order
-- ids and NULL provider/channel values must not pass `<>`/`NOT IN` checks.
create or replace function public.create_pending_order(
  p_user uuid,
  p_order_uuid uuid,
  p_product_id text,
  p_amount integer,
  p_credits integer,
  p_payment_id text,
  p_provider text,
  p_pay_channel text,
  p_is_test boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.orders%rowtype;
  v_candidate_count integer := 0;
begin
  if p_user is null then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if p_provider is distinct from 'portone' then
    raise exception 'invalid_provider' using errcode = 'P0001';
  end if;
  if coalesce(p_pay_channel, '') not in (
       'card', 'tosspay', 'kakaopay'
     ) then
    raise exception 'invalid_channel' using errcode = 'P0001';
  end if;
  if p_order_uuid is null
     or p_payment_id is distinct from
          pg_catalog.replace(p_order_uuid::text, '-', '') then
    raise exception 'payment_id_format' using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  perform public.bp_checkout_config_lock();
  perform public.bp_user_mutation_lock(p_user);

  -- The old application ignores this RPC's returned UUID and assembles the
  -- browser request from mutable deployment environment. It may therefore
  -- replay only the exact candidate it already owns; after the expand boundary
  -- it must never mint another all-NULL evidence order. The deployment runbook
  -- freezes checkout before 008899 and deploys the twelve-argument caller before
  -- reopening it. This database fence also makes an accidentally stale server
  -- fail closed instead of creating a payment that cannot be scoped exactly.
  for v_candidate in
    select *
      from public.orders o
     where o.user_id = p_user
       and o.provider = 'portone'
       and o.status in ('pending', 'failed')
       and o.paid_at is null
       and o.canceled_at is null
     order by o.created_at desc, o.order_uuid desc
     limit 2
     for update
  loop
    v_candidate_count := v_candidate_count + 1;
    if v_candidate_count > 1 then
      raise exception 'checkout_reuse_ambiguous' using errcode = 'P0001';
    end if;
  end loop;

  if v_candidate_count = 0 then
    raise exception 'checkout_upgrade_required' using errcode = 'P0001';
  end if;
  if v_candidate.payment_id is distinct from p_payment_id then
    raise exception 'checkout_reuse_required' using errcode = 'P0001';
  end if;

  -- The private implementation revalidates the current product, profile, and
  -- complete legacy snapshot. A failed or otherwise conflicting same-id row is
  -- rejected there; only an exact pending transport replay can return.
  return public.bp_0084_create_pending_order_impl(
    p_user,
    p_order_uuid,
    p_product_id,
    p_amount,
    p_credits,
    p_payment_id,
    p_provider,
    p_pay_channel,
    p_is_test
  );
end;
$$;
revoke all on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) to service_role;

-- New-server checkout entry point. It persists the immutable PortOne tuple in
-- the same INSERT as the order, so the 0090 required-evidence CHECK can stay
-- immediate. The old nine-argument RPC remains separately available only
-- during expand for exact replay only. Existing same-candidate calls are
-- explicit replays; the complete unresolved user inventory is reused; an
-- all-NULL legacy order is never
-- guessed from the current deployment configuration.
drop function if exists public.create_or_reuse_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
);
create or replace function public.create_or_reuse_pending_order(
  p_user uuid,
  p_order_uuid uuid,
  p_product_id text,
  p_amount integer,
  p_credits integer,
  p_payment_id text,
  p_provider text,
  p_pay_channel text,
  p_is_test boolean,
  p_expected_store_id text,
  p_expected_currency text,
  p_expected_channel_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount integer;
  v_credits integer;
  v_deleted_at timestamptz;
  v_order public.orders%rowtype;
  v_candidate public.orders%rowtype;
  v_candidate_count integer := 0;
  v_outcome text;
begin
  if p_user is null
     or p_order_uuid is null
     or p_provider is distinct from 'portone'
     or coalesce(p_pay_channel, '') not in (
       'card', 'tosspay', 'kakaopay'
     )
     or p_is_test is null
     or p_payment_id is distinct from
          pg_catalog.replace(p_order_uuid::text, '-', '')
     or pg_catalog.char_length(coalesce(p_payment_id, ''))
          not between 1 and 500
     or p_payment_id ~ '[[:cntrl:]]'
     or pg_catalog.char_length(coalesce(p_expected_store_id, ''))
          not between 1 and 128
     or p_expected_store_id <> pg_catalog.btrim(p_expected_store_id)
     or p_expected_store_id ~ '[[:cntrl:]]'
     or p_expected_currency is distinct from 'KRW'
     or pg_catalog.char_length(coalesce(p_expected_channel_key, ''))
          not between 1 and 256
     or p_expected_channel_key <>
          pg_catalog.btrim(p_expected_channel_key)
     or p_expected_channel_key ~ '[[:cntrl:]]' then
    raise exception 'invalid_payment_evidence_snapshot'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  perform public.bp_checkout_config_lock();
  perform public.bp_user_mutation_lock(p_user);

  select (elem->>'price')::integer, (elem->>'credits')::integer
    into v_amount, v_credits
    from public.app_settings s
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(s.value->'products', '[]'::jsonb)
    ) elem
   where s.key = 'growth_levers'
     and elem->>'productId' = p_product_id
     and coalesce((elem->>'active')::boolean, false);
  if v_amount is null then
    raise exception 'invalid_product' using errcode = 'P0001';
  end if;
  if p_amount is distinct from v_amount
     or p_credits is distinct from v_credits then
    raise exception 'product_amount_mismatch' using errcode = 'P0001';
  end if;

  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  -- Same payment id means a transport replay of this exact candidate.
  select *
    into v_order
    from public.orders o
   where o.payment_id = p_payment_id
   for update;
  if found then
    if v_order.order_uuid is distinct from p_order_uuid
       or v_order.user_id is distinct from p_user
       or v_order.product_id is distinct from p_product_id
       or v_order.status not in ('pending', 'failed')
       or v_order.provider is distinct from 'portone'
       or v_order.is_test is distinct from p_is_test
       or v_order.pay_channel is distinct from p_pay_channel
       or v_order.paid_at is not null
       or v_order.canceled_at is not null then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    if v_order.expected_store_id is null
       and v_order.expected_currency is null
       and v_order.expected_channel_key is null then
      raise exception 'legacy_checkout_refresh_required'
        using errcode = 'P0001';
    end if;
    if v_order.expected_store_id is null
       or v_order.expected_currency is null
       or v_order.expected_channel_key is null then
      raise exception 'checkout_evidence_conflict' using errcode = 'P0001';
    end if;
    v_outcome := 'replayed';
  else
    -- Once checkout parameters have reached any browser, a later tab must not
    -- mint a second charge-capable payment id while the first is still able to
    -- become PAID. This includes old pending rows and quasi-terminal failed
    -- rows: PortOne permits the same payment id to be retried until success.
    -- Serialize the complete unresolved user inventory, not a recent-window
    -- heuristic. A different product/mode/method is a visible conflict rather
    -- than an implicit supersession that an old tab could later double-charge.
    for v_candidate in
      select *
        from public.orders o
       where o.user_id = p_user
         and o.provider = 'portone'
         and o.status in ('pending', 'failed')
         and o.paid_at is null
         and o.canceled_at is null
       order by o.created_at desc, o.order_uuid desc
       limit 2
       for update
    loop
      v_candidate_count := v_candidate_count + 1;
      if v_candidate_count > 1 then
        raise exception 'checkout_reuse_ambiguous' using errcode = 'P0001';
      end if;
      v_order := v_candidate;
    end loop;
    if v_candidate_count = 1 then
      if v_order.product_id is distinct from p_product_id
         or v_order.is_test is distinct from p_is_test
         or v_order.pay_channel is distinct from p_pay_channel
         or v_order.payment_id is null
         or v_order.payment_id is distinct from
              pg_catalog.replace(v_order.order_uuid::text, '-', '') then
        raise exception 'checkout_prior_intent_unresolved'
          using errcode = 'P0001';
      end if;
      if v_order.expected_store_id is null
         and v_order.expected_currency is null
         and v_order.expected_channel_key is null then
        raise exception 'legacy_checkout_refresh_required'
          using errcode = 'P0001';
      end if;
      if v_order.expected_store_id is null
         or v_order.expected_currency is null
         or v_order.expected_channel_key is null then
        raise exception 'checkout_evidence_conflict' using errcode = 'P0001';
      end if;
      v_outcome := 'reused';
    else
      insert into public.orders (
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
        p_order_uuid,
        p_user,
        p_product_id,
        p_amount,
        p_credits,
        'pending',
        'portone',
        p_payment_id,
        p_is_test,
        p_pay_channel,
        p_expected_store_id,
        p_expected_currency,
        p_expected_channel_key
      )
      returning * into v_order;
      v_outcome := 'ready';
    end if;
  end if;

  if v_order.expected_store_id is null
     and v_order.expected_currency is null
     and v_order.expected_channel_key is null then
    raise exception 'legacy_checkout_refresh_required'
      using errcode = 'P0001';
  end if;

  if v_order.order_uuid is null
     or v_order.user_id is distinct from p_user
     or v_order.product_id is distinct from p_product_id
     or v_order.amount is null
     or v_order.amount <= 0
     or v_order.credits is null
     or v_order.credits <= 0
     or v_order.status not in ('pending', 'failed')
     or v_order.provider is distinct from 'portone'
     or v_order.payment_id is null
     or v_order.payment_id is distinct from
       pg_catalog.replace(v_order.order_uuid::text, '-', '')
     or v_order.is_test is distinct from p_is_test
     or v_order.pay_channel is distinct from p_pay_channel
     or v_order.expected_store_id is null
     or v_order.expected_currency is distinct from 'KRW'
     or v_order.expected_channel_key is null
     or (
       v_outcome = 'ready'
       and (
         v_order.amount is distinct from p_amount
         or v_order.credits is distinct from p_credits
         or v_order.status is distinct from 'pending'
         or v_order.expected_store_id is distinct from p_expected_store_id
         or v_order.expected_channel_key is distinct from
              p_expected_channel_key
       )
     )
     or v_order.paid_at is not null
     or v_order.canceled_at is not null then
    raise exception 'checkout_receipt_invalid' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', v_outcome,
    'order_uuid', v_order.order_uuid,
    'payment_id', v_order.payment_id,
    'user_id', v_order.user_id,
    'product_id', v_order.product_id,
    'amount', v_order.amount,
    'credits', v_order.credits,
    'status', v_order.status,
    'provider', v_order.provider,
    'is_test', v_order.is_test,
    'pay_channel', v_order.pay_channel,
    'expected_store_id', v_order.expected_store_id,
    'expected_currency', v_order.expected_currency,
    'expected_channel_key', v_order.expected_channel_key,
    'paid_at', v_order.paid_at,
    'canceled_at', v_order.canceled_at
  );
end;
$$;
revoke all on function public.create_or_reuse_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_reuse_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean,
  text, text, text
) to service_role;

-- A PortOne checkout receipt can already exist in an old browser while the
-- provider GET still returns 404 (requestPayment has not started yet). Such a
-- payment id remains charge-capable, so the generic administrative local
-- cancellation RPC must never release it for a second checkout. PortOne unpaid
-- terminalization is exclusively the provider-observed
-- mark_order_canceled_unpaid path; preserve the legacy behavior for every
-- non-PortOne provider.
create or replace function public.admin_cancel_order(
  p_admin uuid,
  p_order_uuid uuid,
  p_clawback boolean,
  p_reason text,
  p_pg_done boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_provider text;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id, o.provider
    into v_user_id, v_provider
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_provider = 'portone' then
    raise exception 'portone_cancellation_requires_provider_observation'
      using errcode = 'P0001';
  end if;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_cancel_order_impl(
    p_admin, p_order_uuid, p_clawback, p_reason, p_pg_done
  );
end;
$$;
revoke all on function public.admin_cancel_order(
  uuid, uuid, boolean, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.admin_cancel_order(
  uuid, uuid, boolean, text, boolean
) to service_role;

create or replace function public.admin_cancel_order(
  p_admin uuid,
  p_order_uuid uuid,
  p_clawback boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_provider text;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id, o.provider
    into v_user_id, v_provider
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_provider = 'portone' then
    raise exception 'portone_cancellation_requires_provider_observation'
      using errcode = 'P0001';
  end if;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_cancel_order_impl(
    p_admin, p_order_uuid, p_clawback, p_reason, false
  );
end;
$$;
revoke all on function public.admin_cancel_order(
  uuid, uuid, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_cancel_order(
  uuid, uuid, boolean, text
) to service_role;

-- Expand-only provider-evidence adoption. The caller must first perform a
-- fresh PortOne read and supply the exact immutable row identity plus the
-- provider tuple. This function cannot change financial/order state, cannot
-- overwrite a complete tuple, and is removed by 0092.
drop function if exists public.backfill_portone_order_payment_evidence(
  uuid, text, integer, boolean, text, text, text
);
drop function if exists public.backfill_portone_order_payment_evidence(
  uuid, text, integer, boolean, text, text, text, text
);
create or replace function public.backfill_portone_order_payment_evidence(
  p_order_uuid uuid,
  p_payment_id text,
  p_amount integer,
  p_is_test boolean,
  p_pay_channel text,
  p_expected_store_id text,
  p_expected_currency text,
  p_expected_channel_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_outcome text;
begin
  if p_order_uuid is null
     or pg_catalog.char_length(coalesce(p_payment_id, ''))
          not between 1 and 500
     or p_payment_id ~ '[[:cntrl:]]'
     or p_payment_id is distinct from
          pg_catalog.replace(p_order_uuid::text, '-', '')
     or p_amount is null
     or p_amount <= 0
     or p_is_test is null
     or (
       p_pay_channel is not null
       and p_pay_channel not in ('card', 'tosspay', 'kakaopay')
     )
     or pg_catalog.char_length(coalesce(p_expected_store_id, ''))
          not between 1 and 128
     or p_expected_store_id <> pg_catalog.btrim(p_expected_store_id)
     or p_expected_store_id ~ '[[:cntrl:]]'
     or p_expected_currency is distinct from 'KRW'
     or pg_catalog.char_length(coalesce(p_expected_channel_key, ''))
          not between 1 and 256
     or p_expected_channel_key <>
          pg_catalog.btrim(p_expected_channel_key)
     or p_expected_channel_key ~ '[[:cntrl:]]' then
    raise exception 'invalid_payment_evidence_snapshot'
      using errcode = 'P0001';
  end if;

  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  select *
    into v_order
    from public.orders o
   where o.order_uuid = p_order_uuid
   for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;
  if v_order.provider is distinct from 'portone'
     or v_order.payment_id is distinct from p_payment_id
     or v_order.amount is distinct from p_amount
     or v_order.is_test is distinct from p_is_test
     or v_order.pay_channel is distinct from p_pay_channel then
    raise exception 'payment_evidence_order_mismatch'
      using errcode = 'P0001';
  end if;

  if v_order.expected_store_id is null
     and v_order.expected_currency is null
     and v_order.expected_channel_key is null then
    update public.orders o
       set expected_store_id = p_expected_store_id,
           expected_currency = p_expected_currency,
           expected_channel_key = p_expected_channel_key
     where o.order_uuid = p_order_uuid
       and o.provider = 'portone'
       and o.payment_id = p_payment_id
       and o.amount = p_amount
       and o.is_test = p_is_test
       and o.pay_channel is not distinct from p_pay_channel
       and o.expected_store_id is null
       and o.expected_currency is null
       and o.expected_channel_key is null
     returning o.* into v_order;
    if not found then
      raise exception 'payment_evidence_backfill_lost'
        using errcode = 'P0001';
    end if;
    v_outcome := 'updated';
  elsif v_order.expected_store_id is not distinct from p_expected_store_id
     and v_order.expected_currency is not distinct from p_expected_currency
     and v_order.expected_channel_key is not distinct from
          p_expected_channel_key then
    v_outcome := 'already_exact';
  else
    raise exception 'payment_evidence_snapshot_conflict'
      using errcode = 'P0001';
  end if;

  if v_order.order_uuid is distinct from p_order_uuid
     or v_order.provider is distinct from 'portone'
     or v_order.payment_id is distinct from p_payment_id
     or v_order.payment_id is distinct from
          pg_catalog.replace(v_order.order_uuid::text, '-', '')
     or v_order.amount is distinct from p_amount
     or v_order.is_test is distinct from p_is_test
     or v_order.pay_channel is distinct from p_pay_channel
     or v_order.expected_store_id is distinct from p_expected_store_id
     or v_order.expected_currency is distinct from p_expected_currency
     or v_order.expected_channel_key is distinct from
          p_expected_channel_key then
    raise exception 'payment_evidence_backfill_postcondition_failed'
      using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', v_outcome,
    'order_uuid', v_order.order_uuid,
    'payment_id', v_order.payment_id,
    'amount', v_order.amount,
    'is_test', v_order.is_test,
    'pay_channel', v_order.pay_channel,
    'expected_store_id', v_order.expected_store_id,
    'expected_currency', v_order.expected_currency,
    'expected_channel_key', v_order.expected_channel_key
  );
end;
$$;
revoke all on function public.backfill_portone_order_payment_evidence(
  uuid, text, integer, boolean, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.backfill_portone_order_payment_evidence(
  uuid, text, integer, boolean, text, text, text, text
) to service_role;

-- Harden the single paid transition used by webhook, polling, reconcile,
-- cancellation finalization, and verified administrator settlement. The old
-- financial state machine remains isolated behind this evidence gate.
--
-- The production project predates migration-history bookkeeping, so an
-- operator may safely retry this file after a response loss. Rename exactly
-- once, prove the preserved financial core by its canonical body, and refuse
-- every partial or unexpected catalog shape.
do $$
declare
  v_old_oid oid := pg_catalog.to_regprocedure(
    'public.bp_0084_mark_paid_and_grant_impl(uuid,text,integer,jsonb,timestamptz,text)'
  );
  v_core_oid oid := pg_catalog.to_regprocedure(
    'public.bp_0087_mark_paid_and_grant_financial_impl(uuid,text,integer,jsonb,timestamptz,text)'
  );
begin
  if v_core_oid is null then
    if v_old_oid is null then
      raise exception
        '0087 paid gate: financial implementation is missing';
    end if;
    if (
      select pg_catalog.md5(p.prosrc)
        from pg_catalog.pg_proc p
       where p.oid = v_old_oid
    ) is distinct from 'f73607a779847ee5088e6e630768e1f8' then
      raise exception
        '0087 paid gate: pre-rename financial implementation drift';
    end if;
    execute $rename$
      alter function public.bp_0084_mark_paid_and_grant_impl(
        uuid, text, integer, jsonb, timestamptz, text
      ) rename to bp_0087_mark_paid_and_grant_financial_impl
    $rename$;
  elsif (
    select pg_catalog.md5(p.prosrc)
      from pg_catalog.pg_proc p
     where p.oid = v_core_oid
  ) is distinct from 'f73607a779847ee5088e6e630768e1f8' then
    raise exception
      '0087 paid gate: preserved financial implementation drift';
  end if;
end;
$$;
revoke all on function public.bp_0087_mark_paid_and_grant_financial_impl(
  uuid, text, integer, jsonb, timestamptz, text
) from public, anon, authenticated, service_role;

create or replace function public.bp_0084_mark_paid_and_grant_impl(
  p_order_uuid uuid,
  p_pg_tx_id text,
  p_price integer,
  p_raw jsonb,
  p_paid_at timestamptz,
  p_receipt_url text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_amount_text text;
  v_raw_paid_at timestamptz;
begin
  select *
    into v_order
    from public.orders o
   where o.order_uuid = p_order_uuid
   for update;
  if not found then
    return false;
  end if;
  -- A completed order cannot mutate again. Preserve the scalar false replay
  -- contract so delayed old webhook deliveries drain after 0092 instead of
  -- retrying forever solely because their historical snapshot is NULL.
  if v_order.paid_at is not null then
    return false;
  end if;
  if p_raw is null
     or pg_catalog.jsonb_typeof(p_raw) <> 'object' then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;
  v_amount_text := p_raw #>> '{amount,total}';
  begin
    v_raw_paid_at := nullif(p_raw->>'paidAt', '')::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end;
  -- Every paid transition proves the complete provider object, not merely
  -- caller-supplied scalar projections. This also protects the bounded legacy
  -- window from a client-tampered store/channel.
  if p_raw->>'id' is distinct from v_order.payment_id
     or coalesce(p_raw->>'status', '')
          not in ('PAID', 'PARTIAL_CANCELLED')
     or pg_catalog.char_length(coalesce(p_pg_tx_id, ''))
          not between 1 and 500
     or p_raw->>'transactionId' is distinct from p_pg_tx_id
     or p_paid_at is null
     or v_raw_paid_at is distinct from p_paid_at
     or v_amount_text is null
     or v_amount_text !~ '^(0|[1-9][0-9]*)$'
     or pg_catalog.char_length(v_amount_text) > 10
     or v_amount_text::bigint <> v_order.amount
     or p_price is distinct from v_order.amount
     or p_raw->>'currency' is distinct from 'KRW'
     or pg_catalog.char_length(coalesce(p_raw->>'storeId', ''))
          not between 1 and 128
     or p_raw->>'storeId' ~ '[[:cntrl:]]'
     or pg_catalog.char_length(
          coalesce(p_raw #>> '{channel,key}', '')
        ) not between 1 and 256
     or p_raw #>> '{channel,key}' ~ '[[:cntrl:]]'
     or p_raw #>> '{channel,type}' is distinct from
          (
            case when v_order.is_test then 'TEST' else 'LIVE' end
          ) then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;
  -- A historical all-NULL row cannot prove which immutable provider namespace
  -- reached the browser. Even during expand it must be adopted by the bounded,
  -- provider-backed backfill before any money transition. Old webhook/poll
  -- retries remain safe and eventually succeed after exact adoption.
  if v_order.expected_store_id is null
     and v_order.expected_currency is null
     and v_order.expected_channel_key is null then
    raise exception 'payment_evidence_incomplete' using errcode = 'P0001';
  end if;
  if v_order.expected_store_id is null
     or v_order.expected_currency is null
     or v_order.expected_channel_key is null
     or p_raw->>'storeId' is distinct from v_order.expected_store_id
     or p_raw->>'currency' is distinct from v_order.expected_currency
     or p_raw #>> '{channel,key}' is distinct from
          v_order.expected_channel_key then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;
  return public.bp_0087_mark_paid_and_grant_financial_impl(
    p_order_uuid,
    p_pg_tx_id,
    p_price,
    p_raw,
    p_paid_at,
    p_receipt_url
  );
end;
$$;
revoke all on function public.bp_0084_mark_paid_and_grant_impl(
  uuid, text, integer, jsonb, timestamptz, text
) from public, anon, authenticated, service_role;

-- Badge-catalog edits must never treat PostgREST's row cap or a partial read as
-- "zero historical impact". Aggregate the complete authority set in
-- PostgreSQL and expose only one row per persisted badge slug.
create or replace function public.get_admin_badge_impact()
returns table(
  badge_id text,
  users bigint,
  scores bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with user_counts as (
    select
      ub.badge_id,
      pg_catalog.count(distinct ub.owner_id)::bigint as users
    from public.user_badges ub
    group by ub.badge_id
  ),
  score_counts as (
    select
      badge.badge_id,
      pg_catalog.count(distinct ss.score_id)::bigint as scores
    from public.score_stats ss
    cross join lateral pg_catalog.unnest(
      coalesce(ss.badge_ids, array[]::text[])
    ) badge(badge_id)
    group by badge.badge_id
  ),
  badge_ids as (
    select uc.badge_id from user_counts uc
    union
    select sc.badge_id from score_counts sc
  )
  select
    ids.badge_id,
    coalesce(uc.users, 0::bigint)::bigint as users,
    coalesce(sc.scores, 0::bigint)::bigint as scores
  from badge_ids ids
  left join user_counts uc on uc.badge_id = ids.badge_id
  left join score_counts sc on sc.badge_id = ids.badge_id
  order by ids.badge_id;
$$;
revoke all on function public.get_admin_badge_impact()
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_badge_impact()
  to service_role;

-- Classify only namespaces generated by the four browser signed-upload
-- surfaces that existed before 0079. Returning NULL for every other Storage
-- path is the hard deletion boundary for the finite rollout inventory scan.
create or replace function public.bp_legacy_signed_upload_purpose(
  p_bucket text,
  p_path text
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  if p_bucket = 'site-assets'
     and p_path ~ (
       '^og/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$'
     ) then
    return 'site_asset_og';
  elsif p_bucket = 'site-assets'
     and p_path ~ (
       '^logo/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$'
     ) then
    return 'site_asset_logo';
  elsif p_bucket = 'events'
     and p_path ~ (
       '^[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp|gif)$'
     ) then
    return 'event_image';
  elsif p_bucket = 'avatars'
     and p_path ~ (
       '^' || v_uuid_pattern || '/' || v_uuid_pattern ||
       '\.(png|jpg|webp)$'
     ) then
    return 'avatar_upload';
  elsif p_bucket = 'highlights'
     and p_path ~ (
       '^' || v_uuid_pattern || '/' || v_uuid_pattern ||
       '\.(mp4|webm)$'
     ) then
    return 'highlight_upload';
  end if;
  return null;
end;
$$;
revoke all on function public.bp_legacy_signed_upload_purpose(text, text)
  from public, anon, authenticated, service_role;

-- Convert objects that fell through the old-token -> intent-adoption DB outage
-- gap into the existing fenced upload cleanup saga. The scanner is disabled
-- until 0092, bounded to the rollout token window, and waits an additional ten
-- minutes beyond the route's 2h05 attach deadline. A path advisory lock shared
-- with every attach trigger gives the two legal orderings:
--   reference first -> protection; cleanup receipt first -> attach rejected.
create or replace function public.enqueue_legacy_signed_upload_orphans(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.storage_legacy_upload_sweep_control%rowtype;
  v_object record;
  v_object_created_at timestamptz;
  v_purpose text;
  v_owner_id uuid;
  v_subject_id uuid;
  v_intent_id uuid;
  v_examined integer := 0;
  v_enqueued integer := 0;
  v_protected integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 100));
  v_sentinel_owner uuid := '00000000-0000-4000-8000-000000000000'::uuid;
begin
  select *
    into v_control
    from public.storage_legacy_upload_sweep_control
   where singleton = true;
  if not found
     or v_control.enabled_at is null
     or v_control.window_ends_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'enabled', false,
      'examined', 0,
      'enqueued', 0,
      'protected', 0
    );
  end if;

  for v_object in
    select
      o.id,
      o.bucket_id as bucket,
      o.name as path,
      o.created_at
    from storage.objects o
   where o.bucket_id in (
           'site-assets', 'events', 'avatars', 'highlights'
         )
     and o.created_at is not null
     and o.created_at >= v_control.inventory_floor_at
     and o.created_at <= v_control.window_ends_at
     and o.created_at <=
       clock_timestamp() - interval '2 hours 15 minutes'
     and public.bp_legacy_signed_upload_purpose(
           o.bucket_id, o.name
         ) is not null
     and not exists (
       select 1
         from public.storage_upload_intents i
        where i.bucket = o.bucket_id
          and i.path = o.name
     )
     and not exists (
       select 1
         from public.storage_legacy_upload_protections p
        where p.bucket = o.bucket_id
          and p.path = o.name
     )
   order by o.created_at, o.id
   limit v_limit
  loop
    v_examined := v_examined + 1;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'storage-path:' || v_object.bucket || ':' || v_object.path,
        0
      )
    );

    -- Re-read every authority predicate after the path lock. The candidate
    -- query is only a bounded index probe, never deletion authority.
    select o.created_at
      into v_object_created_at
      from storage.objects o
     where o.id = v_object.id
       and o.bucket_id = v_object.bucket
       and o.name = v_object.path;
    if not found
       or v_object_created_at < v_control.inventory_floor_at
       or v_object_created_at > v_control.window_ends_at
       or v_object_created_at >
         clock_timestamp() - interval '2 hours 15 minutes'
       or exists (
         select 1
           from public.storage_upload_intents i
          where i.bucket = v_object.bucket
            and i.path = v_object.path
       )
       or exists (
         select 1
           from public.storage_legacy_upload_protections p
          where p.bucket = v_object.bucket
            and p.path = v_object.path
       ) then
      continue;
    end if;

    if public.bp_storage_path_is_referenced(
         v_object.bucket, v_object.path
       ) then
      insert into public.storage_legacy_upload_protections(
        bucket, path, reason
      )
      values (
        v_object.bucket,
        v_object.path,
        'scanner_reference_guard'
      )
      on conflict (bucket, path) do nothing;
      if found then
        v_protected := v_protected + 1;
      end if;
      continue;
    end if;

    v_purpose := public.bp_legacy_signed_upload_purpose(
      v_object.bucket, v_object.path
    );
    v_owner_id := v_sentinel_owner;
    v_subject_id := null;
    if v_purpose = 'avatar_upload' then
      v_owner_id := pg_catalog.split_part(v_object.path, '/', 1)::uuid;
    elsif v_purpose = 'highlight_upload' then
      v_subject_id := pg_catalog.split_part(v_object.path, '/', 1)::uuid;
      select s.owner_id
        into v_owner_id
        from public.scores s
       where s.id = v_subject_id;
      if not found then
        v_owner_id := v_sentinel_owner;
      end if;
    end if;

    insert into public.storage_upload_intents(
      owner_user_id,
      subject_id,
      purpose,
      bucket,
      path,
      status,
      expires_at,
      cleanup_after,
      next_attempt_at,
      last_error,
      created_at,
      updated_at
    )
    values (
      v_owner_id,
      v_subject_id,
      v_purpose,
      v_object.bucket,
      v_object.path,
      'pending',
      v_object_created_at + interval '2 hours 5 minutes',
      clock_timestamp(),
      clock_timestamp(),
      'legacy_upload_missing_intent',
      v_object_created_at,
      clock_timestamp()
    )
    on conflict (bucket, path) do nothing
    returning id into v_intent_id;
    if v_intent_id is not null then
      v_enqueued := v_enqueued + 1;
    end if;
    v_intent_id := null;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'enabled', true,
    'examined', v_examined,
    'enqueued', v_enqueued,
    'protected', v_protected
  );
end;
$$;
revoke all on function public.enqueue_legacy_signed_upload_orphans(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_legacy_signed_upload_orphans(integer)
  to service_role;

-- Cancel intent is a financial write spanning an external PG observation.
-- Make the set-once intent an exact replay and let an ambiguous
-- cancel_intent_resolve response recover its active request/attempt receipt.
-- These are the existing 0084 object→user lock wrappers; only the code after
-- both locks is extended, and the private mutation cores remain isolated.
create or replace function public.cancel_intent_begin(
  p_admin uuid,
  p_order_uuid uuid,
  p_customer_requested_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_order public.orders;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock(
      'order',
      p_order_uuid::text
    );
  end if;
  select o.user_id
    into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;

  select *
    into v_order
    from public.orders o
   where o.order_uuid = p_order_uuid
   for update;
  if found and v_order.cancel_intent_created_at is not null then
    if v_order.cancel_requested_at is not distinct from
         p_customer_requested_at
       and v_order.cancel_intent_reason is not distinct from p_reason then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true,
        'order_version', v_order.version
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;

  return public.bp_0084_cancel_intent_begin_impl(
    p_admin,
    p_order_uuid,
    p_customer_requested_at,
    p_reason
  );
end;
$$;
revoke all on function public.cancel_intent_begin(
  uuid, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.cancel_intent_begin(
  uuid, uuid, timestamptz, text
) to service_role;

create or replace function public.cancel_intent_resolve(
  p_admin uuid,
  p_order_uuid uuid,
  p_qty integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_request_id uuid;
  v_attempt_id uuid;
  v_requested_qty integer;
  v_request_state text;
  v_request_amount bigint;
  v_attempt_qty integer;
  v_attempt_amount bigint;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock(
      'order',
      p_order_uuid::text
    );
  end if;
  select o.user_id
    into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;

  select
    r.id,
    r.requested_qty,
    r.state,
    r.approved_amount,
    a.id,
    a.qty,
    a.amount
  into
    v_request_id,
    v_requested_qty,
    v_request_state,
    v_request_amount,
    v_attempt_id,
    v_attempt_qty,
    v_attempt_amount
  from public.refund_requests r
  left join public.order_refund_attempts a
    on a.request_id = r.id
   and a.sequence = 1
  where r.origin = 'cancel_intent'
    and r.scope_order_uuid = p_order_uuid
    and r.state in (
      'building',
      'prepared',
      'processing',
      'blocked'
    )
  order by r.created_at desc, r.id desc
  limit 1;

  if v_request_id is not null then
    if v_requested_qty <> p_qty then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    if v_request_state = 'building'
       or v_attempt_id is null
       or v_attempt_qty <> v_requested_qty
       or v_attempt_amount is null
       or v_attempt_amount <= 0
       or v_request_amount is distinct from v_attempt_amount then
      raise exception 'cancel_intent_receipt_invalid'
        using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'no_op',
      'idempotent', true,
      'request_id', v_request_id,
      'attempt_id', v_attempt_id,
      'qty', v_attempt_qty,
      'amount', v_attempt_amount
    );
  end if;

  return public.bp_0084_cancel_intent_resolve_impl(
    p_admin,
    p_order_uuid,
    p_qty
  );
end;
$$;
revoke all on function public.cancel_intent_resolve(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.cancel_intent_resolve(
  uuid, uuid, integer
) to service_role;

-- A terminal "released" state can be reached by three different administrator
-- actions. The 0062 implementations returned no_op for all of them, allowing
-- a replay of a different action to masquerade as the requested one. Harden
-- the private 0084 implementations while retaining their public lock wrappers.
create or replace function public.bp_0084_admin_refund_release_impl(
  p_attempt_id uuid,
  p_admin uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.order_refund_attempts;
begin
  select *
    into a
    from public.order_refund_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'attempt_not_found' using errcode = 'P0001';
  end if;
  if a.state = 'released' then
    if a.release_reason = 'admin_cancelled_before_pg' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state <> 'prepared' then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if char_length(p_reason) < 5
     or char_length(p_reason) > 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;

  perform public.bp_apply_attempt_release(
    p_attempt_id,
    p_admin,
    p_reason,
    'admin_cancelled_before_pg',
    true
  );
  update public.refund_requests
     set state = public.derive_refund_request_state(a.request_id)
   where id = a.request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'released',
    'attempt_id', p_attempt_id
  );
end;
$$;
revoke all on function public.bp_0084_admin_refund_release_impl(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.bp_0084_admin_refund_replan_pre_pg_impl(
  p_attempt_id uuid,
  p_admin uuid,
  p_reason text,
  p_external boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.order_refund_attempts;
  v_reason text;
begin
  v_reason := case
    when p_external then 'replanned_before_pg_external'
    else 'replanned_before_pg'
  end;
  select *
    into a
    from public.order_refund_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'attempt_not_found' using errcode = 'P0001';
  end if;
  if a.state = 'released' then
    if a.release_reason = v_reason then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state not in ('prepared', 'manual_review')
     or a.pg_requested_at is not null then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if char_length(p_reason) < 5
     or char_length(p_reason) > 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;

  perform public.bp_apply_attempt_release(
    p_attempt_id,
    p_admin,
    p_reason,
    v_reason,
    false
  );
  insert into public.admin_actions_ledger
    (
      admin_user_id,
      action_type,
      target_user_id,
      order_uuid,
      credit_delta,
      order_amount,
      before_credits,
      after_credits,
      reason,
      metadata,
      ref_attempt_id,
      payload_hash,
      payload_hash_version
    )
  select
    p_admin,
    'refund_replan',
    a.user_id,
    a.order_uuid,
    0,
    a.amount,
    ma.gen_credits,
    ma.gen_credits,
    p_reason,
    pg_catalog.jsonb_build_object(
      'phase', 'pre_pg',
      'release_reason', v_reason
    ),
    p_attempt_id,
    public.bp_versioned_hash(
      pg_catalog.jsonb_build_object(
        'attempt_id', p_attempt_id::text,
        'phase', 'pre_pg'
      ),
      1
    ),
    1
  from public.member_accounts ma
  where ma.user_id = a.user_id;

  update public.refund_requests
     set state = public.derive_refund_request_state(a.request_id)
   where id = a.request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'released',
    'release_reason', v_reason
  );
end;
$$;
revoke all on function public.bp_0084_admin_refund_replan_pre_pg_impl(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.bp_0084_admin_refund_replan_after_pg_impl(
  p_attempt_id uuid,
  p_admin uuid,
  p_reason text,
  p_observed_cancelled_amount bigint,
  p_observed_cancellation_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.order_refund_attempts;
  v_evhash text;
begin
  select *
    into a
    from public.order_refund_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'attempt_not_found' using errcode = 'P0001';
  end if;
  if a.state = 'released' then
    if a.release_reason = 'replanned_after_pg_reconciliation' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state <> 'manual_review'
     or a.pg_requested_at is null then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if char_length(p_reason) < 5
     or char_length(p_reason) > 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;

  v_evhash := public.bp_versioned_hash(
    pg_catalog.jsonb_build_object(
      'attempt_id', p_attempt_id::text,
      'observed_cancelled_amount', p_observed_cancelled_amount,
      'observed_cancellation_ids', p_observed_cancellation_ids,
      'op', 'replan_after_pg'
    ),
    1
  );
  update public.order_refund_attempts
     set reconciliation_verified_at = clock_timestamp(),
         reconciliation_result = 'no_movement',
         observed_cancelled_amount = p_observed_cancelled_amount,
         observed_cancellation_ids = coalesce(
           p_observed_cancellation_ids,
           '[]'::jsonb
         ),
         verification_source = 'admin_reconcile',
         verified_by = p_admin,
         evidence_hash = v_evhash,
         evidence_hash_version = 1,
         last_reconciled_at = clock_timestamp()
   where id = p_attempt_id;

  update public.payment_cancellation_events
     set resolution_state = 'ignored',
         resolved_at = now(),
         resolution_source = 'system',
         resolved_by = null
   where order_uuid = a.order_uuid
     and status = 'FAILED'
     and resolution_state = 'unmatched';

  perform public.bp_apply_attempt_release(
    p_attempt_id,
    p_admin,
    p_reason,
    'replanned_after_pg_reconciliation',
    false
  );

  insert into public.admin_actions_ledger
    (
      admin_user_id,
      action_type,
      target_user_id,
      order_uuid,
      credit_delta,
      order_amount,
      before_credits,
      after_credits,
      reason,
      metadata,
      ref_attempt_id,
      payload_hash,
      payload_hash_version
    )
  select
    p_admin,
    'refund_replan',
    a.user_id,
    a.order_uuid,
    0,
    a.amount,
    ma.gen_credits,
    ma.gen_credits,
    p_reason,
    pg_catalog.jsonb_build_object(
      'phase', 'post_pg',
      'evidence_hash', v_evhash
    ),
    p_attempt_id,
    public.bp_versioned_hash(
      pg_catalog.jsonb_build_object(
        'attempt_id', p_attempt_id::text,
        'phase', 'post_pg'
      ),
      1
    ),
    1
  from public.member_accounts ma
  where ma.user_id = a.user_id;

  update public.refund_requests
     set state = public.derive_refund_request_state(a.request_id)
   where id = a.request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'released',
    'release_reason', 'replanned_after_pg_reconciliation'
  );
end;
$$;
revoke all on function public.bp_0084_admin_refund_replan_after_pg_impl(
  uuid, uuid, text, bigint, jsonb
) from public, anon, authenticated, service_role;

-- Financial terminal replays must be exact. The original 0062 implementation
-- compared `resolved_economic_qty = NULL`, which can never be true, so an
-- omitted economic quantity was not replayable after an ambiguous response.
-- Conversely, issue resolution returned no_op for a different terminal state.
-- Keep the public signatures stable during rollout while making both receipts
-- total and conflict-detecting.
create or replace function public.bp_0084_resolve_external_cancellation_impl(
  p_cancellation_id text,
  p_resolved_by uuid,
  p_note text,
  p_economic_qty int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev public.payment_cancellation_events;
  o public.orders;
  v_res jsonb;
  v_econ int;
begin
  select *
    into ev
    from public.payment_cancellation_events
   where cancellation_id = p_cancellation_id;
  if ev.cancellation_id is null then
    raise exception 'event_not_found' using errcode = 'P0001';
  end if;

  if ev.resolution_state = 'resolved' then
    if p_economic_qty is null
       or ev.resolved_economic_qty = p_economic_qty then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;

  select *
    into o
    from public.orders
   where order_uuid = ev.order_uuid;
  v_econ := coalesce(
    p_economic_qty,
    least(
      floor(ev.amount::numeric * o.credits / o.amount)::int,
      o.credits - o.refunded_credits
    )
  );

  v_res := public.bp_apply_external_resolution(
    p_cancellation_id,
    p_resolved_by,
    v_econ,
    null
  );

  if p_resolved_by is not null then
    if char_length(coalesce(p_note, '')) < 5
       or char_length(p_note) > 500 then
      raise exception 'note_invalid' using errcode = 'P0001';
    end if;
    insert into public.admin_actions_ledger
      (
        admin_user_id,
        action_type,
        target_user_id,
        order_uuid,
        credit_delta,
        order_amount,
        before_credits,
        after_credits,
        reason,
        metadata,
        ref_cancellation_id,
        payload_hash,
        payload_hash_version
      )
    select
      p_resolved_by,
      'resolve_external_cancellation',
      o.user_id,
      o.order_uuid,
      ma.gen_credits - (
        ma.gen_credits + (v_res->>'live_recovered')::int
      ),
      ev.amount,
      ma.gen_credits + (v_res->>'live_recovered')::int,
      ma.gen_credits,
      p_note,
      pg_catalog.jsonb_build_object(
        'economic_qty', v_econ,
        'recovered_qty', (v_res->>'immediate')::int,
        'shortfall_qty', (v_res->>'shortfall')::int,
        'note', p_note
      ),
      p_cancellation_id,
      public.bp_versioned_hash(
        pg_catalog.jsonb_build_object(
          'cancellation_id', p_cancellation_id,
          'economic_qty', v_econ
        ),
        1
      ),
      1
    from public.member_accounts ma
    where ma.user_id = o.user_id;
  end if;

  update public.reconciliation_issues i
     set state = 'resolved',
         resolved_at = now(),
         resolution_source = case
           when p_resolved_by is null then 'system'
           else 'admin'
         end,
         resolved_by = p_resolved_by,
         detail = coalesce(i.detail, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
             'resolution_note',
             'event_resolved:' || p_cancellation_id
           )
   where i.cancellation_id = p_cancellation_id
     and i.type = 'unmatched_cancellation'
     and i.state = 'open';

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'resolved',
    'result', v_res
  );
end;
$$;
revoke all on function public.bp_0084_resolve_external_cancellation_impl(
  text, uuid, text, int
) from public, anon, authenticated, service_role;

create or replace function public.bp_0084_admin_resolve_reconciliation_issue_impl(
  p_issue_id uuid,
  p_admin uuid,
  p_resolution text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.reconciliation_issues;
  ev public.payment_cancellation_events;
  v_order public.orders%rowtype;
begin
  if p_resolution not in ('resolved', 'ignored') then
    raise exception 'resolution_invalid' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_note, '')) < 5
     or char_length(p_note) > 500 then
    raise exception 'note_invalid' using errcode = 'P0001';
  end if;

  select *
    into i
    from public.reconciliation_issues
   where id = p_issue_id
   for update;
  if not found then
    raise exception 'issue_not_found' using errcode = 'P0001';
  end if;
  if i.state <> 'open' then
    if i.state = p_resolution then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;

  -- A late PAID without a grant is an economic liability, not an operator
  -- acknowledgement. It may only leave the queue after the complete credit
  -- quantity has been economically refunded. In particular, cancellation-less
  -- issues cannot be hidden with an "ignored" note.
  if i.type = 'late_paid' then
    if p_resolution = 'ignored' then
      raise exception 'economic_resolution_required' using errcode = 'P0001';
    end if;

    select *
      into v_order
      from public.orders
     where order_uuid = i.order_uuid
     for update;
    if not found
       or v_order.status <> 'paid'
       or v_order.paid_at is null
       or coalesce(v_order.refunded_credits, 0) < v_order.credits
       or coalesce(v_order.refunded_amount, 0) < v_order.amount then
      raise exception 'economic_resolution_required' using errcode = 'P0001';
    end if;
  end if;

  if i.cancellation_id is not null then
    select *
      into ev
      from public.payment_cancellation_events
     where cancellation_id = i.cancellation_id
     for update;
    if ev.cancellation_id is not null
       and ev.resolution_state = 'unmatched' then
      if p_resolution = 'ignored' then
        if ev.status <> 'FAILED' then
          raise exception 'event_requires_resolution'
            using errcode = 'P0001';
        end if;
        update public.payment_cancellation_events
           set resolution_state = 'ignored',
               resolved_at = now(),
               resolution_source = 'admin',
               resolved_by = p_admin
         where cancellation_id = i.cancellation_id;
      else
        raise exception 'event_still_unmatched' using errcode = 'P0001';
      end if;
    end if;
  end if;

  update public.reconciliation_issues
     set state = p_resolution,
         resolved_at = now(),
         resolved_by = p_admin,
         resolution_source = 'admin',
         detail = coalesce(i.detail, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
             'resolution_note',
             p_note
           )
   where id = p_issue_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', p_resolution
  );
end;
$$;
revoke all on function public.bp_0084_admin_resolve_reconciliation_issue_impl(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function public.recon_issues_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_economic_reopen boolean := false;
begin
  if public.jsonb_has_sensitive_key(new.detail) then
    raise exception 'recon_issues_pii_in_detail' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.id <> old.id
     or new.type <> old.type
     or new.order_uuid <> old.order_uuid
     or new.user_id <> old.user_id
     or new.cancellation_id is distinct from old.cancellation_id
     or new.created_at <> old.created_at then
    raise exception 'recon_issues_immutable_field' using errcode = 'P0001';
  end if;

  if old.type = 'late_paid'
     and old.state in ('resolved', 'ignored')
     and new.state = 'open'
     and new.resolved_at is null
     and new.resolved_by is null
     and new.resolution_source is null
     and new.detail->>'economic_reopen_reason' =
           'late_paid_refund_incomplete'
     and exists (
       select 1
         from public.orders o
        where o.order_uuid = old.order_uuid
          and (
            coalesce(o.refunded_credits, 0) < o.credits
            or coalesce(o.refunded_amount, 0) < o.amount
          )
     ) then
    v_economic_reopen := true;
  end if;

  if new.state <> old.state
     and not (
       (old.state = 'open' and new.state in ('resolved', 'ignored'))
       or v_economic_reopen
     ) then
    raise exception 'recon_issues_state_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.recon_issues_guard()
  from public, anon, authenticated, service_role;

-- Repair any row closed by the earlier acknowledgement-only implementation.
-- Keep the prior resolution in detail for audit, but restore the durable open
-- work item until the complete economic refund exists.
update public.reconciliation_issues i
   set state = 'open',
       resolved_at = null,
       resolved_by = null,
       resolution_source = null,
       detail = coalesce(i.detail, '{}'::jsonb)
         || pg_catalog.jsonb_build_object(
           'economic_reopen_reason',
           'late_paid_refund_incomplete',
           'economic_reopen_previous_state',
           i.state,
           'economic_reopen_previous_resolved_at',
           i.resolved_at,
           'economic_reopen_previous_resolved_by',
           i.resolved_by,
           'economic_reopen_previous_source',
           i.resolution_source
         )
  from public.orders o
 where i.type = 'late_paid'
   and i.state in ('resolved', 'ignored')
   and o.order_uuid = i.order_uuid
   and (
     coalesce(o.refunded_credits, 0) < o.credits
     or coalesce(o.refunded_amount, 0) < o.amount
   );

create or replace function public.record_unsettled_order_observation(
  p_order_uuid uuid,
  p_expected_status text,
  p_expected_error_message text,
  p_kind text,
  p_error_message text,
  p_pg_status text,
  p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders%rowtype;
begin
  select *
    into o
    from public.orders
   where order_uuid = p_order_uuid
   for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if o.status = 'paid' and o.paid_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'terminal'
    );
  end if;
  if o.status = 'canceled' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'terminal'
    );
  end if;

  if o.status not in ('pending', 'failed')
     or o.paid_at is not null
     or o.status is distinct from p_expected_status
     or o.error_message is distinct from p_expected_error_message then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'skipped'
    );
  end if;

  if p_kind = 'marker' then
    if p_error_message is null
       or char_length(p_error_message) < 1
       or char_length(p_error_message) > 500
       or p_pg_status is not null
       or p_raw is not null then
      raise exception 'observation_invalid' using errcode = 'P0001';
    end if;
    update public.orders
       set error_message = p_error_message
     where order_uuid = p_order_uuid;
  elsif p_kind = 'provider_state' then
    if p_error_message is not null
       or p_pg_status is null
       or char_length(p_pg_status) < 1
       or char_length(p_pg_status) > 64
       or pg_catalog.jsonb_typeof(p_raw) <> 'object'
       or p_raw->>'verified_status' is distinct from p_pg_status then
      raise exception 'observation_invalid' using errcode = 'P0001';
    end if;
    update public.orders
       set pg_status = p_pg_status,
           raw = p_raw
     where order_uuid = p_order_uuid;
  else
    raise exception 'observation_invalid' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'recorded'
  );
end;
$$;
revoke all on function public.record_unsettled_order_observation(
  uuid, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_unsettled_order_observation(
  uuid, text, text, text, text, text, jsonb
) to service_role;

-- The rolling old server cannot pass provider paidAt/channel evidence. During
-- the brief expand→deploy window it must fail closed instead of performing an
-- economically ambiguous settlement. Its existing receipt-aware wrapper can
-- still replay an already completed request before reaching this entry point.
create or replace function public.admin_settle_stuck_order(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bp_assert_active_admin(p_admin);
  raise exception 'client_refresh_required' using errcode = 'P0001';
end;
$$;
revoke all on function public.admin_settle_stuck_order(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_settle_stuck_order(
  uuid, uuid, text
) to service_role;

-- Verified stuck-order settlement. The previous settlement RPC stamped the
-- administrator's verification time and discarded provider paidAt/channel
-- evidence. That can move the seven-day refund boundary and can grant a live
-- order paid through a TEST channel. Keep the old entry point for rolling
-- servers, while the new server proves and persists exact provider evidence.
create or replace function public.bp_0087_admin_settle_stuck_order_verified_impl(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text,
  p_request_id uuid,
  p_paid_at timestamptz,
  p_pg_tx_id text,
  p_receipt_url text,
  p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_ledger public.admin_actions_ledger%rowtype;
  v_order public.orders%rowtype;
  v_before integer;
  v_after integer;
  v_delta integer;
  v_settled boolean;
  v_error text;
  v_raw_paid_at timestamptz;
  v_amount_text text;
begin
  perform public.bp_assert_active_admin(p_admin);
  if p_order_uuid is null
     or pg_catalog.char_length(coalesce(p_reason, ''))
          not between 5 and 500
     or p_paid_at is null
     or p_paid_at > pg_catalog.clock_timestamp() + interval '5 minutes'
     or pg_catalog.char_length(coalesce(p_pg_tx_id, ''))
          not between 1 and 500
     or p_raw is null
     or pg_catalog.jsonb_typeof(p_raw) <> 'object' then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid,
    'reason', p_reason
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin,
    p_request_id,
    'order_settle',
    p_order_uuid::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  select *
    into v_order
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;
  perform public.bp_user_mutation_lock(v_order.user_id);
  select *
    into v_order
    from public.orders o
   where o.order_uuid = p_order_uuid
   for update;

  select *
    into v_ledger
    from public.admin_actions_ledger l
   where l.order_uuid = p_order_uuid
     and l.action_type = 'settle_stuck'
   order by l.created_at, l.id
   limit 1;
  if found then
    if v_ledger.credit_delta not in (0, v_order.credits)
       or v_ledger.after_credits - v_ledger.before_credits
            <> v_ledger.credit_delta then
      raise exception 'settlement_ledger_invalid' using errcode = 'P0001';
    end if;
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'before', v_ledger.before_credits,
      'after', v_ledger.after_credits,
      'credits', v_ledger.credit_delta,
      'requestedCredits', v_order.credits,
      'quarantined', v_ledger.credit_delta = 0,
      'noOp', true,
      'idempotent', false
    );
  else
    if v_order.status not in ('pending', 'failed')
       or v_order.paid_at is not null
       or v_order.provider <> 'portone'
       or v_order.payment_id is null
       or v_order.amount <= 0
       or v_order.credits <= 0 then
      raise exception 'not_settleable' using errcode = 'P0001';
    end if;

    v_amount_text := p_raw #>> '{amount,total}';
    begin
      v_raw_paid_at := nullif(p_raw->>'paidAt', '')::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        raise exception 'invalid_payment_evidence' using errcode = 'P0001';
    end;
    if p_raw->>'id' is distinct from v_order.payment_id
       or p_raw->>'status' is distinct from 'PAID'
       or p_raw->>'transactionId' is distinct from p_pg_tx_id
       or v_raw_paid_at is distinct from p_paid_at
       or p_paid_at < v_order.created_at - interval '5 minutes'
       or v_amount_text is null
       or v_amount_text !~ '^(0|[1-9][0-9]*)$'
       or pg_catalog.char_length(v_amount_text) > 10
       or v_amount_text::bigint <> v_order.amount
       or p_raw->>'currency' is distinct from 'KRW'
       or pg_catalog.char_length(coalesce(p_raw->>'storeId', ''))
            not between 1 and 128
       or p_raw->>'storeId' ~ '[[:cntrl:]]'
       or pg_catalog.char_length(
            coalesce(p_raw #>> '{channel,key}', '')
          ) not between 1 and 256
       or p_raw #>> '{channel,key}' ~ '[[:cntrl:]]'
       or not (
         (
           v_order.expected_store_id is null
           and v_order.expected_currency is null
           and v_order.expected_channel_key is null
           and public.bp_rollout_compatibility_enabled(
             'legacy_checkout_reuse'
           )
           and p_raw #>> '{channel,type}' is not distinct from
                case when v_order.is_test then 'TEST' else 'LIVE' end
         )
         or (
           v_order.expected_store_id is not null
           and v_order.expected_currency is not null
           and v_order.expected_channel_key is not null
           and p_raw->>'storeId' is not distinct from
                v_order.expected_store_id
           and p_raw->>'currency' is not distinct from
                v_order.expected_currency
           and p_raw #>> '{channel,key}' is not distinct from
                v_order.expected_channel_key
           and (
             (
               v_order.is_test
               and p_raw #>> '{channel,type}' = 'TEST'
             )
             or (
               not v_order.is_test
               and p_raw #>> '{channel,type}' = 'LIVE'
             )
           )
         )
       ) then
      raise exception 'invalid_payment_evidence' using errcode = 'P0001';
    end if;

    select m.gen_credits
      into v_before
      from public.member_accounts m
     where m.user_id = v_order.user_id
     for update;
    if not found then
      raise exception 'member_not_found' using errcode = 'P0001';
    end if;

    v_settled := public.bp_0084_mark_paid_and_grant_impl(
      v_order.order_uuid,
      p_pg_tx_id,
      v_order.amount,
      p_raw,
      p_paid_at,
      p_receipt_url
    );
    if not coalesce(v_settled, false) then
      raise exception 'status_changed' using errcode = 'P0001';
    end if;

    select m.gen_credits
      into v_after
      from public.member_accounts m
     where m.user_id = v_order.user_id;
    select o.error_message
      into v_error
      from public.orders o
     where o.order_uuid = v_order.order_uuid;
    v_delta := coalesce(v_after, 0) - coalesce(v_before, 0);
    if v_delta not in (0, v_order.credits) then
      raise exception 'settlement_result_invalid' using errcode = 'P0001';
    end if;

    insert into public.admin_actions_ledger(
      admin_user_id,
      action_type,
      target_user_id,
      order_uuid,
      credit_delta,
      order_amount,
      before_credits,
      after_credits,
      reason,
      metadata
    )
    values (
      p_admin,
      'settle_stuck',
      v_order.user_id,
      v_order.order_uuid,
      v_delta,
      v_order.amount,
      v_before,
      v_after,
      p_reason,
      pg_catalog.jsonb_build_object(
        'requested_credits', v_order.credits,
        'quarantined', v_delta = 0,
        'order_error', v_error,
        'provider_paid_at', p_paid_at,
        'provider_transaction_id', p_pg_tx_id
      )
    );

    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'before', v_before,
      'after', v_after,
      'credits', v_delta,
      'requestedCredits', v_order.credits,
      'quarantined', v_delta = 0,
      'noOp', false,
      'idempotent', false
    );
  end if;

  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin,
    'order_settle',
    p_order_uuid::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.bp_0087_admin_settle_stuck_order_verified_impl(
  uuid, uuid, text, uuid, timestamptz, text, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.admin_settle_stuck_order_verified(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text,
  p_request_id uuid,
  p_paid_at timestamptz,
  p_pg_tx_id text,
  p_receipt_url text,
  p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_user_id uuid;
begin
  perform public.bp_assert_active_admin(p_admin);
  if p_order_uuid is null
     or pg_catalog.char_length(coalesce(p_reason, ''))
          not between 5 and 500 then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;
  v_payload := pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid,
    'reason', p_reason
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin,
    p_request_id,
    'order_settle',
    p_order_uuid::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  select o.user_id
    into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0087_admin_settle_stuck_order_verified_impl(
    p_admin,
    p_order_uuid,
    p_reason,
    p_request_id,
    p_paid_at,
    p_pg_tx_id,
    p_receipt_url,
    p_raw
  );
end;
$$;
revoke all on function public.admin_settle_stuck_order_verified(
  uuid, uuid, text, uuid, timestamptz, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.admin_settle_stuck_order_verified(
  uuid, uuid, text, uuid, timestamptz, text, text, jsonb
) to service_role;

do $$
declare
  v_table text;
  v_signature text;
  v_atomic_def text;
  v_object_pos integer;
  v_config_pos integer;
  v_user_pos integer;
  v_impl_pos integer;
  v_index_def text;
begin
  foreach v_table in array array[
    'admin_actions_ledger',
    'ai_generations',
    'analytics_events',
    'analytics_rollups',
    'app_settings',
    'app_settings_audit',
    'credit_ledger',
    'credit_lots',
    'dolls',
    'events',
    'legal_documents',
    'member_accounts',
    'order_refund_attempts',
    'orders',
    'profiles',
    'reconciliation_issues',
    'refund_requests',
    'reviewer_accounts',
    'score_flags',
    'score_highlights',
    'score_stats',
    'scores',
    'telemetry_rollups',
    'telemetry_sessions',
    'user_badges'
  ]
  loop
    if pg_catalog.to_regclass('public.' || v_table) is null
       or not pg_catalog.has_table_privilege(
         'service_role',
         'public.' || v_table,
         'SELECT'
       )
    then
      raise exception '0087 postflight: server read unavailable (%)', v_table;
    end if;
  end loop;

  select pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
           '[[:space:]]',
           '',
           'g'
         )
    into v_index_def
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
   where i.indrelid = 'public.orders'::regclass
     and idx.relname =
           'orders_one_unresolved_portone_intent_per_user_uidx'
     and i.indisunique
     and i.indisvalid
     and i.indisready;

  if not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.orders'::regclass
          and a.attname = 'expected_store_id'
          and not a.attisdropped
     )
     or not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.orders'::regclass
          and a.attname = 'expected_currency'
          and not a.attisdropped
     )
     or not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.orders'::regclass
          and a.attname = 'expected_channel_key'
          and not a.attisdropped
     )
     or not exists (
       select 1
         from pg_catalog.pg_constraint c
        where c.conrelid = 'public.orders'::regclass
          and c.conname = 'orders_payment_evidence_snapshot_check'
          and c.contype = 'c'
          and c.convalidated
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.orders'::regclass
          and t.tgname = 'trg_orders_payment_evidence_snapshot'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgtype = 19
          and t.tgfoid =
                'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
          and t.tgattr = (
            select pg_catalog.string_agg(
                     a.attnum::text,
                     ' '
                     order by a.attnum
                   )::pg_catalog.int2vector
              from pg_catalog.pg_attribute a
             where a.attrelid = 'public.orders'::regclass
               and a.attname in (
                 'expected_store_id',
                 'expected_currency',
                 'expected_channel_key'
               )
               and not a.attisdropped
          )
     )
     or not exists (
       select 1
         from pg_catalog.pg_proc p
        where p.oid =
                'public.bp_guard_order_payment_evidence_snapshot()'::regprocedure
          and p.prosecdef
          and p.proconfig = array['search_path=""']::text[]
          and pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) =
                '048f737fe9b3bea8393389935a1aa31e'
          and not pg_catalog.has_function_privilege(
            'public',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'anon',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
          and not pg_catalog.has_function_privilege(
            'service_role',
            'public.bp_guard_order_payment_evidence_snapshot()',
            'EXECUTE'
          )
     )
     or v_index_def is distinct from
          'createuniqueindexorders_one_unresolved_portone_intent_per_user_uidxonpublic.ordersusingbtree(user_id)where((provider=''portone''::text)and(status=any(array[''pending''::text,''failed''::text]))and(paid_atisnull)and(canceled_atisnull))'
     or pg_catalog.has_column_privilege(
       'service_role', 'public.orders', 'expected_store_id', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'service_role', 'public.orders', 'expected_currency', 'UPDATE'
     )
     or pg_catalog.has_column_privilege(
       'service_role', 'public.orders', 'expected_channel_key', 'UPDATE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_guard_order_payment_evidence_snapshot()',
       'EXECUTE'
     ) then
    raise exception '0087 postflight: payment evidence snapshot boundary drift';
  end if;

  if not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'id', 'INSERT'
     )
     or not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'owner_id', 'INSERT'
     )
     or not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'image_url', 'INSERT'
     )
     or not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'style_meta', 'INSERT'
     )
     or not pg_catalog.has_column_privilege(
       'service_role', 'public.dolls', 'role', 'INSERT'
     )
  then
    raise exception '0087 postflight: doll persistence surface missing';
  end if;

  if not pg_catalog.has_table_privilege(
       'service_role', 'public.score_stats', 'INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.user_badges', 'INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.content_reports', 'INSERT'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.reviewer_accounts', 'INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'authenticated', 'public.dolls', 'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.account_reactivation_jobs', 'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'anon', 'public.account_reactivation_jobs', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.account_reactivation_jobs', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.account_reactivation_legacy_repairs',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'anon',
       'public.account_reactivation_legacy_repairs',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.account_reactivation_legacy_repairs',
       'SELECT'
     )
  then
    raise exception '0087 postflight: rollout table ACL drift';
  end if;

  if pg_catalog.to_regprocedure(
       'public.get_admin_badge_impact()'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.get_admin_badge_impact()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.get_admin_badge_impact()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.get_admin_badge_impact()',
       'EXECUTE'
     )
  then
    raise exception '0087 postflight: badge impact read ACL drift';
  end if;

  foreach v_signature in array array[
    'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
    'public.admin_adjust_credits(uuid,uuid,integer,text)',
    'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid)',
    'public.admin_publish_legal(text,date,uuid)',
    'public.admin_unpublish_legal(text,uuid)',
    'public.admin_update_app_setting(text,jsonb,integer,uuid,text)',
    'public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid)',
    'public.admin_publish_event(uuid,uuid)',
    'public.admin_unpublish_event(uuid,uuid)',
    'public.admin_delete_event(uuid,uuid)',
    'public.admin_clear_score(uuid,uuid,text)',
    'public.admin_void_score(uuid,uuid,text)',
    'public.admin_ban_member(uuid,uuid,text)',
    'public.admin_unban_member(uuid,uuid,text)',
    'public.admin_takedown_doll(uuid,uuid,text)',
    'public.admin_dismiss_doll(uuid,uuid,text)',
    'public.admin_restore_doll(uuid,uuid,text)',
    'public.admin_begin_doll_purge(uuid,uuid,text)',
    'public.admin_reactivate_account(uuid,uuid,text,text)',
    'public.admin_settle_stuck_order(uuid,uuid,text)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or not pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
    then
      raise exception '0087 postflight: old-server RPC unavailable (%)',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.admin_begin_account_reactivation(uuid,uuid,text,text,timestamptz,uuid)',
    'public.admin_begin_account_reactivation(uuid,uuid,text,text,timestamptz,bigint,uuid)',
    'public.admin_complete_account_reactivation(uuid,uuid,uuid)',
    'public.claim_account_reactivation_job(uuid,uuid,uuid,integer)',
    'public.arm_account_reactivation_auth_fence(uuid,uuid,uuid,uuid,integer)',
    'public.finish_account_reactivation_job(uuid,uuid,uuid,uuid,integer,boolean,text)',
    'public.get_account_reactivation_status(uuid,uuid,uuid)',
    'public.get_pending_account_reactivation(uuid,uuid)',
    'public.get_account_reactivation_queue_health()',
    'public.request_account_reactivation_cancellation(uuid,uuid,uuid,text,timestamptz,bigint)',
    'public.claim_account_reactivation_legacy_repair(integer)',
    'public.arm_account_reactivation_legacy_repair_auth_fence(uuid,uuid,uuid,integer)',
    'public.finish_account_reactivation_legacy_repair(uuid,uuid,uuid,integer,boolean,text)',
    'public.get_account_reactivation_legacy_repair_status(uuid,uuid)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null
       or not pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated',
         pg_catalog.to_regprocedure(v_signature),
         'EXECUTE'
       ) then
      raise exception '0087 postflight: reactivation RPC ACL drift (%)',
        v_signature;
    end if;
  end loop;

  if pg_catalog.to_regprocedure(
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
     ) is not null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.to_regprocedure(
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
     ) is not null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.to_regprocedure(
       'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.admin_begin_doll_purge_idempotent(uuid,uuid,text,text,bigint,uuid)',
       'EXECUTE'
     )
     or pg_catalog.to_regprocedure(
       'public.get_moderation_purge_status(uuid,uuid,uuid)'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.get_moderation_purge_status(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.get_moderation_purge_status(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.get_moderation_purge_status(uuid,uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.to_regprocedure(
       'public.enqueue_legacy_signed_upload_orphans(integer)'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.enqueue_legacy_signed_upload_orphans(integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.enqueue_legacy_signed_upload_orphans(integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.enqueue_legacy_signed_upload_orphans(integer)',
       'EXECUTE'
     )
     or pg_catalog.to_regprocedure(
       'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception '0087 postflight: new-server mutation RPC ACL drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
         )
    into v_atomic_def;
  v_object_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_mutation_object_lock'
  );
  v_config_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_checkout_config_lock'
  );
  v_user_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_user_mutation_lock'
  );
  v_impl_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_0084_create_pending_order_impl'
  );
  if v_object_pos = 0
     or v_config_pos <= v_object_pos
     or v_user_pos <= v_config_pos
     or v_impl_pos <= v_user_pos
     or pg_catalog.strpos(
          v_atomic_def, 'o.status in (''pending'', ''failed'')'
        ) = 0
     or pg_catalog.strpos(v_atomic_def, 'limit 2') = 0
     or pg_catalog.strpos(
          v_atomic_def, 'checkout_reuse_ambiguous'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'checkout_reuse_required'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'checkout_upgrade_required'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'v_candidate.payment_id is distinct from p_payment_id'
        ) = 0
     or pg_catalog.strpos(v_atomic_def, 'o.product_id = p_product_id') <> 0
     or pg_catalog.strpos(v_atomic_def, 'o.amount = p_amount') <> 0
     or pg_catalog.strpos(v_atomic_def, 'o.credits = p_credits') <> 0
     or pg_catalog.strpos(v_atomic_def, 'interval ''10 minutes''') <> 0 then
    raise exception '0087 postflight: legacy checkout fence drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'::regprocedure
         )
    into v_atomic_def;
  v_object_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_mutation_object_lock'
  );
  v_config_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_checkout_config_lock'
  );
  v_user_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_user_mutation_lock'
  );
  v_impl_pos := pg_catalog.strpos(
    v_atomic_def, 'insert into public.orders'
  );
  if v_object_pos = 0
     or v_config_pos <= v_object_pos
     or v_user_pos <= v_config_pos
     or v_impl_pos <= v_user_pos
     or pg_catalog.strpos(
          v_atomic_def, 'legacy_checkout_refresh_required'
        ) = 0
     or pg_catalog.strpos(v_atomic_def, 'v_outcome := ''replayed''') = 0
     or pg_catalog.strpos(v_atomic_def, 'v_outcome := ''reused''') = 0
     or pg_catalog.strpos(v_atomic_def, 'limit 2') = 0
     or pg_catalog.strpos(
          v_atomic_def, 'v_candidate_count > 1'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'checkout_reuse_ambiguous'
        ) = 0
     or pg_catalog.strpos(v_atomic_def, 'for key share') = 0
     or pg_catalog.strpos(
          v_atomic_def, 'p_payment_id is distinct from'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'o.status in (''pending'', ''failed'')'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'checkout_prior_intent_unresolved'
        ) = 0
     or pg_catalog.strpos(v_atomic_def, 'o.amount = p_amount') <> 0
     or pg_catalog.strpos(v_atomic_def, 'o.credits = p_credits') <> 0
     or pg_catalog.strpos(v_atomic_def, 'interval ''10 minutes''') <> 0
     or pg_catalog.strpos(
          v_atomic_def,
          'expected_store_id,'
        ) = 0
     or pg_catalog.strpos(v_atomic_def, 'p_expected_store_id') = 0
     or pg_catalog.strpos(
          v_atomic_def,
          '''expected_channel_key'', v_order.expected_channel_key'
        ) = 0 then
    raise exception '0087 postflight: atomic checkout lock/predicate drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def, 'public.bp_mutation_object_lock'
     ) = 0
     or pg_catalog.strpos(v_atomic_def, 'for update') = 0
     or pg_catalog.strpos(
          v_atomic_def, 'v_order.payment_id is distinct from p_payment_id'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def,
          'pg_catalog.replace(p_order_uuid::text, ''-'', '''')'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def,
          'pg_catalog.replace(v_order.order_uuid::text, ''-'', '''')'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'v_order.amount is distinct from p_amount'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'v_order.is_test is distinct from p_is_test'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'v_order.pay_channel is distinct from p_pay_channel'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, 'o.pay_channel is not distinct from p_pay_channel'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def,
          'p_expected_store_id <> pg_catalog.btrim(p_expected_store_id)'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def,
          'v_order.expected_store_id is distinct from p_expected_store_id'
        ) = 0
     or pg_catalog.strpos(
          v_atomic_def, '''outcome'', v_outcome'
        ) = 0
     or pg_catalog.has_column_privilege(
          'service_role', 'public.orders', 'expected_store_id', 'UPDATE'
        )
     or pg_catalog.has_column_privilege(
          'service_role', 'public.orders', 'expected_currency', 'UPDATE'
        )
     or pg_catalog.has_column_privilege(
          'service_role', 'public.orders', 'expected_channel_key', 'UPDATE'
        ) then
    raise exception '0087 postflight: payment evidence backfill drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.bp_0084_mark_paid_and_grant_impl(uuid,text,integer,jsonb,timestamptz,text)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def,
       'v_order.expected_store_id is null'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'p_raw->>''storeId'' is distinct from v_order.expected_store_id'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'p_raw->>''currency'' is distinct from v_order.expected_currency'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'p_raw #>> ''{channel,key}'' is distinct from'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'payment_evidence_incomplete'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'public.bp_rollout_compatibility_enabled'
     ) <> 0
     or pg_catalog.strpos(
       v_atomic_def,
       'p_raw->>''id'' is distinct from v_order.payment_id'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'v_raw_paid_at is distinct from p_paid_at'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'v_amount_text::bigint <> v_order.amount'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'p_price is distinct from v_order.amount'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'case when v_order.is_test then ''TEST'' else ''LIVE'' end'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'public.bp_0087_mark_paid_and_grant_financial_impl'
     ) = 0
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_0087_mark_paid_and_grant_financial_impl(uuid,text,integer,jsonb,timestamptz,text)',
       'EXECUTE'
     ) then
    raise exception '0087 postflight: paid evidence gate drift';
  end if;

  if not public.bp_rollout_compatibility_enabled(
       'legacy_score_submission'
     )
     or not public.bp_rollout_compatibility_enabled(
       'legacy_generation_transition'
     )
     or not public.bp_rollout_compatibility_enabled(
       'legacy_checkout_reuse'
     )
     or not public.bp_rollout_compatibility_enabled(
       'legacy_account_reactivation'
     ) then
    raise exception '0087 postflight: rolling compatibility disabled too early';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_settle_stuck_order(uuid,uuid,text)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(v_atomic_def, 'client_refresh_required') = 0
     or pg_catalog.strpos(v_atomic_def, 'public.bp_assert_active_admin') = 0 then
    raise exception '0087 postflight: unsafe legacy settlement still enabled';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)'::regprocedure
         )
    into v_atomic_def;
  v_object_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_mutation_object_lock'
  );
  v_user_pos := pg_catalog.strpos(
    v_atomic_def, 'public.bp_user_mutation_lock'
  );
  v_impl_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_0087_admin_settle_stuck_order_verified_impl'
  );
  if v_object_pos = 0
     or v_user_pos <= v_object_pos
     or v_impl_pos <= v_user_pos then
    raise exception '0087 postflight: verified settlement lock drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.bp_0087_admin_settle_stuck_order_verified_impl(uuid,uuid,text,uuid,timestamptz,text,text,jsonb)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def, 'public.bp_0084_mark_paid_and_grant_impl'
     ) = 0 then
    raise exception '0087 postflight: verified settlement grant drift';
  end if;
  if pg_catalog.strpos(v_atomic_def, 'provider_paid_at') = 0 then
    raise exception '0087 postflight: verified settlement paid-at audit drift';
  end if;
  if pg_catalog.strpos(
       v_atomic_def, 'p_raw->>''storeId'' is not distinct from'
     ) = 0 then
    raise exception '0087 postflight: verified settlement store drift';
  end if;
  if pg_catalog.strpos(
       v_atomic_def, 'p_raw->>''currency'' is not distinct from'
     ) = 0 then
    raise exception '0087 postflight: verified settlement currency drift';
  end if;
  if pg_catalog.strpos(
       v_atomic_def,
       'p_raw #>> ''{channel,key}'' is not distinct from'
     ) = 0 then
    raise exception '0087 postflight: verified settlement channel drift';
  end if;
  if pg_catalog.strpos(
       v_atomic_def, 'v_raw_paid_at is distinct from p_paid_at'
     ) = 0 then
    raise exception '0087 postflight: verified settlement paid-at drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.bp_0084_resolve_external_cancellation_impl(text,uuid,text,integer)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(v_atomic_def, 'p_economic_qty is null') = 0
     or pg_catalog.strpos(v_atomic_def, 'ev.resolved_economic_qty = p_economic_qty') = 0 then
    raise exception '0087 postflight: external cancellation replay drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.bp_0084_admin_resolve_reconciliation_issue_impl(uuid,uuid,text,text)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(v_atomic_def, 'i.state = p_resolution') = 0
     or pg_catalog.strpos(v_atomic_def, 'request_conflict') = 0
     or pg_catalog.strpos(v_atomic_def, 'i.type = ''late_paid''') = 0
     or pg_catalog.strpos(v_atomic_def, 'economic_resolution_required') = 0
     or pg_catalog.strpos(v_atomic_def, 'v_order.refunded_credits') = 0
     or pg_catalog.strpos(v_atomic_def, 'v_order.refunded_amount') = 0
     or pg_catalog.strpos(v_atomic_def, 'v_order.amount') = 0 then
    raise exception '0087 postflight: issue resolution replay drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.recon_issues_guard()'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(v_atomic_def, 'v_economic_reopen') = 0
     or pg_catalog.strpos(v_atomic_def, 'late_paid_refund_incomplete') = 0
     or pg_catalog.strpos(v_atomic_def, 'o.refunded_credits') = 0
     or pg_catalog.strpos(v_atomic_def, 'o.refunded_amount') = 0 then
    raise exception '0087 postflight: late-paid issue reopen guard drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.record_unsettled_order_observation(uuid,text,text,text,text,text,jsonb)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(v_atomic_def, 'for update') = 0
     or pg_catalog.strpos(v_atomic_def, 'o.status is distinct from p_expected_status') = 0
     or pg_catalog.strpos(v_atomic_def, 'o.error_message is distinct from p_expected_error_message') = 0
     or pg_catalog.strpos(v_atomic_def, 'o.paid_at is not null') = 0 then
    raise exception '0087 postflight: order observation CAS drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.resolve_external_cancellation(text,uuid,text,integer)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def,
       'public.bp_mutation_object_lock'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'public.bp_user_mutation_lock'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'public.bp_0084_resolve_external_cancellation_impl'
     ) = 0 then
    raise exception '0087 postflight: external cancellation lock wrapper drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_resolve_reconciliation_issue(uuid,uuid,text,text)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def,
       'public.bp_mutation_object_lock'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'public.bp_user_mutation_lock'
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       'public.bp_0084_admin_resolve_reconciliation_issue_impl'
     ) = 0 then
    raise exception '0087 postflight: issue resolution lock wrapper drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_cancel_order(uuid,uuid,boolean,text,boolean)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def,
       'portone_cancellation_requires_provider_observation'
     ) = 0
     or pg_catalog.strpos(v_atomic_def, 'v_provider = ''portone''') = 0 then
    raise exception '0087 postflight: PortOne local cancellation fence drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_cancel_order(uuid,uuid,boolean,text)'::regprocedure
         )
    into v_atomic_def;
  if pg_catalog.strpos(
       v_atomic_def,
       'portone_cancellation_requires_provider_observation'
     ) = 0
     or pg_catalog.strpos(v_atomic_def, 'v_provider = ''portone''') = 0 then
    raise exception '0087 postflight: legacy PortOne cancellation fence drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.cancel_intent_begin(uuid,uuid,timestamptz,text)'::regprocedure
         )
    into v_atomic_def;
  v_object_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_mutation_object_lock'
  );
  v_user_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_user_mutation_lock'
  );
  v_impl_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_0084_cancel_intent_begin_impl'
  );
  if v_object_pos = 0
     or v_user_pos <= v_object_pos
     or v_impl_pos <= v_user_pos
     or v_atomic_def !~ (
          'v_order[.]cancel_requested_at[[:space:]]+is[[:space:]]+not'
          || '[[:space:]]+distinct[[:space:]]+from[[:space:]]+'
          || 'p_customer_requested_at'
        )
     or v_atomic_def !~ (
          'v_order[.]cancel_intent_reason[[:space:]]+is[[:space:]]+not'
          || '[[:space:]]+distinct[[:space:]]+from[[:space:]]+p_reason'
        )
     or pg_catalog.strpos(v_atomic_def, 'request_conflict') = 0 then
    raise exception '0087 postflight: cancel intent exact replay drift';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.cancel_intent_resolve(uuid,uuid,integer)'::regprocedure
         )
    into v_atomic_def;
  v_object_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_mutation_object_lock'
  );
  v_user_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_user_mutation_lock'
  );
  v_impl_pos := pg_catalog.strpos(
    v_atomic_def,
    'public.bp_0084_cancel_intent_resolve_impl'
  );
  if v_object_pos = 0
     or v_user_pos <= v_object_pos
     or v_impl_pos <= v_user_pos
     or pg_catalog.strpos(
       v_atomic_def,
       '''outcome'', ''no_op'''
     ) = 0
     or pg_catalog.strpos(
       v_atomic_def,
       '''attempt_id'', v_attempt_id'
     ) = 0
     or pg_catalog.strpos(v_atomic_def, 'request_conflict') = 0 then
    raise exception '0087 postflight: cancel resolve receipt recovery drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('008899_server_read_surface_rollout_gate', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
