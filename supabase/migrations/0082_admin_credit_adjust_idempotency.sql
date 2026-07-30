-- 0082: 관리자 크레딧 조정을 exactly-once 요청으로 승격한다.
--
-- 기존 4-인자 admin_adjust_credits는 행 잠금으로 동시 실행을 직렬화하지만, 응답이 유실된 뒤
-- 관리자가 같은 조정을 다시 제출하면 서로 다른 정상 트랜잭션으로 간주해 잔액을 두 번 바꾼다.
-- 요청 UUID별 영구 영수증을 금융 변경과 같은 트랜잭션에 기록하고, 상태 확인도 같은 advisory
-- lock을 잡도록 해 적용 POST/복구 요청의 도착 순서까지 직렬화한다.
--
-- 복구 요청이 아직 도착하지 않은 적용 POST보다 먼저 실행된 경우에는 aborted 표식을 남긴다. 따라서
-- 늦게 도착한 POST가 그 UUID로 크레딧을 바꾸는 일도 없다. 완료/중단 표식은 재시도 가능 기간과
-- 무관하게 영구 보존한다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create table public.admin_operation_receipts (
  request_id uuid primary key,
  admin_user_id uuid not null references public.profiles(id) on delete restrict,
  target_user_id uuid not null references public.profiles(id) on delete restrict,
  operation text not null check (operation in ('credit_adjust')),
  state text not null check (state in ('completed', 'aborted')),
  request_payload jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  constraint admin_operation_receipts_payload_shape check (
    (
      state = 'completed'
      and request_payload is not null
      and pg_catalog.jsonb_typeof(request_payload) = 'object'
      and result is not null
      and pg_catalog.jsonb_typeof(result) = 'object'
    )
    or (
      state = 'aborted'
      and request_payload is null
      and result is null
    )
  ),
  constraint admin_operation_receipts_payload_size check (
    request_payload is null
    or pg_catalog.octet_length(request_payload::text) <= 4096
  ),
  constraint admin_operation_receipts_result_size check (
    result is null
    or pg_catalog.octet_length(result::text) <= 4096
  )
);

comment on table public.admin_operation_receipts is
  '관리자 변경 요청의 영구 exactly-once 영수증/중단 표식. 쓰기는 전용 SECURITY DEFINER RPC만 수행.';

alter table public.admin_operation_receipts enable row level security;
revoke all on table public.admin_operation_receipts
  from public, anon, authenticated, service_role;
grant select on table public.admin_operation_receipts to service_role;

create trigger trg_admin_operation_receipts_freeze
  before update or delete on public.admin_operation_receipts
  for each row execute function public.ledger_append_only_guard();

create index idx_admin_operation_receipts_admin_created
  on public.admin_operation_receipts (admin_user_id, created_at desc);

create unique index uq_admin_ledger_credit_adjust_request
  on public.admin_actions_ledger ((metadata->>'request_id'))
  where action_type = 'cs_adjust' and metadata ? 'request_id';

-- 무중단 expand 단계: 새 5-인자 exactly-once RPC를 추가하되, 앱 교체가 끝날 때까지
-- 구 서버가 호출하는 4-인자 RPC의 service_role 권한은 유지한다. 공개/브라우저 역할은
-- 계속 차단한다. 0087 contract migration이 앱 배포 뒤 legacy entry point를 제거한다.
revoke all on function public.admin_adjust_credits(uuid, uuid, int, text)
  from public, anon, authenticated;
grant execute on function public.admin_adjust_credits(uuid, uuid, int, text)
  to service_role;

create or replace function public.admin_adjust_credits(
  p_admin uuid,
  p_target uuid,
  p_delta int,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.admin_operation_receipts;
  v_payload jsonb;
  v_result jsonb;
  v_before int;
  v_after int;
  v_deleted_at timestamptz;
  v_apply int;
  v_remaining int;
  v_take int;
  lot record;
begin
  if p_request_id is null then
    raise exception 'request_id_invalid' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
      from public.member_accounts
     where user_id = p_admin
       and is_admin = true
  ) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(coalesce(p_reason, '')) < 5
     or pg_catalog.char_length(p_reason) > 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  if p_delta is null or p_delta < -100 or p_delta > 100 or p_delta = 0 then
    raise exception 'delta_invalid' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'target_user_id', p_target,
    'delta', p_delta,
    'reason', p_reason
  );

  -- POST와 복구 조회가 같은 키에서 반드시 한 줄로 실행된다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'admin:credit-adjust:' || p_request_id::text,
      0
    )
  );

  select *
    into v_receipt
    from public.admin_operation_receipts
   where request_id = p_request_id;

  if found then
    if v_receipt.admin_user_id is distinct from p_admin
       or v_receipt.target_user_id is distinct from p_target
       or v_receipt.operation <> 'credit_adjust' then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    if v_receipt.state = 'aborted' then
      raise exception 'request_aborted' using errcode = 'P0001';
    end if;
    if v_receipt.request_payload is distinct from v_payload then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return v_receipt.result
      || pg_catalog.jsonb_build_object('idempotent', true);
  end if;

  -- 탈퇴와 같은 global lock order: profile → member/credit lots. 조정이 먼저면 탈퇴가
  -- 완료 뒤 새 로트를 함께 quarantine하고, 탈퇴가 먼저면 조정은 account_deleted로 끝난다.
  select deleted_at
    into v_deleted_at
    from public.profiles
   where id = p_target
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  select gen_credits
    into v_before
    from public.member_accounts
   where user_id = p_target
   for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  if p_delta > 0 then
    insert into public.credit_lots
      (user_id, source, order_uuid, qty, granted_at, expires_at)
    values
      (p_target, 'cs_grant', null, p_delta, now(), now() + interval '1 year');

    update public.member_accounts
       set gen_credits = gen_credits + p_delta
     where user_id = p_target
     returning gen_credits into v_after;
  else
    v_apply := least(-p_delta, v_before);
    v_remaining := v_apply;
    for lot in
      select id, (qty - consumed - refunded - refund_reserved) as avail
        from public.credit_lots
       where user_id = p_target
         and expired_at is null
         and (qty - consumed - refunded - refund_reserved) > 0
       order by expires_at asc, granted_at asc, id asc
       for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, lot.avail);
      update public.credit_lots
         set consumed = consumed + v_take
       where id = lot.id;
      v_remaining := v_remaining - v_take;
    end loop;
    if v_remaining <> 0 then
      raise exception 'credit_lot_balance_mismatch' using errcode = 'P0001';
    end if;

    update public.member_accounts
       set gen_credits = greatest(0, gen_credits - v_apply)
     where user_id = p_target
     returning gen_credits into v_after;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'before', v_before,
    'after', v_after,
    'applied', v_after - v_before,
    'requested', p_delta,
    'idempotent', false
  );

  insert into public.admin_actions_ledger (
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
    'cs_adjust',
    p_target,
    null,
    v_after - v_before,
    null,
    v_before,
    v_after,
    p_reason,
    pg_catalog.jsonb_build_object(
      'requested_delta', p_delta,
      'clamped', (v_after <> v_before + p_delta),
      'request_id', p_request_id
    )
  );

  insert into public.admin_operation_receipts (
    request_id,
    admin_user_id,
    target_user_id,
    operation,
    state,
    request_payload,
    result
  )
  values (
    p_request_id,
    p_admin,
    p_target,
    'credit_adjust',
    'completed',
    v_payload,
    v_result
  );

  return v_result;
end;
$$;

revoke all on function public.admin_adjust_credits(uuid, uuid, int, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_adjust_credits(uuid, uuid, int, text, uuid)
  to service_role;

create or replace function public.get_admin_credit_adjust_receipt(
  p_admin uuid,
  p_request_id uuid,
  p_target uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.admin_operation_receipts;
begin
  if p_request_id is null then
    raise exception 'request_id_invalid' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
      from public.member_accounts
     where user_id = p_admin
       and is_admin = true
  ) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
      from public.profiles
     where id = p_target
  ) then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  -- 진행 중 POST가 있으면 그 트랜잭션이 commit/rollback될 때까지 기다린 뒤 결과를 판정한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'admin:credit-adjust:' || p_request_id::text,
      0
    )
  );

  select *
    into v_receipt
    from public.admin_operation_receipts
   where request_id = p_request_id;

  if found then
    if v_receipt.admin_user_id is distinct from p_admin
       or v_receipt.target_user_id is distinct from p_target
       or v_receipt.operation <> 'credit_adjust' then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    if v_receipt.state = 'completed' then
      return pg_catalog.jsonb_build_object(
        'found', true,
        'aborted', false,
        'result', v_receipt.result
          || pg_catalog.jsonb_build_object('idempotent', true)
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'found', false,
      'aborted', true
    );
  end if;

  -- 조회가 POST보다 먼저 도착한 역순 네트워크. 늦은 POST가 적용되지 않도록 tombstone을 남긴다.
  insert into public.admin_operation_receipts (
    request_id,
    admin_user_id,
    target_user_id,
    operation,
    state,
    request_payload,
    result
  )
  values (
    p_request_id,
    p_admin,
    p_target,
    'credit_adjust',
    'aborted',
    null,
    null
  );

  return pg_catalog.jsonb_build_object(
    'found', false,
    'aborted', true
  );
end;
$$;

revoke all on function public.get_admin_credit_adjust_receipt(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_credit_adjust_receipt(uuid, uuid, uuid)
  to service_role;

do $$
begin
  if not (
    has_function_privilege(
      'service_role',
      'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.admin_adjust_credits(uuid,uuid,integer,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.get_admin_credit_adjust_receipt(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.admin_adjust_credits(uuid,uuid,integer,text)',
      'EXECUTE'
    )
  ) then
    raise exception '0082 postflight: admin adjustment function ACL drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0082_admin_credit_adjust_idempotency', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
