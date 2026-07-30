-- 0084: 금융/크레딧/계정 lifecycle mutation의 단일 user lock order.
--
-- 0062 이후 각 RPC의 개별 row-lock 순서는 로컬로는 타당했지만 서로 달랐다.
-- 대표적으로 admin_adjust_credits(member -> lots)와 generation consume/sweep
-- (lots -> member), refund begin(order -> member -> lot)과 refund commit
-- (attempt -> order -> lot -> member)은 같은 사용자의 서로 다른 row를 먼저
-- 잡아 실제 양방향 교착이 가능했다.
--
-- 모든 외부 mutation은 이제:
--   immutable object advisory(객체 id로 owner를 찾는 RPC만) ->
--   user advisory(다중 user는 UUID 오름차순) -> 기존 구현의 row locks
-- 순서를 따른다. 기존 최종 구현은 rename하여 본문/반환/오류 의미를 보존하고,
-- 직접 EXECUTE를 전 역할에서 회수한다. 외부 이름에는 동일 signature/default/
-- return/security/search_path/ACL의 얇은 wrapper만 다시 만든다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
declare
  v_def text;
begin
  -- Reject the shared/local drift where 0083 was applied over a missing 0079.
  if to_regprocedure(
       'public.bp_create_or_update_member_consent_locked(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)'
     ) is null
     or to_regprocedure(
       'public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)'
     ) is null
     or to_regprocedure(
       'public.sync_active_member_oauth_profile(uuid,text,text,text)'
     ) is null
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.profiles'::regclass
          and t.tgname = 'trg_profiles_scrub_member_consent_on_delete'
          and not t.tgisinternal
          and t.tgenabled <> 'D'
     ) then
    raise exception '0084 preflight: sequential 0079 account lifecycle contract missing';
  end if;
  select pg_catalog.pg_get_functiondef(
           'public.bp_create_or_update_member_consent_locked(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'from public.profiles') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_def), 'for update') = 0 then
    raise exception '0084 preflight: 0079 locked consent helper is stale';
  end if;
  select pg_catalog.pg_get_functiondef(
           'public.sync_active_member_oauth_profile(uuid,text,text,text)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'from public.profiles') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_def), 'for update') = 0 then
    raise exception '0084 preflight: 0079 OAuth profile lock is stale';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.profiles'::regclass
       and t.tgname = 'trg_profiles_scrub_member_consent_on_delete'
       and p.oid = 'public.bp_scrub_member_consent_on_delete()'::regprocedure
       and not t.tgisinternal
       and t.tgenabled <> 'D'
  ) then
    raise exception '0084 preflight: 0079 consent scrub trigger target is stale';
  end if;
  if to_regprocedure(
       'public.finalize_reviewer_provision(uuid,uuid,integer)'
     ) is null then
    raise exception '0084 preflight: 0083 reviewer saga missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'public.admin_operation_receipts') = 0 then
    raise exception '0084 preflight: 0082 exactly-once credit adjustment missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'public.app_settings') = 0
     or pg_catalog.strpos(pg_catalog.lower(v_def), 'for key share') = 0
     or pg_catalog.strpos(v_def, 'public.bp_checkout_config_lock') = 0
     or pg_catalog.strpos(v_def, 'public.bp_checkout_user_lock') = 0
     or to_regprocedure('public.bp_checkout_config_lock()') is null
     or to_regprocedure('public.bp_checkout_user_lock(uuid)') is null
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.app_settings'::regclass
          and t.tgname = 'trg_app_settings_checkout_config_lock'
          and not t.tgisinternal
          and t.tgenabled <> 'D'
     ) then
    raise exception '0084 preflight: 0075 checkout/delete serialization missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_refund_begin(uuid,uuid,uuid,uuid,integer,text,timestamptz,text)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'cache_reserved_qty') = 0 then
    raise exception '0084 preflight: 0068 refund ledger contract missing';
  end if;
  select pg_catalog.pg_get_functiondef(
           'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'cancellation_amount_mismatch') = 0 then
    raise exception '0084 preflight: 0077 refund evidence contract missing';
  end if;
  select pg_catalog.pg_get_functiondef(
           'public.mark_generation_failed_and_refund(uuid,text,integer)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'v_refund_version') = 0 then
    raise exception '0084 preflight: 0073 generation terminal contract missing';
  end if;
  select pg_catalog.pg_get_functiondef(
           'public.admin_soft_delete_account(uuid)'::regprocedure
         )
    into v_def;
  if pg_catalog.strpos(v_def, 'public.account_deletion_cleanup_jobs') = 0 then
    raise exception '0084 preflight: 0072 account cleanup saga missing';
  end if;
end;
$$;

-- Snapshot the complete externally observable catalog contract before any
-- rename. The postflight compares the replacement wrappers to this table, so a
-- missed parameter name/default, return shape, SECURITY DEFINER flag,
-- search_path, or grant aborts the migration atomically.
create temporary table bp_0084_external_contract on commit drop as
with targets(signature) as (
  values
    ('public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'),
    ('public.mark_paid_and_grant(uuid,text,integer,jsonb,timestamptz,text)'),
    ('public.admin_settle_stuck_order(uuid,uuid,text)'),
    ('public.admin_adjust_credits(uuid,uuid,integer,text,uuid)'),
    ('public.create_generation_and_consume(uuid,text)'),
    ('public.create_generation_row(uuid,text)'),
    ('public.mark_generation_failed_and_refund(uuid,text,integer)'),
    ('public.expire_generation(uuid,integer)'),
    ('public.reopen_generation_artifact_cleanup(uuid)'),
    ('public.complete_generation_artifact_cleanup(uuid,text)'),
    ('public.admin_refund_begin(uuid,uuid,uuid,uuid,integer,text,timestamptz,text)'),
    ('public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)'),
    ('public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)'),
    ('public.admin_refund_commit(uuid)'),
    ('public.admin_refund_switch_to_manual(uuid,uuid,text,bigint,jsonb,text)'),
    ('public.admin_refund_commit_manual(uuid,uuid,text,text,uuid)'),
    ('public.admin_refund_release(uuid,uuid,text)'),
    ('public.admin_refund_replan_pre_pg(uuid,uuid,text,boolean)'),
    ('public.admin_refund_replan_after_pg(uuid,uuid,text,bigint,jsonb)'),
    ('public.cancel_intent_begin(uuid,uuid,timestamptz,text)'),
    ('public.cancel_intent_resolve(uuid,uuid,integer)'),
    ('public.record_payment_cancellation_observation(uuid,text,text,bigint,timestamptz,timestamptz,jsonb)'),
    ('public.resolve_external_cancellation(text,uuid,text,integer)'),
    ('public.resolve_external_cancellation_auto_full(uuid)'),
    ('public.admin_resolve_reconciliation_issue(uuid,uuid,text,text)'),
    ('public.mark_order_failed(uuid,text,text,jsonb)'),
    ('public.mark_order_canceled_unpaid(uuid,text,text,jsonb)'),
    ('public.admin_cancel_order(uuid,uuid,boolean,text,boolean)'),
    ('public.admin_cancel_order(uuid,uuid,boolean,text)'),
    ('public.sweep_expired(integer)'),
    ('public.admin_soft_delete_account(uuid)'),
    ('public.create_or_update_member_consent(uuid,integer,boolean,boolean,integer,boolean,integer)'),
    ('public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)'),
    ('public.sync_active_member_oauth_profile(uuid,text,text,text)'),
    ('public.admin_reactivate_account(uuid,uuid,text,text)'),
    ('public.admin_ban_member(uuid,uuid,text)'),
    ('public.admin_unban_member(uuid,uuid,text)'),
    ('public.request_avatar_clear(uuid)'),
    ('public.request_avatar_replace(uuid,text,text)'),
    ('public.reassign_anon_data(uuid,uuid)'),
    ('public.record_reviewer_provision_auth(uuid,uuid,integer,uuid)'),
    ('public.finalize_reviewer_provision(uuid,uuid,integer)')
)
select
  t.signature,
  p.prorettype,
  p.proretset,
  p.prokind,
  p.provolatile,
  p.proparallel,
  p.proisstrict,
  p.prosecdef,
  p.proleakproof,
  p.proargtypes,
  p.proallargtypes,
  p.proargmodes,
  p.proargnames,
  p.pronargdefaults,
  pg_catalog.pg_get_expr(p.proargdefaults, 0::oid) as default_expr,
  p.proconfig,
  p.proacl
from targets t
join pg_catalog.pg_proc p
  on p.oid = pg_catalog.to_regprocedure(t.signature);

do $$
begin
  if (select pg_catalog.count(*) from bp_0084_external_contract) <> 42 then
    raise exception '0084 preflight: external contract inventory incomplete';
  end if;
end;
$$;

-- These two legacy SECURITY DEFINER functions were the only external lifecycle
-- entries with a writable-schema search_path. Tightening them is an intentional
-- security-contract correction; every other catalog field remains snapshotted.
update bp_0084_external_contract
   set proconfig = array['search_path=""']::text[]
 where signature in (
   'public.admin_reactivate_account(uuid,uuid,text,text)',
   'public.admin_unban_member(uuid,uuid,text)'
 );

-- ── 1. Canonical lock helpers ───────────────────────────────────────────────

create or replace function public.bp_user_mutation_lock(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'user_lock_id_required' using errcode = 'P0001';
  end if;
  -- 0074 score submit/report/ban/reassign already established this exact
  -- namespace. Reusing it makes the user boundary global instead of creating
  -- a finance-only lock that could race profile/member mutations.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || p_user_id::text)::bigint
  );
end;
$$;
revoke all on function public.bp_user_mutation_lock(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_user_mutation_lock_many(p_user_ids uuid[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select distinct u.user_id
     from pg_catalog.unnest(coalesce(p_user_ids, array[]::uuid[]))
        as u(user_id)
     where u.user_id is not null
     order by u.user_id
  loop
    perform public.bp_user_mutation_lock(v_user_id);
  end loop;
end;
$$;
revoke all on function public.bp_user_mutation_lock_many(uuid[])
  from public, anon, authenticated, service_role;

create or replace function public.bp_mutation_object_lock(
  p_kind text,
  p_id text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_kind is null or p_id is null then
    raise exception 'object_lock_id_required' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'boss-paegi:mutation-object:' || p_kind || ':' || p_id,
      0::bigint
    )
  );
end;
$$;
revoke all on function public.bp_mutation_object_lock(text, text)
  from public, anon, authenticated, service_role;

-- Preserve existing subsystem advisory namespaces, but acquire them from the
-- outer wrapper before the global member lock so their legacy implementation
-- calls are reentrant instead of late lock-class acquisitions.
create or replace function public.bp_0084_credit_adjust_request_lock(
  p_request_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'admin:credit-adjust:' || p_request_id::text,
      0::bigint
    )
  );
end;
$$;
revoke all on function public.bp_0084_credit_adjust_request_lock(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_0084_legal_consent_locks(
  p_terms boolean,
  p_privacy boolean
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(p_terms, false) then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('legal:terms', 0::bigint)
    );
  end if;
  if coalesce(p_privacy, false) then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('legal:privacy', 0::bigint)
    );
  end if;
end;
$$;
revoke all on function public.bp_0084_legal_consent_locks(boolean, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.bp_0084_anon_reassign_locks(
  p_old uuid,
  p_new uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    7401,
    pg_catalog.hashtext(p_old::text)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    7402,
    pg_catalog.hashtext(p_new::text)
  );
end;
$$;
revoke all on function public.bp_0084_anon_reassign_locks(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ── 2. Preserve final implementations under non-RPC names ─────────────────

alter function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) rename to bp_0084_create_pending_order_impl;
alter function public.mark_paid_and_grant(
  uuid, text, integer, jsonb, timestamptz, text
) rename to bp_0084_mark_paid_and_grant_impl;
alter function public.admin_settle_stuck_order(uuid, uuid, text)
  rename to bp_0084_admin_settle_stuck_order_impl;
alter function public.admin_adjust_credits(uuid, uuid, integer, text)
  rename to bp_0084_admin_adjust_credits_legacy_impl;
alter function public.admin_adjust_credits(uuid, uuid, integer, text, uuid)
  rename to bp_0084_admin_adjust_credits_impl;

alter function public.create_generation_and_consume(uuid, text)
  rename to bp_0084_create_generation_and_consume_impl;
alter function public.create_generation_row(uuid, text)
  rename to bp_0084_create_generation_row_impl;
alter function public.mark_generation_failed_and_refund(uuid, text, integer)
  rename to bp_0084_mark_generation_failed_and_refund_impl;
alter function public.expire_generation(uuid, integer)
  rename to bp_0084_expire_generation_impl;
alter function public.reopen_generation_artifact_cleanup(uuid)
  rename to bp_0084_reopen_generation_artifact_cleanup_impl;
alter function public.complete_generation_artifact_cleanup(uuid, text)
  rename to bp_0084_complete_generation_artifact_cleanup_impl;

-- Settle used to duplicate the pre-quarantine purchase path and could recreate
-- live credits after account deletion. Reuse the hardened paid implementation:
-- deleted/cancel-intent orders become paid evidence plus an expired quarantine
-- lot, while an active account receives the normal lot exactly once.
create or replace function public.bp_0084_admin_settle_stuck_order_impl(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders%rowtype;
  v_before integer;
  v_after integer;
  v_paid_at timestamptz;
  v_settled boolean;
  v_error text;
  v_delta integer;
begin
  if pg_catalog.char_length(coalesce(p_reason, '')) < 5
     or pg_catalog.char_length(p_reason) > 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  select *
    into o
    from public.orders
   where order_uuid = p_order_uuid
   for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;
  if o.status not in ('pending', 'failed')
     or (o.pg_tx_id is null and o.payment_id is null) then
    raise exception 'not_settleable' using errcode = 'P0001';
  end if;

  select m.gen_credits
    into v_before
    from public.member_accounts m
   where m.user_id = o.user_id
   for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  v_paid_at := pg_catalog.clock_timestamp();
  v_settled := public.bp_0084_mark_paid_and_grant_impl(
    o.order_uuid,
    coalesce(o.pg_tx_id, o.payment_id),
    o.amount,
    coalesce(o.raw, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'admin_settled', true,
        'admin_user_id', p_admin,
        'admin_reason', p_reason
      ),
    v_paid_at,
    o.receipt_url
  );
  if not coalesce(v_settled, false) then
    raise exception 'status_changed' using errcode = 'P0001';
  end if;

  select m.gen_credits
    into v_after
    from public.member_accounts m
   where m.user_id = o.user_id;
  select current_order.error_message
    into v_error
    from public.orders current_order
   where current_order.order_uuid = o.order_uuid;
  v_delta := coalesce(v_after, 0) - coalesce(v_before, 0);

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
    o.user_id,
    o.order_uuid,
    v_delta,
    o.amount,
    v_before,
    v_after,
    p_reason,
    pg_catalog.jsonb_build_object(
      'requested_credits', o.credits,
      'quarantined', v_delta = 0,
      'order_error', v_error
    )
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'before', v_before,
    'after', v_after,
    'credits', v_delta,
    'requestedCredits', o.credits,
    'quarantined', v_delta = 0
  );
end;
$$;

-- Rename transfers the former service_role grants. Internal implementations
-- must only be callable by their owner or from SECURITY DEFINER wrappers.
revoke all on function public.bp_0084_create_pending_order_impl(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_mark_paid_and_grant_impl(
  uuid, text, integer, jsonb, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_settle_stuck_order_impl(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_adjust_credits_legacy_impl(
  uuid, uuid, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_adjust_credits_impl(
  uuid, uuid, integer, text, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.bp_0084_create_generation_and_consume_impl(
  uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_create_generation_row_impl(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_mark_generation_failed_and_refund_impl(
  uuid, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_expire_generation_impl(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_reopen_generation_artifact_cleanup_impl(
  uuid
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_complete_generation_artifact_cleanup_impl(
  uuid, text
) from public, anon, authenticated, service_role;

-- ── 3. Order/credit wrappers ────────────────────────────────────────────────

create function public.create_pending_order(
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
begin
  -- Object lock closes "owner lookup saw no row while checkout inserts it".
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  perform public.bp_checkout_config_lock();
  if p_user is not null then
    perform public.bp_user_mutation_lock(p_user);
  end if;
  return public.bp_0084_create_pending_order_impl(
    p_user, p_order_uuid, p_product_id, p_amount, p_credits,
    p_payment_id, p_provider, p_pay_channel, p_is_test
  );
end;
$$;
revoke all on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_pending_order(
  uuid, uuid, text, integer, integer, text, text, text, boolean
) to service_role;

create function public.mark_paid_and_grant(
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
  v_user_id uuid;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_mark_paid_and_grant_impl(
    p_order_uuid, p_pg_tx_id, p_price, p_raw, p_paid_at, p_receipt_url
  );
end;
$$;
revoke all on function public.mark_paid_and_grant(
  uuid, text, integer, jsonb, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.mark_paid_and_grant(
  uuid, text, integer, jsonb, timestamptz, text
) to service_role;

create function public.admin_settle_stuck_order(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_settle_stuck_order_impl(
    p_admin, p_order_uuid, p_reason
  );
end;
$$;
revoke all on function public.admin_settle_stuck_order(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_settle_stuck_order(uuid, uuid, text)
  to service_role;

create function public.admin_adjust_credits(
  p_admin uuid,
  p_target uuid,
  p_delta integer,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_request_id is not null then
    perform public.bp_0084_credit_adjust_request_lock(p_request_id);
  end if;
  if p_target is not null then
    perform public.bp_user_mutation_lock(p_target);
  end if;
  return public.bp_0084_admin_adjust_credits_impl(
    p_admin, p_target, p_delta, p_reason, p_request_id
  );
end;
$$;
revoke all on function public.admin_adjust_credits(
  uuid, uuid, integer, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_adjust_credits(
  uuid, uuid, integer, text, uuid
) to service_role;

-- Rolling expand wrapper for the currently deployed four-argument server.
-- It preserves the canonical user lock but cannot provide request-id
-- idempotency; 0092 drops it immediately after the new app smoke gate.
create function public.admin_adjust_credits(
  p_admin uuid,
  p_target uuid,
  p_delta integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_target is not null then
    perform public.bp_user_mutation_lock(p_target);
  end if;
  return public.bp_0084_admin_adjust_credits_legacy_impl(
    p_admin, p_target, p_delta, p_reason
  );
end;
$$;
revoke all on function public.admin_adjust_credits(
  uuid, uuid, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_adjust_credits(
  uuid, uuid, integer, text
) to service_role;

-- ── 4. Generation wrappers ─────────────────────────────────────────────────

create function public.create_generation_and_consume(
  p_user uuid,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is not null then
    perform public.bp_user_mutation_lock(p_user);
  end if;
  return public.bp_0084_create_generation_and_consume_impl(p_user, p_role);
end;
$$;
revoke all on function public.create_generation_and_consume(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_generation_and_consume(uuid, text)
  to service_role;

create function public.create_generation_row(p_user uuid, p_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is not null then
    perform public.bp_user_mutation_lock(p_user);
  end if;
  return public.bp_0084_create_generation_row_impl(p_user, p_role);
end;
$$;
revoke all on function public.create_generation_row(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_generation_row(uuid, text)
  to service_role;

create function public.mark_generation_failed_and_refund(
  p_gen_id uuid,
  p_fail_reason text,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_gen_id is not null then
    perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  end if;
  select g.owner_id into v_user_id
    from public.ai_generations g
   where g.id = p_gen_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_mark_generation_failed_and_refund_impl(
    p_gen_id, p_fail_reason, p_expected_version
  );
end;
$$;
revoke all on function public.mark_generation_failed_and_refund(
  uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.mark_generation_failed_and_refund(
  uuid, text, integer
) to service_role;

create function public.expire_generation(
  p_gen_id uuid,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_gen_id is not null then
    perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  end if;
  select g.owner_id into v_user_id
    from public.ai_generations g
   where g.id = p_gen_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_expire_generation_impl(
    p_gen_id, p_expected_version
  );
end;
$$;
revoke all on function public.expire_generation(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.expire_generation(uuid, integer)
  to service_role;

create function public.reopen_generation_artifact_cleanup(p_gen_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_gen_id is not null then
    perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  end if;
  select g.owner_id into v_user_id
    from public.ai_generations g
   where g.id = p_gen_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_reopen_generation_artifact_cleanup_impl(p_gen_id);
end;
$$;
revoke all on function public.reopen_generation_artifact_cleanup(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reopen_generation_artifact_cleanup(uuid)
  to service_role;

create function public.complete_generation_artifact_cleanup(
  p_gen_id uuid,
  p_expected_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_gen_id is not null then
    perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  end if;
  select g.owner_id into v_user_id
    from public.ai_generations g
   where g.id = p_gen_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_complete_generation_artifact_cleanup_impl(
    p_gen_id, p_expected_status
  );
end;
$$;
revoke all on function public.complete_generation_artifact_cleanup(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_generation_artifact_cleanup(uuid, text)
  to service_role;

-- ── 5. Refund/order-state implementation isolation ─────────────────────────

alter function public.admin_refund_begin(
  uuid, uuid, uuid, uuid, integer, text, timestamptz, text
) rename to bp_0084_admin_refund_begin_impl;
alter function public.admin_refund_mark_pg_requested(
  uuid, bigint, bigint, bigint, jsonb, jsonb
) rename to bp_0084_admin_refund_mark_pg_requested_impl;
alter function public.admin_refund_record_pg_result(
  uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz
) rename to bp_0084_admin_refund_record_pg_result_impl;
alter function public.admin_refund_commit(uuid)
  rename to bp_0084_admin_refund_commit_impl;
alter function public.admin_refund_switch_to_manual(
  uuid, uuid, text, bigint, jsonb, text
) rename to bp_0084_admin_refund_switch_to_manual_impl;
alter function public.admin_refund_commit_manual(
  uuid, uuid, text, text, uuid
) rename to bp_0084_admin_refund_commit_manual_impl;
alter function public.admin_refund_release(uuid, uuid, text)
  rename to bp_0084_admin_refund_release_impl;
alter function public.admin_refund_replan_pre_pg(uuid, uuid, text, boolean)
  rename to bp_0084_admin_refund_replan_pre_pg_impl;
alter function public.admin_refund_replan_after_pg(
  uuid, uuid, text, bigint, jsonb
) rename to bp_0084_admin_refund_replan_after_pg_impl;
alter function public.cancel_intent_begin(uuid, uuid, timestamptz, text)
  rename to bp_0084_cancel_intent_begin_impl;
alter function public.cancel_intent_resolve(uuid, uuid, integer)
  rename to bp_0084_cancel_intent_resolve_impl;
alter function public.record_payment_cancellation_observation(
  uuid, text, text, bigint, timestamptz, timestamptz, jsonb
) rename to bp_0084_record_payment_cancellation_observation_impl;
alter function public.resolve_external_cancellation(text, uuid, text, integer)
  rename to bp_0084_resolve_external_cancellation_impl;
alter function public.resolve_external_cancellation_auto_full(uuid)
  rename to bp_0084_resolve_external_cancellation_auto_full_impl;
alter function public.admin_resolve_reconciliation_issue(
  uuid, uuid, text, text
) rename to bp_0084_admin_resolve_reconciliation_issue_impl;
alter function public.mark_order_failed(uuid, text, text, jsonb)
  rename to bp_0084_mark_order_failed_impl;
alter function public.mark_order_canceled_unpaid(uuid, text, text, jsonb)
  rename to bp_0084_mark_order_canceled_unpaid_impl;
alter function public.admin_cancel_order(
  uuid, uuid, boolean, text, boolean
) rename to bp_0084_admin_cancel_order_impl;
alter function public.admin_cancel_order(uuid, uuid, boolean, text)
  rename to bp_0084_admin_cancel_order_legacy_impl;

-- The former SQL overload resolved the public five-argument name at runtime.
-- Point it at the isolated implementation so even an owner-only internal call
-- cannot reacquire an object lock after a user lock.
create or replace function public.bp_0084_admin_cancel_order_legacy_impl(
  p_admin uuid,
  p_order_uuid uuid,
  p_clawback boolean,
  p_reason text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.bp_0084_admin_cancel_order_impl(
    p_admin, p_order_uuid, p_clawback, p_reason, false
  );
$$;

revoke all on function public.bp_0084_admin_refund_begin_impl(
  uuid, uuid, uuid, uuid, integer, text, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_mark_pg_requested_impl(
  uuid, bigint, bigint, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_record_pg_result_impl(
  uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_commit_impl(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_switch_to_manual_impl(
  uuid, uuid, text, bigint, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_commit_manual_impl(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_release_impl(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_replan_pre_pg_impl(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_refund_replan_after_pg_impl(
  uuid, uuid, text, bigint, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_cancel_intent_begin_impl(
  uuid, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_cancel_intent_resolve_impl(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function
  public.bp_0084_record_payment_cancellation_observation_impl(
    uuid, text, text, bigint, timestamptz, timestamptz, jsonb
  ) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_resolve_external_cancellation_impl(
  text, uuid, text, integer
) from public, anon, authenticated, service_role;
revoke all on function
  public.bp_0084_resolve_external_cancellation_auto_full_impl(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_resolve_reconciliation_issue_impl(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_mark_order_failed_impl(
  uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_mark_order_canceled_unpaid_impl(
  uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_cancel_order_impl(
  uuid, uuid, boolean, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_cancel_order_legacy_impl(
  uuid, uuid, boolean, text
) from public, anon, authenticated, service_role;

-- Every attempt wrapper uses an immutable attempt id advisory before its
-- non-locking owner lookup. Attempt user_id is frozen by the 0062 lifecycle
-- guard, so the following user advisory is the authoritative owner lock.

create function public.admin_refund_begin(
  p_request_id uuid,
  p_admin uuid,
  p_user uuid,
  p_order_uuid uuid,
  p_qty integer,
  p_reason text,
  p_customer_requested_at timestamptz,
  p_rail text default 'portone_cancel'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  if p_user is not null then
    perform public.bp_user_mutation_lock(p_user);
  end if;
  return public.bp_0084_admin_refund_begin_impl(
    p_request_id, p_admin, p_user, p_order_uuid, p_qty, p_reason,
    p_customer_requested_at, p_rail
  );
end;
$$;
revoke all on function public.admin_refund_begin(
  uuid, uuid, uuid, uuid, integer, text, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_begin(
  uuid, uuid, uuid, uuid, integer, text, timestamptz, text
) to service_role;

create function public.admin_refund_mark_pg_requested(
  p_attempt_id uuid,
  p_total_before bigint,
  p_cancelled_before bigint,
  p_cancellable_before bigint,
  p_cancellation_ids_before jsonb,
  p_request_body jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_mark_pg_requested_impl(
    p_attempt_id, p_total_before, p_cancelled_before, p_cancellable_before,
    p_cancellation_ids_before, p_request_body
  );
end;
$$;
revoke all on function public.admin_refund_mark_pg_requested(
  uuid, bigint, bigint, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_mark_pg_requested(
  uuid, bigint, bigint, bigint, jsonb, jsonb
) to service_role;

create function public.admin_refund_record_pg_result(
  p_attempt_id uuid,
  p_result text,
  p_cancel_id text,
  p_cancel_status text,
  p_cancelled_amount bigint,
  p_receipt_url text,
  p_raw jsonb,
  p_requested_at timestamptz default null,
  p_cancelled_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_record_pg_result_impl(
    p_attempt_id, p_result, p_cancel_id, p_cancel_status,
    p_cancelled_amount, p_receipt_url, p_raw, p_requested_at, p_cancelled_at
  );
end;
$$;
revoke all on function public.admin_refund_record_pg_result(
  uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_record_pg_result(
  uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz
) to service_role;

create function public.admin_refund_commit(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_commit_impl(p_attempt_id);
end;
$$;
revoke all on function public.admin_refund_commit(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_commit(uuid) to service_role;

create function public.admin_refund_switch_to_manual(
  p_attempt_id uuid,
  p_admin uuid,
  p_reason text,
  p_observed_cancelled_amount bigint,
  p_observed_cancellation_ids jsonb,
  p_verification_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_switch_to_manual_impl(
    p_attempt_id, p_admin, p_reason, p_observed_cancelled_amount,
    p_observed_cancellation_ids, p_verification_source
  );
end;
$$;
revoke all on function public.admin_refund_switch_to_manual(
  uuid, uuid, text, bigint, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_switch_to_manual(
  uuid, uuid, text, bigint, jsonb, text
) to service_role;

create function public.admin_refund_commit_manual(
  p_attempt_id uuid,
  p_admin uuid,
  p_reason text,
  p_external_payout_ref text,
  p_evidence_object_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_commit_manual_impl(
    p_attempt_id, p_admin, p_reason, p_external_payout_ref,
    p_evidence_object_id
  );
end;
$$;
revoke all on function public.admin_refund_commit_manual(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_commit_manual(
  uuid, uuid, text, text, uuid
) to service_role;

create function public.admin_refund_release(
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
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_release_impl(
    p_attempt_id, p_admin, p_reason
  );
end;
$$;
revoke all on function public.admin_refund_release(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_release(uuid, uuid, text)
  to service_role;

create function public.admin_refund_replan_pre_pg(
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
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_replan_pre_pg_impl(
    p_attempt_id, p_admin, p_reason, p_external
  );
end;
$$;
revoke all on function public.admin_refund_replan_pre_pg(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_replan_pre_pg(
  uuid, uuid, text, boolean
) to service_role;

create function public.admin_refund_replan_after_pg(
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
  v_user_id uuid;
begin
  if p_attempt_id is not null then
    perform public.bp_mutation_object_lock('refund-attempt', p_attempt_id::text);
  end if;
  select a.user_id into v_user_id
    from public.order_refund_attempts a
   where a.id = p_attempt_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_refund_replan_after_pg_impl(
    p_attempt_id, p_admin, p_reason, p_observed_cancelled_amount,
    p_observed_cancellation_ids
  );
end;
$$;
revoke all on function public.admin_refund_replan_after_pg(
  uuid, uuid, text, bigint, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_replan_after_pg(
  uuid, uuid, text, bigint, jsonb
) to service_role;

create function public.cancel_intent_begin(
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
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_cancel_intent_begin_impl(
    p_admin, p_order_uuid, p_customer_requested_at, p_reason
  );
end;
$$;
revoke all on function public.cancel_intent_begin(
  uuid, uuid, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.cancel_intent_begin(
  uuid, uuid, timestamptz, text
) to service_role;

create function public.cancel_intent_resolve(
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
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_cancel_intent_resolve_impl(
    p_admin, p_order_uuid, p_qty
  );
end;
$$;
revoke all on function public.cancel_intent_resolve(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_intent_resolve(uuid, uuid, integer)
  to service_role;

create function public.record_payment_cancellation_observation(
  p_order_uuid uuid,
  p_cancellation_id text,
  p_status text,
  p_amount bigint,
  p_requested_at timestamptz,
  p_cancelled_at timestamptz,
  p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_cancellation_id is not null then
    perform public.bp_mutation_object_lock('cancellation', p_cancellation_id);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_record_payment_cancellation_observation_impl(
    p_order_uuid, p_cancellation_id, p_status, p_amount,
    p_requested_at, p_cancelled_at, p_raw
  );
end;
$$;
revoke all on function public.record_payment_cancellation_observation(
  uuid, text, text, bigint, timestamptz, timestamptz, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_payment_cancellation_observation(
  uuid, text, text, bigint, timestamptz, timestamptz, jsonb
) to service_role;

create function public.resolve_external_cancellation(
  p_cancellation_id text,
  p_resolved_by uuid,
  p_note text,
  p_economic_qty integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_cancellation_id is not null then
    perform public.bp_mutation_object_lock('cancellation', p_cancellation_id);
  end if;
  select o.user_id into v_user_id
    from public.payment_cancellation_events e
    join public.orders o on o.order_uuid = e.order_uuid
   where e.cancellation_id = p_cancellation_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_resolve_external_cancellation_impl(
    p_cancellation_id, p_resolved_by, p_note, p_economic_qty
  );
end;
$$;
revoke all on function public.resolve_external_cancellation(
  text, uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_external_cancellation(
  text, uuid, text, integer
) to service_role;

create function public.resolve_external_cancellation_auto_full(
  p_order_uuid uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_resolve_external_cancellation_auto_full_impl(
    p_order_uuid
  );
end;
$$;
revoke all on function public.resolve_external_cancellation_auto_full(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_external_cancellation_auto_full(uuid)
  to service_role;

create function public.admin_resolve_reconciliation_issue(
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
  v_user_id uuid;
begin
  if p_issue_id is not null then
    perform public.bp_mutation_object_lock(
      'reconciliation-issue', p_issue_id::text
    );
  end if;
  select i.user_id into v_user_id
    from public.reconciliation_issues i
   where i.id = p_issue_id;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_admin_resolve_reconciliation_issue_impl(
    p_issue_id, p_admin, p_resolution, p_note
  );
end;
$$;
revoke all on function public.admin_resolve_reconciliation_issue(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_resolve_reconciliation_issue(
  uuid, uuid, text, text
) to service_role;

create function public.mark_order_failed(
  p_order_uuid uuid,
  p_pg_status text,
  p_error_message text,
  p_raw jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_mark_order_failed_impl(
    p_order_uuid, p_pg_status, p_error_message, p_raw
  );
end;
$$;
revoke all on function public.mark_order_failed(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_order_failed(uuid, text, text, jsonb)
  to service_role;

create function public.mark_order_canceled_unpaid(
  p_order_uuid uuid,
  p_pg_status text,
  p_pg_tx_id text,
  p_raw jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_mark_order_canceled_unpaid_impl(
    p_order_uuid, p_pg_status, p_pg_tx_id, p_raw
  );
end;
$$;
revoke all on function public.mark_order_canceled_unpaid(
  uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.mark_order_canceled_unpaid(
  uuid, text, text, jsonb
) to service_role;

create function public.admin_cancel_order(
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
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
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

create function public.admin_cancel_order(
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
begin
  if p_order_uuid is not null then
    perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  end if;
  select o.user_id into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  -- Do not call the public five-argument wrapper here. We already hold the
  -- order object and user locks; a wrapper-to-wrapper call would attempt a new
  -- object lock after the user lock and invert the global order.
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

-- ── 6. Multi-user expiry sweep ─────────────────────────────────────────────

alter function public.sweep_expired(integer)
  rename to bp_0084_sweep_expired_legacy_impl;
revoke all on function public.bp_0084_sweep_expired_legacy_impl(integer)
  from public, anon, authenticated, service_role;

-- The old function selected rows FOR UPDATE before their user was known. The
-- wrapper instead freezes an exact bounded id set without row locks, locks every
-- represented user in UUID order, then lets this private core revalidate/lock
-- only that set. Newly due rows are intentionally left for the next cron pass.
create function public.bp_0084_sweep_expired_ids_impl(p_lot_ids uuid[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_lot_id uuid;
  v_lot public.credit_lots%rowtype;
  v_avail integer;
  v_count integer := 0;
begin
  foreach v_lot_id in array coalesce(p_lot_ids, array[]::uuid[])
  loop
    select *
      into v_lot
      from public.credit_lots l
     where l.id = v_lot_id
     for update;
    if not found
       or v_lot.expired_at is not null
       or v_lot.expires_at > pg_catalog.now() then
      continue;
    end if;

    v_avail :=
      v_lot.qty - v_lot.consumed - v_lot.refunded - v_lot.refund_reserved;
    update public.credit_lots
       set expired_at = pg_catalog.now(),
           expiration_reason = 'natural'
     where id = v_lot.id;
    if v_avail > 0 then
      update public.member_accounts
         set gen_credits = gen_credits - v_avail
       where user_id = v_lot.user_id;
    end if;
    perform public.bp_credit_ledger_write(
      v_lot.user_id, -v_avail, 'expire',
      null, null, v_lot.id, null, null, null, 'natural'
    );
    v_count := v_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object('ok', true, 'expired', v_count);
end;
$$;
revoke all on function public.bp_0084_sweep_expired_ids_impl(uuid[])
  from public, anon, authenticated, service_role;

create function public.sweep_expired(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  v_lot_ids uuid[];
  v_user_ids uuid[];
begin
  select
    coalesce(
      pg_catalog.array_agg(c.id order by c.expires_at, c.id),
      array[]::uuid[]
    ),
    coalesce(
      pg_catalog.array_agg(distinct c.user_id order by c.user_id),
      array[]::uuid[]
    )
    into v_lot_ids, v_user_ids
    from (
      select l.id, l.user_id, l.expires_at
        from public.credit_lots l
       where l.expired_at is null
         and l.expires_at <= pg_catalog.now()
       order by l.expires_at, l.id
       limit v_limit
    ) c;

  perform public.bp_user_mutation_lock_many(v_user_ids);
  return public.bp_0084_sweep_expired_ids_impl(v_lot_ids);
end;
$$;
revoke all on function public.sweep_expired(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.sweep_expired(integer) to service_role;

-- ── 7. Account/profile lifecycle implementation isolation ──────────────────

alter function public.admin_soft_delete_account(uuid)
  rename to bp_0084_admin_soft_delete_account_impl;
alter function public.create_or_update_member_consent(
  uuid, integer, boolean, boolean, integer, boolean, integer
) rename to bp_0084_create_or_update_member_consent_impl;
alter function public.create_or_update_member_consent_with_profile(
  uuid, integer, boolean, boolean, integer, boolean, integer,
  text, text, text
) rename to bp_0084_create_or_update_member_consent_with_profile_impl;
alter function public.sync_active_member_oauth_profile(uuid, text, text, text)
  rename to bp_0084_sync_active_member_oauth_profile_impl;
alter function public.admin_reactivate_account(uuid, uuid, text, text)
  rename to bp_0084_admin_reactivate_account_impl;
alter function public.admin_ban_member(uuid, uuid, text)
  rename to bp_0084_admin_ban_member_impl;
alter function public.admin_unban_member(uuid, uuid, text)
  rename to bp_0084_admin_unban_member_impl;
alter function public.request_avatar_clear(uuid)
  rename to bp_0084_request_avatar_clear_impl;
alter function public.request_avatar_replace(uuid, text, text)
  rename to bp_0084_request_avatar_replace_impl;
alter function public.reassign_anon_data(uuid, uuid)
  rename to bp_0084_reassign_anon_data_impl;
alter function public.record_reviewer_provision_auth(
  uuid, uuid, integer, uuid
) rename to bp_0084_record_reviewer_provision_auth_impl;
alter function public.finalize_reviewer_provision(uuid, uuid, integer)
  rename to bp_0084_finalize_reviewer_provision_impl;

-- Lock the profile on the first lifecycle read and remove the legacy
-- search_path=public. The outer wrapper serializes the email namespace and user
-- before this function can take any row lock.
create or replace function public.bp_0084_admin_reactivate_account_impl(
  p_user_id uuid,
  p_admin uuid,
  p_reason text,
  p_email_override text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted timestamptz;
  v_provider text;
  v_id_email text;
  v_name text;
  v_avatar text;
  v_email text;
  v_norm text;
begin
  if pg_catalog.char_length(coalesce(p_reason, '')) < 5
     or pg_catalog.char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;

  select p.deleted_at
    into v_deleted
    from public.profiles p
   where p.id = p_user_id
   for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_deleted is null then
    raise exception 'not_withdrawn';
  end if;

  select u.raw_app_meta_data->>'provider'
    into v_provider
    from auth.users u
   where u.id = p_user_id;

  select
    coalesce(i.email, i.identity_data->>'email'),
    coalesce(
      i.identity_data->>'name',
      i.identity_data->>'full_name',
      i.identity_data->>'nickname'
    ),
    coalesce(i.identity_data->>'avatar_url', i.identity_data->>'picture')
    into v_id_email, v_name, v_avatar
   from auth.identities i
   where i.user_id = p_user_id
   order by coalesce(
              pg_catalog.lower(
                coalesce(i.email, i.identity_data->>'email')
              ) not like '%@deleted.invalid',
              false
            ) desc,
            (i.provider <> 'email') desc,
            (i.provider is not distinct from v_provider) desc,
            (
              coalesce(i.email, i.identity_data->>'email') is not null
            ) desc,
            i.created_at desc nulls last,
            i.id desc
   limit 1;

  v_email := nullif(
    pg_catalog.btrim(coalesce(v_id_email, p_email_override)),
    ''
  );
  if pg_catalog.lower(v_email) like '%@deleted.invalid' then
    v_email := nullif(pg_catalog.btrim(p_email_override), '');
  end if;
  if v_email is null then
    raise exception 'identity_email_missing';
  end if;
  v_norm := pg_catalog.lower(v_email);

  if exists (
    select 1
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
     where m.user_id <> p_user_id
       and p.deleted_at is null
       and pg_catalog.lower(pg_catalog.btrim(m.email)) = v_norm
  ) then
    raise exception 'email_conflict';
  end if;

  v_name := nullif(pg_catalog.btrim(coalesce(v_name, '')), '');
  v_name := case
    when v_name is not null then pg_catalog.left(v_name, 12)
    else '사용자'
  end;

  update public.profiles
     set deleted_at = null,
         display_name = v_name,
         avatar_url = v_avatar
   where id = p_user_id;

  update public.member_accounts
     set email = v_email,
         reconsent_required = true,
         terms_agreed_at = null,
         privacy_agreed_at = null,
         terms_version = null,
         privacy_version = null,
         updated_at = pg_catalog.now()
   where user_id = p_user_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  insert into public.account_admin_actions_ledger(
    admin_user_id,
    action_type,
    target_user_id,
    reason,
    metadata
  )
  values (
    p_admin,
    'account_reactivate',
    p_user_id,
    p_reason,
    pg_catalog.jsonb_build_object(
      'restored_email', v_email,
      'restored_name', v_name,
      'provider', v_provider,
      'email_source',
      case
        when v_id_email is not null
         and pg_catalog.lower(v_id_email) not like '%@deleted.invalid'
        then 'identity'
        else 'override'
      end
    )
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'email', v_email,
    'display_name', v_name
  );
end;
$$;

alter function public.bp_0084_admin_unban_member_impl(uuid, uuid, text)
  set search_path = '';

-- The auth trigger is profile lifecycle code too. Its body is already fully
-- qualified, so remove the last writable-schema search path without changing
-- its OID or trigger attachment.
alter function public.handle_new_user() set search_path = '';

-- 0083 finalized by calling the public consent RPC. After wrapping, that name
-- would be a wrapper-to-wrapper edge. Keep the exact behavior but call the
-- isolated consent implementation while the outer finalize wrapper owns the
-- canonical reviewer-job and user locks.
create or replace function public.bp_0084_finalize_reviewer_provision_impl(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.reviewer_account_jobs%rowtype;
  v_auth_email text;
  v_auth_meta jsonb;
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_terms integer;
  v_privacy integer;
begin
  select *
    into v_job
    from public.reviewer_account_jobs
   where id = p_job_id
   for update;
  if not found
     or v_job.status <> 'leased'
     or v_job.action <> 'provision'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;
  if v_job.user_id is null then
    raise exception 'auth_identity_missing' using errcode = 'P0001';
  end if;

  select pg_catalog.lower(u.email), u.raw_app_meta_data
    into v_auth_email, v_auth_meta
    from auth.users u
   where u.id = v_job.user_id;
  if not found
     or v_auth_email is distinct from v_job.email
     or coalesce(v_auth_meta->>'reviewer', '') <> 'true'
     or coalesce(v_auth_meta->>'reviewer_job_id', '') <> v_job.id::text then
    raise exception 'auth_identity_invalid' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:terms', 0::bigint)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:privacy', 0::bigint)
  );
  select l.version
    into v_terms
    from public.legal_documents l
   where l.doc_type = 'terms'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  select l.version
    into v_privacy
    from public.legal_documents l
   where l.doc_type = 'privacy'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;

  perform public.bp_0084_create_or_update_member_consent_impl(
    v_job.user_id,
    0,
    true,
    v_terms is not null,
    coalesce(v_terms, 0),
    v_privacy is not null,
    coalesce(v_privacy, 0)
  );

  insert into public.reviewer_accounts(
    user_id,
    email,
    active,
    auth_sync_pending,
    note,
    created_by
  )
  values (
    v_job.user_id,
    v_job.email,
    true,
    false,
    v_job.note,
    v_job.created_by
  );

  update public.reviewer_account_jobs
     set status = 'completed',
         lease_token = null,
         leased_until = null,
         last_error = null,
         completed_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'status', 'completed',
    'user_id', v_job.user_id,
    'email', v_job.email
  );
end;
$$;

revoke all on function public.bp_0084_admin_soft_delete_account_impl(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.bp_0084_create_or_update_member_consent_impl(
    uuid, integer, boolean, boolean, integer, boolean, integer
  ) from public, anon, authenticated, service_role;
revoke all on function
  public.bp_0084_create_or_update_member_consent_with_profile_impl(
    uuid, integer, boolean, boolean, integer, boolean, integer,
    text, text, text
  ) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_sync_active_member_oauth_profile_impl(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_reactivate_account_impl(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_ban_member_impl(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_admin_unban_member_impl(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_request_avatar_clear_impl(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_request_avatar_replace_impl(
  uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_reassign_anon_data_impl(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_record_reviewer_provision_auth_impl(
  uuid, uuid, integer, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.bp_0084_finalize_reviewer_provision_impl(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;

create function public.admin_soft_delete_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_admin_soft_delete_account_impl(p_user_id);
end;
$$;
revoke all on function public.admin_soft_delete_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_soft_delete_account(uuid)
  to service_role;

create function public.create_or_update_member_consent(
  p_user_id uuid,
  p_bonus integer,
  p_set_age boolean,
  p_set_terms boolean,
  p_terms_ver integer,
  p_set_privacy boolean,
  p_privacy_ver integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bp_0084_legal_consent_locks(
    p_set_terms, p_set_privacy
  );
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_create_or_update_member_consent_impl(
    p_user_id, p_bonus, p_set_age, p_set_terms, p_terms_ver,
    p_set_privacy, p_privacy_ver
  );
end;
$$;
revoke all on function public.create_or_update_member_consent(
  uuid, integer, boolean, boolean, integer, boolean, integer
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_update_member_consent(
  uuid, integer, boolean, boolean, integer, boolean, integer
) to service_role;

create function public.create_or_update_member_consent_with_profile(
  p_user_id uuid,
  p_bonus integer,
  p_set_age boolean,
  p_set_terms boolean,
  p_terms_ver integer,
  p_set_privacy boolean,
  p_privacy_ver integer,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bp_0084_legal_consent_locks(
    p_set_terms, p_set_privacy
  );
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_create_or_update_member_consent_with_profile_impl(
    p_user_id, p_bonus, p_set_age, p_set_terms, p_terms_ver,
    p_set_privacy, p_privacy_ver, p_display_name, p_avatar_url, p_email
  );
end;
$$;
revoke all on function public.create_or_update_member_consent_with_profile(
  uuid, integer, boolean, boolean, integer, boolean, integer,
  text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_update_member_consent_with_profile(
  uuid, integer, boolean, boolean, integer, boolean, integer,
  text, text, text
) to service_role;

create function public.sync_active_member_oauth_profile(
  p_user_id uuid,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_sync_active_member_oauth_profile_impl(
    p_user_id, p_display_name, p_avatar_url, p_email
  );
end;
$$;
revoke all on function public.sync_active_member_oauth_profile(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.sync_active_member_oauth_profile(
  uuid, text, text, text
) to service_role;

create function public.admin_reactivate_account(
  p_user_id uuid,
  p_admin uuid,
  p_reason text,
  p_email_override text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- member_accounts.email has no cross-row unique index; serialize the rare
  -- reactivation namespace so two deleted accounts cannot both pass the active
  -- email-conflict check for the same restored address.
  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_admin_reactivate_account_impl(
    p_user_id, p_admin, p_reason, p_email_override
  );
end;
$$;
revoke all on function public.admin_reactivate_account(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_reactivate_account(
  uuid, uuid, text, text
) to service_role;

create function public.admin_ban_member(
  p_admin_id uuid,
  p_member_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_member_id is not null then
    perform public.bp_user_mutation_lock(p_member_id);
  end if;
  return public.bp_0084_admin_ban_member_impl(
    p_admin_id, p_member_id, p_reason
  );
end;
$$;
revoke all on function public.admin_ban_member(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_ban_member(uuid, uuid, text)
  to service_role;

create function public.admin_unban_member(
  p_admin_id uuid,
  p_member_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_member_id is not null then
    perform public.bp_user_mutation_lock(p_member_id);
  end if;
  return public.bp_0084_admin_unban_member_impl(
    p_admin_id, p_member_id, p_reason
  );
end;
$$;
revoke all on function public.admin_unban_member(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_unban_member(uuid, uuid, text)
  to service_role;

create function public.request_avatar_clear(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_request_avatar_clear_impl(p_user_id);
end;
$$;
revoke all on function public.request_avatar_clear(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_avatar_clear(uuid) to service_role;

create function public.request_avatar_replace(
  p_user_id uuid,
  p_path text,
  p_public_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_request_avatar_replace_impl(
    p_user_id, p_path, p_public_url
  );
end;
$$;
revoke all on function public.request_avatar_replace(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_avatar_replace(uuid, text, text)
  to service_role;

create function public.reassign_anon_data(p_old uuid, p_new uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The implementation still takes the established source/target claim keys.
  -- Pre-acquire them before the sorted member set so its calls are reentrant.
  if p_old is not null and p_new is not null and p_old <> p_new then
    perform public.bp_0084_anon_reassign_locks(p_old, p_new);
  end if;
  perform public.bp_user_mutation_lock_many(array[p_old, p_new]);
  return public.bp_0084_reassign_anon_data_impl(p_old, p_new);
end;
$$;
revoke all on function public.reassign_anon_data(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reassign_anon_data(uuid, uuid)
  to service_role;

-- Provision-auth and finalize share a job object lock. This closes the null
-- user_id hand-off race while preserving object -> user -> job-row order.
create function public.record_reviewer_provision_auth(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job_id is not null then
    perform public.bp_mutation_object_lock('reviewer-job', p_job_id::text);
  end if;
  -- This phase only records the Auth user on the reviewer job. The shared job
  -- object lock fences finalize; taking the user lock here would serialize an
  -- unrelated job-only mutation.
  return public.bp_0084_record_reviewer_provision_auth_impl(
    p_job_id, p_lease_token, p_lease_version, p_user_id
  );
end;
$$;
revoke all on function public.record_reviewer_provision_auth(
  uuid, uuid, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.record_reviewer_provision_auth(
  uuid, uuid, integer, uuid
) to service_role;

create function public.finalize_reviewer_provision(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_job_id is not null then
    perform public.bp_mutation_object_lock('reviewer-job', p_job_id::text);
  end if;
  select j.user_id into v_user_id
    from public.reviewer_account_jobs j
   where j.id = p_job_id;
  perform public.bp_0084_legal_consent_locks(true, true);
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;
  return public.bp_0084_finalize_reviewer_provision_impl(
    p_job_id, p_lease_token, p_lease_version
  );
end;
$$;
revoke all on function public.finalize_reviewer_provision(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_reviewer_provision(
  uuid, uuid, integer
) to service_role;

-- ── 8. Catalog, ACL, and call-graph postflight ─────────────────────────────

do $$
declare
  v_contract record;
  v_proc pg_catalog.pg_proc%rowtype;
begin
  for v_contract in
    select * from bp_0084_external_contract order by signature
  loop
    select p.*
      into v_proc
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_contract.signature);
    if not found then
      raise exception '0084 postflight: wrapper missing: %',
        v_contract.signature;
    end if;
    if v_proc.prorettype is distinct from v_contract.prorettype
       or v_proc.proretset is distinct from v_contract.proretset
       or v_proc.prokind is distinct from v_contract.prokind
       or v_proc.provolatile is distinct from v_contract.provolatile
       or v_proc.proparallel is distinct from v_contract.proparallel
       or v_proc.proisstrict is distinct from v_contract.proisstrict
       or v_proc.prosecdef is distinct from v_contract.prosecdef
       or v_proc.proleakproof is distinct from v_contract.proleakproof
       or v_proc.proargtypes is distinct from v_contract.proargtypes
       or v_proc.proallargtypes is distinct from v_contract.proallargtypes
       or v_proc.proargmodes is distinct from v_contract.proargmodes
       or v_proc.proargnames is distinct from v_contract.proargnames
       or v_proc.pronargdefaults is distinct from v_contract.pronargdefaults
       or pg_catalog.pg_get_expr(v_proc.proargdefaults, 0::oid)
            is distinct from v_contract.default_expr
       or v_proc.proconfig is distinct from v_contract.proconfig
       or not pg_catalog.has_function_privilege(
         'service_role', v_proc.oid, 'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon', v_proc.oid, 'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated', v_proc.oid, 'EXECUTE'
       )
       or exists (
         select 1
           from pg_catalog.aclexplode(
             coalesce(
               v_proc.proacl,
               pg_catalog.acldefault('f', v_proc.proowner)
             )
           ) acl
          where acl.grantee = 0::oid
            and acl.privilege_type = 'EXECUTE'
       ) then
      raise exception '0084 postflight: catalog contract changed: %',
        v_contract.signature;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_entry record;
  v_def text;
  v_object_pos integer;
  v_config_pos integer;
  v_user_pos integer;
  v_impl_pos integer;
begin
  for v_entry in
    select *
      from (
        values
          ('public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)', 'object_user'),
          ('public.mark_paid_and_grant(uuid,text,integer,jsonb,timestamptz,text)', 'object_user'),
          ('public.admin_settle_stuck_order(uuid,uuid,text)', 'object_user'),
          ('public.admin_adjust_credits(uuid,uuid,integer,text,uuid)', 'object_user'),
          ('public.create_generation_and_consume(uuid,text)', 'user'),
          ('public.create_generation_row(uuid,text)', 'user'),
          ('public.mark_generation_failed_and_refund(uuid,text,integer)', 'object_user'),
          ('public.expire_generation(uuid,integer)', 'object_user'),
          ('public.reopen_generation_artifact_cleanup(uuid)', 'object_user'),
          ('public.complete_generation_artifact_cleanup(uuid,text)', 'object_user'),
          ('public.admin_refund_begin(uuid,uuid,uuid,uuid,integer,text,timestamptz,text)', 'object_user'),
          ('public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)', 'object_user'),
          ('public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)', 'object_user'),
          ('public.admin_refund_commit(uuid)', 'object_user'),
          ('public.admin_refund_switch_to_manual(uuid,uuid,text,bigint,jsonb,text)', 'object_user'),
          ('public.admin_refund_commit_manual(uuid,uuid,text,text,uuid)', 'object_user'),
          ('public.admin_refund_release(uuid,uuid,text)', 'object_user'),
          ('public.admin_refund_replan_pre_pg(uuid,uuid,text,boolean)', 'object_user'),
          ('public.admin_refund_replan_after_pg(uuid,uuid,text,bigint,jsonb)', 'object_user'),
          ('public.cancel_intent_begin(uuid,uuid,timestamptz,text)', 'object_user'),
          ('public.cancel_intent_resolve(uuid,uuid,integer)', 'object_user'),
          ('public.record_payment_cancellation_observation(uuid,text,text,bigint,timestamptz,timestamptz,jsonb)', 'object_user'),
          ('public.resolve_external_cancellation(text,uuid,text,integer)', 'object_user'),
          ('public.resolve_external_cancellation_auto_full(uuid)', 'object_user'),
          ('public.admin_resolve_reconciliation_issue(uuid,uuid,text,text)', 'object_user'),
          ('public.mark_order_failed(uuid,text,text,jsonb)', 'object_user'),
          ('public.mark_order_canceled_unpaid(uuid,text,text,jsonb)', 'object_user'),
          ('public.admin_cancel_order(uuid,uuid,boolean,text,boolean)', 'object_user'),
          ('public.admin_cancel_order(uuid,uuid,boolean,text)', 'object_user'),
          ('public.sweep_expired(integer)', 'many'),
          ('public.admin_soft_delete_account(uuid)', 'user'),
          ('public.create_or_update_member_consent(uuid,integer,boolean,boolean,integer,boolean,integer)', 'object_user'),
          ('public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)', 'object_user'),
          ('public.sync_active_member_oauth_profile(uuid,text,text,text)', 'user'),
          ('public.admin_reactivate_account(uuid,uuid,text,text)', 'object_user'),
          ('public.admin_ban_member(uuid,uuid,text)', 'user'),
          ('public.admin_unban_member(uuid,uuid,text)', 'user'),
          ('public.request_avatar_clear(uuid)', 'user'),
          ('public.request_avatar_replace(uuid,text,text)', 'user'),
          ('public.reassign_anon_data(uuid,uuid)', 'object_many'),
          ('public.record_reviewer_provision_auth(uuid,uuid,integer,uuid)', 'object'),
          ('public.finalize_reviewer_provision(uuid,uuid,integer)', 'object_user')
      ) as expected(signature, lock_mode)
  loop
    v_def := pg_catalog.pg_get_functiondef(
      v_entry.signature::regprocedure
    );
    v_object_pos := greatest(
      pg_catalog.strpos(v_def, 'public.bp_mutation_object_lock'),
      pg_catalog.strpos(
        v_def, 'public.bp_0084_credit_adjust_request_lock'
      ),
      pg_catalog.strpos(v_def, 'public.bp_0084_legal_consent_locks'),
      pg_catalog.strpos(v_def, 'public.bp_0084_anon_reassign_locks')
    );
    v_user_pos := case
      when v_entry.lock_mode in ('many', 'object_many') then
        pg_catalog.strpos(v_def, 'public.bp_user_mutation_lock_many')
      else
        pg_catalog.strpos(v_def, 'public.bp_user_mutation_lock')
    end;
    v_config_pos := pg_catalog.strpos(
      v_def, 'public.bp_checkout_config_lock'
    );
    v_impl_pos := pg_catalog.strpos(v_def, '_impl(');

    if pg_catalog.strpos(pg_catalog.lower(v_def), 'for update') > 0
       or pg_catalog.strpos(pg_catalog.lower(v_def), 'for key share') > 0 then
      raise exception '0084 postflight: wrapper row-locks before boundary: %',
        v_entry.signature;
    end if;
    if v_entry.signature =
         'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
       and not (
         v_object_pos > 0
         and v_config_pos > v_object_pos
         and v_user_pos > v_config_pos
         and v_impl_pos > v_user_pos
       ) then
      raise exception
        '0084 postflight: checkout object -> config -> user -> impl order invalid';
    end if;
    if v_entry.lock_mode in ('object_user', 'object_many')
       and not (
         v_object_pos > 0
         and v_user_pos > v_object_pos
         and v_impl_pos > v_user_pos
       ) then
      raise exception '0084 postflight: object -> user -> impl order invalid: %',
        v_entry.signature;
    elsif v_entry.lock_mode in ('user', 'many')
       and not (v_user_pos > 0 and v_impl_pos > v_user_pos) then
      raise exception '0084 postflight: user -> impl order invalid: %',
        v_entry.signature;
    elsif v_entry.lock_mode = 'object'
       and not (
         v_object_pos > 0
         and v_impl_pos > v_object_pos
         and pg_catalog.strpos(
           v_def, 'public.bp_user_mutation_lock'
         ) = 0
       ) then
      raise exception '0084 postflight: object-only order invalid: %',
        v_entry.signature;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regprocedure(
       'public.admin_adjust_credits(uuid,uuid,integer,text)'
     ) is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.admin_adjust_credits(uuid,uuid,integer,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.admin_adjust_credits(uuid,uuid,integer,text)',
       'EXECUTE'
     ) then
    raise exception '0084 postflight: rolling credit-adjust compatibility drift';
  end if;
  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_user_mutation_lock(uuid)'::regprocedure
       ),
       $needle$pg_catalog.hashtext('member:' || p_user_id::text)::bigint$needle$
     ) = 0 then
    raise exception '0084 postflight: global member lock namespace drifted';
  end if;
  if (
    select p.proconfig
      from pg_catalog.pg_proc p
     where p.oid = 'public.handle_new_user()'::regprocedure
  ) is distinct from array['search_path=""']::text[] then
    raise exception '0084 postflight: auth profile trigger search_path unsafe';
  end if;

  -- No isolated implementation/core may call a public wrapper. In particular
  -- this prevents user -> second-object inversions introduced by runtime name
  -- resolution in PL/pgSQL or SQL function bodies.
  with wrapper_names(name) as (
    select p.proname
      from bp_0084_external_contract c
      join pg_catalog.pg_proc p
        on p.oid = pg_catalog.to_regprocedure(c.signature)
  ),
  internal_functions as (
    select p.oid, p.oid::regprocedure::text as signature
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (
         p.proname like 'bp\_0084\_%\_impl' escape '\'
         or p.proname in (
           'consume_gen_credit_v2',
           'refund_gen_credit_v2',
           'bp_apply_attempt_commit',
           'bp_apply_attempt_release',
           'bp_apply_external_resolution',
           'bp_create_or_update_member_consent_locked'
         )
       )
  )
  select i.signature || ' -> public.' || w.name
    into v_bad
    from internal_functions i
    cross join wrapper_names w
   where pg_catalog.strpos(
     pg_catalog.pg_get_functiondef(i.oid),
     'public.' || w.name || '('
   ) > 0
   order by i.signature, w.name
   limit 1;
  if v_bad is not null then
    raise exception '0084 postflight: wrapper-to-wrapper edge: %', v_bad;
  end if;

  -- The complete isolated-implementation graph has exactly three nested edges,
  -- all to implementations whose required outer locks are already held:
  -- settle -> paid, 4-arg cancel -> 5-arg cancel, reviewer finalize -> consent.
  with internal_functions as (
    select p.oid, p.proname, p.oid::regprocedure::text as signature
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname like 'bp\_0084\_%\_impl' escape '\'
  ),
  edges as (
    select
      caller.proname as caller,
      callee.proname as callee,
      caller.signature || ' -> ' || callee.signature as edge
      from internal_functions caller
      cross join internal_functions callee
     where caller.oid <> callee.oid
       and pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(caller.oid),
         'public.' || callee.proname || '('
       ) > 0
  ),
  allowed(caller, callee) as (
    values
      (
        'bp_0084_admin_settle_stuck_order_impl',
        'bp_0084_mark_paid_and_grant_impl'
      ),
      (
        'bp_0084_admin_cancel_order_legacy_impl',
        'bp_0084_admin_cancel_order_impl'
      ),
      (
        'bp_0084_finalize_reviewer_provision_impl',
        'bp_0084_create_or_update_member_consent_impl'
      )
  )
  select e.edge
    into v_bad
    from edges e
    left join allowed a
      on a.caller = e.caller and a.callee = e.callee
   where a.caller is null
   order by e.edge
   limit 1;
  if v_bad is not null then
    raise exception '0084 postflight: unexpected internal lock edge: %', v_bad;
  end if;
  if (
    with internal_functions as (
      select p.oid, p.proname
        from pg_catalog.pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname like 'bp\_0084\_%\_impl' escape '\'
    ),
    edges as (
      select caller.proname as caller, callee.proname as callee
        from internal_functions caller
        cross join internal_functions callee
       where caller.oid <> callee.oid
         and pg_catalog.strpos(
           pg_catalog.pg_get_functiondef(caller.oid),
           'public.' || callee.proname || '('
         ) > 0
    )
    select pg_catalog.count(*) from edges
  ) <> 3 then
    raise exception '0084 postflight: isolated implementation graph drifted';
  end if;

  -- Any advisory still present in a renamed implementation is a reentrant
  -- acquisition pre-owned by its wrapper. No other late advisory family is
  -- allowed into this graph.
  select p.oid::regprocedure::text
    into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname like 'bp\_0084\_%\_impl' escape '\'
     and pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(p.oid),
       'pg_advisory_xact_lock'
     ) > 0
     and p.proname not in (
       'bp_0084_admin_adjust_credits_impl',
       'bp_0084_admin_ban_member_impl',
       'bp_0084_admin_unban_member_impl',
       'bp_0084_finalize_reviewer_provision_impl',
       'bp_0084_reassign_anon_data_impl'
     )
   order by p.oid::regprocedure::text
   limit 1;
  if v_bad is not null then
    raise exception '0084 postflight: unowned late advisory: %', v_bad;
  end if;

  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_admin_adjust_credits_impl(uuid,uuid,integer,text,uuid)'::regprocedure
       ),
       'admin:credit-adjust:'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_reassign_anon_data_impl(uuid,uuid)'::regprocedure
       ),
       '7401'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_reassign_anon_data_impl(uuid,uuid)'::regprocedure
       ),
       '7402'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_finalize_reviewer_provision_impl(uuid,uuid,integer)'::regprocedure
       ),
       'legal:terms'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_finalize_reviewer_provision_impl(uuid,uuid,integer)'::regprocedure
       ),
       'legal:privacy'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_create_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
       ),
       'public.bp_checkout_config_lock'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_0084_create_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean)'::regprocedure
       ),
       'public.bp_checkout_user_lock'
     ) = 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.bp_checkout_user_lock(uuid)'::regprocedure
       ),
       $needle$pg_catalog.hashtext('member:' || p_user_id::text)::bigint$needle$
     ) = 0 then
    raise exception '0084 postflight: reentrant advisory proof drifted';
  end if;

  select p.oid::regprocedure::text
    into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (
       p.proname like 'bp\_0084\_%\_impl' escape '\'
       or p.proname in (
         'bp_user_mutation_lock',
         'bp_user_mutation_lock_many',
         'bp_mutation_object_lock',
         'bp_0084_credit_adjust_request_lock',
         'bp_0084_legal_consent_locks',
         'bp_0084_anon_reassign_locks',
         'bp_checkout_config_lock',
         'bp_checkout_user_lock',
         'bp_lock_app_settings_for_checkout'
       )
     )
     and (
       pg_catalog.has_function_privilege(
         'anon', p.oid, 'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'authenticated', p.oid, 'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'service_role', p.oid, 'EXECUTE'
       )
     )
   order by p.oid::regprocedure::text
   limit 1;
  if v_bad is not null then
    raise exception '0084 postflight: internal execute leaked: %', v_bad;
  end if;

  select p.oid::regprocedure::text
    into v_bad
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal
     and p.pronamespace = 'public'::regnamespace
     and p.proname like 'bp\_0084\_%\_impl' escape '\'
   limit 1;
  if v_bad is not null then
    raise exception '0084 postflight: trigger bypasses wrapper: %', v_bad;
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0084_user_mutation_lock_order', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
