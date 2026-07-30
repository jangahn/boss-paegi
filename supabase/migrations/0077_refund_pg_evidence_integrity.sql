-- 0077: PortOne 환불 preflight/result 증거의 금액·멱등 무결성
--
-- 문제:
--   admin_refund_mark_pg_requested는 영속 request body가 attempt.amount와 같은지 검사하지 않았고,
--   멱등 재호출도 preflight 5필드 중 body/total만 비교했다. 잘못된 body가 한 번 저장되면 앱 재시도가
--   그 금액을 그대로 PG에 보낼 수 있었다.
--   admin_refund_record_pg_result는 p_cancelled_amount를 받으면서도 무시하고 attempt.amount로 event를
--   만들었다. 따라서 marker가 맞지만 PG 실제 취소액이 계획보다 작거나 큰 SUCCEEDED 응답도
--   pg_succeeded→commit으로 진행할 수 있었다.
--
-- 수정:
--   1) 최초 PG 요청 전에 total/cancelled/cancellable 등식, 원주문 total, 충분한 cancellable,
--      cancellation-id 배열, 정확한 3필드 body를 row lock 아래 검증한다.
--   2) preflight 멱등은 영속된 5필드와 body가 모두 같아야 no_op다.
--   3) SUCCEEDED 결과는 cancelled amount가 양수이고 attempt.amount와 정확히 같아야 한다.
--      검증은 event/attempt/ledger 전이 전에 수행하며, 재호출에도 동일하게 적용한다.
--   4) 기존 cancellation id가 다른 주문·금액·상태에 속하면 match하지 않고 명시 실패한다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
declare
  v_mark_def text;
  v_record_def text;
begin
  if to_regprocedure(
       'public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)'
     ) is null
     or to_regprocedure(
       'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)'
     ) is null then
    raise exception '0077 preflight: refund PG RPC missing';
  end if;
  if to_regclass('public.order_refund_attempts') is null
     or to_regclass('public.payment_cancellation_events') is null then
    raise exception '0077 preflight: refund evidence tables missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)'::regprocedure
         )
    into v_mark_def;
  if pg_catalog.strpos(v_mark_def, 'if a.state not in (''prepared'')') = 0 then
    raise exception '0077 preflight: 0067 mark_pg_requested contract missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)'::regprocedure
         )
    into v_record_def;
  if pg_catalog.strpos(v_record_def, 'pg_succeeded') = 0 then
    raise exception '0077 preflight: record_pg_result contract missing';
  end if;
end;
$$;

create or replace function public.admin_refund_mark_pg_requested(
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
as $function$
declare
  a public.order_refund_attempts;
  v_expected_body jsonb;
begin
  select *
    into a
    from public.order_refund_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'attempt_not_found' using errcode = 'P0001';
  end if;

  v_expected_body := pg_catalog.jsonb_build_object(
    'amount', a.amount,
    'reason', 'BP_REFUND:' || a.id::text,
    'currentCancellableAmount', p_cancellable_before
  );

  -- PortOne fresh snapshot과 영속 body는 하나의 원자 증거다. null/범위/부분 필드는 허용하지 않는다.
  if p_total_before is null
     or p_cancelled_before is null
     or p_cancellable_before is null
     or p_total_before <> a.order_amount_snapshot
     or p_cancelled_before < 0
     or p_cancellable_before < a.amount
     or p_cancelled_before::numeric + p_cancellable_before::numeric
          <> p_total_before::numeric
     or pg_catalog.jsonb_typeof(p_cancellation_ids_before) is distinct from 'array'
     or p_request_body is distinct from v_expected_body then
    raise exception 'refund_preflight_mismatch' using errcode = 'P0001';
  end if;

  -- 이미 PG 경계에 진입한 경우에는 5개 preflight 필드와 exact body가 모두 같아야 멱등이다.
  if a.state in ('pg_requested', 'pg_pending', 'pg_succeeded') then
    if a.pg_total_before = p_total_before
       and a.pg_cancelled_before = p_cancelled_before
       and a.pg_cancellable_before = p_cancellable_before
       and a.pg_cancellation_ids_before = p_cancellation_ids_before
       and a.pg_request_body = p_request_body then
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
  if a.rail <> 'portone_cancel' then
    raise exception 'rail_not_pg' using errcode = 'P0001';
  end if;

  update public.order_refund_attempts
     set state = 'pg_requested',
         pg_total_before = p_total_before,
         pg_cancelled_before = p_cancelled_before,
         pg_cancellable_before = p_cancellable_before,
         pg_cancellation_ids_before = p_cancellation_ids_before,
         pg_preflight_at = clock_timestamp(),
         pg_idempotency_key = a.id::text,
         pg_requested_at = clock_timestamp(),
         pg_request_body = p_request_body
   where id = p_attempt_id;

  update public.refund_requests
     set state = 'processing'
   where id = a.request_id
     and state = 'prepared';

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'pg_requested',
    'attempt_id', p_attempt_id
  );
end;
$function$;

revoke all on function public.admin_refund_mark_pg_requested(
  uuid, bigint, bigint, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_mark_pg_requested(
  uuid, bigint, bigint, bigint, jsonb, jsonb
) to service_role;

create or replace function public.admin_refund_record_pg_result(
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
as $function$
declare
  a public.order_refund_attempts;
  ev public.payment_cancellation_events;
  v_rows int;
begin
  select *
    into a
    from public.order_refund_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'attempt_not_found' using errcode = 'P0001';
  end if;
  if p_result not in ('succeeded', 'pending', 'failed') then
    raise exception 'result_invalid' using errcode = 'P0001';
  end if;

  -- 성공 증거는 멱등 분기보다 먼저 매번 검증한다. mismatch 호출은 기존 pg_succeeded에도 no_op가 아니다.
  if p_result = 'succeeded' then
    if p_cancel_id is null
       or char_length(p_cancel_id) < 1
       or char_length(p_cancel_id) > 256 then
      raise exception 'cancel_id_required' using errcode = 'P0001';
    end if;
    if p_cancel_status is distinct from 'SUCCEEDED' then
      raise exception 'cancellation_status_mismatch' using errcode = 'P0001';
    end if;
    if p_cancelled_amount is null
       or p_cancelled_amount <= 0
       or p_cancelled_amount <> a.amount then
      raise exception 'cancellation_amount_mismatch' using errcode = 'P0001';
    end if;
  end if;

  -- 동일 성공 증거 재호출만 no_op. 위 금액 검증을 통과했으므로 잘못된 금액은 여기 도달하지 않는다.
  if a.state = 'pg_succeeded' then
    if p_result = 'succeeded'
       and a.pg_cancel_id = p_cancel_id
       and a.pg_cancel_status = 'SUCCEEDED' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'no_op',
        'idempotent', true
      );
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  if a.state not in ('pg_requested', 'pg_pending') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;

  if p_result = 'pending' then
    if p_cancelled_amount is not null then
      raise exception 'cancellation_amount_mismatch' using errcode = 'P0001';
    end if;
    if a.state = 'pg_requested' then
      update public.order_refund_attempts
         set state = 'pg_pending',
             pg_cancel_status = 'REQUESTED',
             pg_raw = p_raw,
             last_reconciled_at = clock_timestamp()
       where id = p_attempt_id;
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'pending');

  elsif p_result = 'succeeded' then
    -- 동일 cancellation id가 사전 관측으로 이미 있으면 exact order/amount/status만 자기 attempt에 귀속한다.
    insert into public.payment_cancellation_events (
      cancellation_id,
      order_uuid,
      status,
      amount,
      requested_at,
      cancelled_at,
      origin,
      resolution_state,
      observed_raw
    )
    values (
      p_cancel_id,
      a.order_uuid,
      'SUCCEEDED',
      p_cancelled_amount,
      p_requested_at,
      p_cancelled_at,
      'live',
      'unmatched',
      p_raw
    )
    on conflict (cancellation_id) do nothing;

    select *
      into ev
      from public.payment_cancellation_events
     where cancellation_id = p_cancel_id
     for update;
    if not found
       or ev.order_uuid <> a.order_uuid
       or ev.amount <> p_cancelled_amount
       or ev.status <> 'SUCCEEDED'
       or (
         ev.resolution_state <> 'unmatched'
         and not (
           ev.resolution_state = 'matched'
           and ev.matched_attempt_id = p_attempt_id
         )
       ) then
      raise exception 'cancellation_event_conflict' using errcode = 'P0001';
    end if;

    update public.order_refund_attempts
       set state = 'pg_succeeded',
           pg_cancel_id = p_cancel_id,
           pg_cancel_status = 'SUCCEEDED',
           pg_raw = p_raw,
           cancellation_receipt_url = p_receipt_url,
           last_reconciled_at = clock_timestamp()
     where id = p_attempt_id;

    update public.payment_cancellation_events
       set resolution_state = 'matched',
           matched_attempt_id = p_attempt_id
     where cancellation_id = p_cancel_id
       and order_uuid = a.order_uuid
       and amount = p_cancelled_amount
       and status = 'SUCCEEDED'
       and (
         resolution_state = 'unmatched'
         or (
           resolution_state = 'matched'
           and matched_attempt_id = p_attempt_id
         )
       );
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'cancellation_event_conflict' using errcode = 'P0001';
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'pg_succeeded',
      'cancellation_id', p_cancel_id
    );

  else
    -- failed → manual_review. FAILED event는 switch_to_manual의 fresh 무이동 증거가 종결한다.
    update public.order_refund_attempts
       set state = 'manual_review',
           pg_cancel_status = coalesce(p_cancel_status, 'FAILED'),
           pg_raw = p_raw,
           last_reconciled_at = clock_timestamp()
     where id = p_attempt_id;
    update public.refund_requests
       set state = 'blocked'
     where id = a.request_id
       and state <> 'blocked';
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'manual_review'
    );
  end if;
end;
$function$;

revoke all on function public.admin_refund_record_pg_result(
  uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.admin_refund_record_pg_result(
  uuid, text, text, text, bigint, text, jsonb, timestamptz, timestamptz
) to service_role;

do $$
declare
  v_mark_def text;
  v_record_def text;
begin
  select pg_catalog.pg_get_functiondef(
           'public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)'::regprocedure
         )
    into v_mark_def;
  select pg_catalog.pg_get_functiondef(
           'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)'::regprocedure
         )
    into v_record_def;

  if pg_catalog.strpos(v_mark_def, 'refund_preflight_mismatch') = 0
     or pg_catalog.strpos(v_mark_def, 'a.pg_cancelled_before = p_cancelled_before') = 0 then
    raise exception '0077 postflight: exact preflight contract missing';
  end if;
  if pg_catalog.strpos(v_record_def, 'p_cancelled_amount <> a.amount') = 0
     or pg_catalog.strpos(v_record_def, 'cancellation_event_conflict') = 0 then
    raise exception '0077 postflight: cancellation amount/evidence contract missing';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.admin_refund_mark_pg_requested(uuid,bigint,bigint,bigint,jsonb,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.admin_refund_record_pg_result(uuid,text,text,text,bigint,text,jsonb,timestamptz,timestamptz)',
       'EXECUTE'
     ) then
    raise exception '0077 postflight: refund PG RPC ACL drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0077_refund_pg_evidence_integrity', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
