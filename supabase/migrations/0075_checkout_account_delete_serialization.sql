-- 0075: checkout ↔ account-delete 직렬화 경계
--
-- 문제:
--   create_pending_order(0065)는 profiles.deleted_at을 잠금 없이 읽었다. checkout이 이 검사를
--   통과한 직후 admin_soft_delete_account(0072)가 commit하면, stale checkout이 탈퇴 완료 뒤
--   pending 주문을 만들 수 있었다. 앱 경로 밖 service-role 직접 INSERT에도 동일 backstop이 없었다.
--
-- 수정:
--   1) create_pending_order가 profiles를 FOR KEY SHARE로 먼저 잠그고 deleted_at을 재검사한다.
--      0072 admin_soft_delete_account의 profiles FOR UPDATE와 충돌하므로 checkout-first/delete-first
--      양 방향이 직렬화된다.
--   2) 별도 BEFORE INSERT trigger가 future/direct orders INSERT에도 같은 경계를 강제한다.
--
-- 보존:
--   0065의 growth_levers active-product 정본, provider/channel/payment-id 검증, payment_id 멱등,
--   amount/credits snapshot 및 service_role-only ACL은 그대로다. 0062 orders_insert_guard의
--   pending/zero-financial 불변식 본문과 trigger는 수정하지 않는다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
declare
  v_create_def text;
  v_delete_def text;
begin
  if to_regprocedure(
       'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
     ) is null then
    raise exception '0075 preflight: create_pending_order missing';
  end if;
  if to_regprocedure('public.admin_soft_delete_account(uuid)') is null then
    raise exception '0075 preflight: admin_soft_delete_account missing';
  end if;
  if to_regclass('public.account_deletion_cleanup_jobs') is null then
    raise exception '0075 preflight: 0072 account deletion outbox missing';
  end if;
  if to_regprocedure('public.orders_insert_guard()') is null then
    raise exception '0075 preflight: orders_insert_guard missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
         )
    into v_create_def;
  if pg_catalog.strpos(v_create_def, 'public.app_settings') = 0 then
    raise exception '0075 preflight: 0065 config-backed create_pending_order missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_soft_delete_account(uuid)'::regprocedure
         )
    into v_delete_def;
  if pg_catalog.strpos(pg_catalog.lower(v_delete_def), 'into v_profile') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_delete_def), 'from public.profiles') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_delete_def), 'for update') = 0 then
    raise exception '0075 preflight: 0072 profile serialization lock missing';
  end if;

  -- If a same-price/different-credit pending snapshot already exists, the old
  -- server's app-side SELECT can expose it without invoking the RPC below.
  -- Refuse rollout until that bounded ten-minute window drains.
  if exists (
    select 1
      from public.orders o
      join public.app_settings s on s.key = 'growth_levers'
      cross join lateral pg_catalog.jsonb_array_elements(
        coalesce(s.value->'products', '[]'::jsonb)
      ) elem
     where o.status = 'pending'
       and o.provider = 'portone'
       and o.payment_id is not null
       and o.paid_at is null
       and o.canceled_at is null
       and o.created_at >=
         pg_catalog.transaction_timestamp() - interval '10 minutes'
       and elem->>'productId' = o.product_id
       and coalesce((elem->>'active')::boolean, false)
       and (elem->>'price')::integer = o.amount
       and (elem->>'credits')::integer <> o.credits
  ) then
    raise exception
      '0075 preflight: legacy checkout credit-mismatch window must drain';
  end if;
end;
$$;

-- Serialize every app_settings statement before PostgreSQL takes row locks.
-- Checkout takes the same advisory class before reading growth_levers. A
-- statement-level trigger is intentional: a row-level BEFORE trigger would run
-- after the config row lock and could deadlock with checkout holding this lock
-- while waiting to read that row.
create or replace function public.bp_checkout_config_lock()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'boss-paegi:checkout-config:growth_levers',
      0::bigint
    )
  );
end;
$$;
revoke all on function public.bp_checkout_config_lock()
  from public, anon, authenticated, service_role;

create or replace function public.bp_checkout_user_lock(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || p_user_id::text)::bigint
  );
end;
$$;
revoke all on function public.bp_checkout_user_lock(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_lock_app_settings_for_checkout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bp_checkout_config_lock();
  return null;
end;
$$;
revoke all on function public.bp_lock_app_settings_for_checkout()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_app_settings_checkout_config_lock
  on public.app_settings;
create trigger trg_app_settings_checkout_config_lock
  before insert or update or delete on public.app_settings
  for each statement
  execute function public.bp_lock_app_settings_for_checkout();

-- 0065 최종 본문을 보존하고 profile lock/not-found/deleted 검사만 강화한다.
create or replace function public.create_pending_order(
  p_user uuid, p_order_uuid uuid, p_product_id text, p_amount integer, p_credits integer,
  p_payment_id text, p_provider text, p_pay_channel text, p_is_test boolean)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_amt int;
  v_cr int;
  v_deleted_at timestamptz;
  v_existing public.orders;
begin
  if p_user is null then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  perform public.bp_checkout_config_lock();
  -- 0074가 확립한 전역 member namespace를 0084 이전 rollout 구간부터
  -- 획득한다. 0084 wrapper가 같은 lock을 object→user 순서로 재획득하는
  -- 것은 transaction advisory lock의 의도된 reentrant 사용이다.
  perform public.bp_checkout_user_lock(p_user);

  -- 가격/개수 정본 = app_settings.growth_levers 의 active 상품(어드민 전용 config, 서버 권위).
  --   클라는 productId 만 보내고 금액은 서버가 config 로 결정(§18) — 하드코딩 제거로 config 와 드리프트 불가.
  select (elem->>'price')::int, (elem->>'credits')::int
    into v_amt, v_cr
  from public.app_settings s
       cross join lateral pg_catalog.jsonb_array_elements(s.value->'products') as elem
  where s.key = 'growth_levers'
    and elem->>'productId' = p_product_id
    and coalesce((elem->>'active')::boolean, false) = true;
  if v_amt is null then raise exception 'invalid_product' using errcode = 'P0001'; end if;
  if p_amount <> v_amt or p_credits <> v_cr then raise exception 'product_amount_mismatch' using errcode = 'P0001'; end if;
  if p_provider <> 'portone' then raise exception 'invalid_provider' using errcode = 'P0001'; end if;
  if p_pay_channel not in ('card', 'tosspay', 'kakaopay') then raise exception 'invalid_channel' using errcode = 'P0001'; end if;
  if p_payment_id <> pg_catalog.replace(p_order_uuid::text, '-', '') then
    raise exception 'payment_id_format' using errcode = 'P0001';
  end if;

  -- 잠금 순서의 정본: profiles → orders. account delete는 profiles FOR UPDATE를 먼저 잡는다.
  -- checkout-first: delete가 기다린 뒤 pending을 보고 payment_pending으로 rollback.
  -- delete-first: checkout이 기다린 뒤 committed deleted_at을 보고 account_deleted로 중단.
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

  -- 멱등: 동일 payment_id 재호출은 전체 pending snapshot이 정확히 같을 때만 반환.
  select * into v_existing from public.orders where payment_id = p_payment_id;
  if v_existing.order_uuid is not null then
    if v_existing.order_uuid <> p_order_uuid
       or v_existing.user_id <> p_user
       or v_existing.product_id <> p_product_id
       or v_existing.amount <> p_amount
       or v_existing.credits <> p_credits
       or v_existing.status <> 'pending'
       or v_existing.provider <> p_provider
       or v_existing.is_test <> coalesce(p_is_test, false)
       or v_existing.pay_channel is distinct from p_pay_channel
       or v_existing.paid_at is not null
       or v_existing.canceled_at is not null then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return v_existing.order_uuid;
  end if;

  -- 구 서버는 이 RPC 앞에서 별도 SELECT를 수행한다. 서로 다른 candidate
  -- UUID를 만든 동시 요청은 그 SELECT를 함께 통과할 수 있으므로, 전역 user
  -- lock 안에서 전체 금융 snapshot을 다시 확인한다. 구 서버는 RPC 반환 UUID를
  -- 무시하므로 다른 UUID를 반환하지 않고 안전하게 실패시킨다. 새 서버의
  -- create_or_reuse_pending_order는 이 신호를 잡아 정확한 기존 receipt를 반환한다.
  select *
    into v_existing
    from public.orders o
   where o.user_id = p_user
     and o.product_id = p_product_id
     and o.status = 'pending'
     and o.provider = p_provider
     and o.amount = p_amount
     and o.credits = p_credits
     and o.is_test = coalesce(p_is_test, false)
     and o.pay_channel is not distinct from p_pay_channel
     and o.payment_id is not null
     and o.paid_at is null
     and o.canceled_at is null
     and o.created_at >=
       pg_catalog.transaction_timestamp() - interval '10 minutes'
   order by o.created_at desc, o.order_uuid desc
   limit 1;
  if found then
    raise exception 'checkout_reuse_required' using errcode = 'P0001';
  end if;

  insert into public.orders
    (order_uuid, user_id, product_id, amount, credits, status, provider, payment_id, is_test, pay_channel)
  values (p_order_uuid, p_user, p_product_id, p_amount, p_credits, 'pending', p_provider,
          p_payment_id, coalesce(p_is_test, false), p_pay_channel);
  return p_order_uuid;
end;
$function$;

revoke all on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) to service_role;

-- The old app-side reuse SELECT cannot compare credits. During the bounded
-- mixed-version rollout, reject only the config transition that could make it
-- return a same-price/different-credit pending snapshot. Price changes, product
-- deactivation and unrelated config edits remain available. 0092 turns the
-- private compatibility switch off after old requests drain.
create or replace function public.bp_guard_legacy_checkout_config_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.key = 'growth_levers'
     and new.value is distinct from old.value
     and public.bp_rollout_compatibility_enabled('legacy_checkout_reuse')
     and exists (
       select 1
         from public.orders o
         cross join lateral pg_catalog.jsonb_array_elements(
           coalesce(new.value->'products', '[]'::jsonb)
         ) elem
        where o.status = 'pending'
          and o.provider = 'portone'
          and o.payment_id is not null
          and o.paid_at is null
          and o.canceled_at is null
          and o.created_at >=
            pg_catalog.transaction_timestamp() - interval '10 minutes'
          and elem->>'productId' = o.product_id
          and coalesce((elem->>'active')::boolean, false)
          and (elem->>'price')::integer = o.amount
          and (elem->>'credits')::integer <> o.credits
     ) then
    raise exception 'checkout_config_change_pending' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_guard_legacy_checkout_config_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_guard_legacy_checkout_config_change
  on public.app_settings;
create trigger trg_guard_legacy_checkout_config_change
  before update of value on public.app_settings
  for each row
  when (old.key = 'growth_levers')
  execute function public.bp_guard_legacy_checkout_config_change();

-- create_pending_order를 우회하는 현재/미래 service-role INSERT도 탈퇴 lifecycle을 우회할 수 없다.
-- 기존 orders_insert_guard는 금융 초기상태 검증만 계속 담당하며 본문을 변경하지 않는다.
create or replace function public.bp_reject_deleted_order_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = new.user_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.bp_reject_deleted_order_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_orders_account_lifecycle_guard on public.orders;
create trigger trg_orders_account_lifecycle_guard
  before insert on public.orders
  for each row execute function public.bp_reject_deleted_order_insert();

comment on function public.bp_reject_deleted_order_insert() is
  'orders INSERT 전 profiles KEY SHARE/deleted_at 검사. account-delete와 checkout을 직렬화하는 DB backstop.';

do $$
declare
  v_create_def text;
  v_user_lock_def text;
begin
  select pg_catalog.pg_get_functiondef(
           'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
         )
    into v_create_def;
  select pg_catalog.pg_get_functiondef(
           'public.bp_checkout_user_lock(uuid)'::regprocedure
         )
    into v_user_lock_def;

  if pg_catalog.strpos(pg_catalog.lower(v_create_def), 'for key share') = 0
     or pg_catalog.strpos(v_create_def, 'public.app_settings') = 0
     or pg_catalog.strpos(v_create_def, 'checkout_reuse_required') = 0
     or pg_catalog.strpos(
       v_create_def, 'public.bp_checkout_user_lock'
     ) = 0
     or pg_catalog.strpos(
       v_user_lock_def, '''member:'''
     ) = 0 then
    raise exception '0075 postflight: create_pending_order lock/config contract missing';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.orders'::regclass
       and tgname = 'trg_orders_account_lifecycle_guard'
       and tgenabled = 'O'
       and not tgisinternal
  ) then
    raise exception '0075 postflight: orders lifecycle trigger missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.orders'::regclass
       and tgname = 'trg_orders_insert_guard'
       and tgenabled = 'O'
       and not tgisinternal
  ) then
    raise exception '0075 postflight: financial insert guard was lost';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.app_settings'::regclass
       and tgname = 'trg_guard_legacy_checkout_config_change'
       and tgenabled = 'O'
       and not tgisinternal
  ) then
    raise exception '0075 postflight: legacy checkout config guard missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.app_settings'::regclass
       and tgname = 'trg_app_settings_checkout_config_lock'
       and tgenabled = 'O'
       and not tgisinternal
  ) then
    raise exception '0075 postflight: checkout/config statement lock missing';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_order_insert()',
       'EXECUTE'
     ) then
    raise exception '0075 postflight: checkout lifecycle ACL boundary is open';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0075_checkout_account_delete_serialization', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
