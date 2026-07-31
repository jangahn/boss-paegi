-- 0101: 빈 매니페스트 탈퇴 정리의 즉시 스윕 — 재활성 2시간 차단 해소
--
-- 탈퇴 enqueue 가 자산 0 계정에도 final_sweep_after 를 최소 +2h5m 로
-- 강제해, 그 완료를 요구하는 재활성 게이트(account_cleanup_pending)가
-- 항상 2시간 이상 거부됐다(운영 실측: admin.reactivate_begin_fail 8회).
-- 대기의 실근거였던 signed-upload 토큰 ABA 는 계정 스코프 업로드 전 경로의
-- intent-선행 계약(avatar·highlight·doll)이 이미 보증한다 — intent 0 이면
-- 미결 토큰이 존재할 수 없음이 장부로 증명되므로, floor 를 제거하고
-- intent horizon 을 단일 소스로 쓴다. 변경은 아래 함수 재정의의 딱 한 줄
-- (greatest floor → coalesce(v_horizon, now)) 이며 나머지는 008903 원문과
-- 자구 동일. claim/finish 의 horizon 재연장·scrub fence 는 무접촉이라
-- 토큰 ABA 불변식이 그대로 유지된다.

create or replace function public.bp_0084_admin_soft_delete_account_impl(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_existing public.account_deletion_cleanup_jobs%rowtype;
  v_job_id uuid;
  v_manifest jsonb := pg_catalog.jsonb_build_object(
    'dolls', '[]'::jsonb,
    'highlights', '[]'::jsonb,
    'avatar', null
  );
  v_pending_order uuid;
  v_horizon timestamptz;
  lot record;
begin
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_existing
    from public.account_deletion_cleanup_jobs
   where user_id = p_user_id
     and status in ('pending', 'leased')
   order by created_at desc, id desc
   limit 1
   for update;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_existing.id,
      'user_id', p_user_id,
      'cleanup_status', v_existing.status,
      'manifest', v_existing.manifest
    );
  end if;

  if v_profile.deleted_at is not null then
    select *
      into v_existing
      from public.account_deletion_cleanup_jobs
     where user_id = p_user_id
       and status = 'completed'
     order by completed_at desc, id desc
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'job_id', v_existing.id,
        'user_id', p_user_id,
        'cleanup_status', 'completed',
        'manifest', '{}'::jsonb
      );
    end if;
    raise exception 'account_deleted_without_cleanup_job'
      using errcode = 'P0001';
  end if;

  perform 1 from public.orders where user_id = p_user_id for update;
  select order_uuid
    into v_pending_order
    from public.orders
   where user_id = p_user_id
     and status = 'pending'
     and created_at > pg_catalog.now() - interval '30 minutes'
   order by created_at desc
   limit 1
   for update;
  if found then
    raise exception 'payment_pending' using errcode = 'P0001';
  end if;

  perform 1
    from public.order_refund_attempts
   where user_id = p_user_id
   for update;
  perform 1
    from public.refund_requests
   where user_id = p_user_id
   for update;
  perform 1
    from public.reconciliation_issues
   where user_id = p_user_id
   for update;

  if exists (
    select 1
      from public.order_refund_attempts
     where user_id = p_user_id
       and state in (
         'prepared', 'pg_requested', 'pg_pending', 'pg_succeeded',
         'manual_pending', 'manual_review'
       )
  ) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.refund_requests
     where user_id = p_user_id
       and state in ('building', 'prepared', 'processing', 'blocked')
  ) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.reconciliation_issues i
     where i.user_id = p_user_id
       and i.state = 'open'
       and i.type in (
         'economic_over_refund', 'manual_pg_cancel', 'unmatched_cancellation'
       )
  ) then
    raise exception 'open_issue_blocks_delete' using errcode = 'P0001';
  end if;

  v_horizon := public.bp_account_cleanup_intent_horizon(p_user_id);
  insert into public.account_deletion_cleanup_jobs(
    user_id,
    manifest,
    final_sweep_after
  )
  values (
    p_user_id,
    v_manifest,
    -- 0101: final_sweep 은 intent-horizon 단일 소스 — 자산·미결 intent 가
    -- 없는 계정(빈 매니페스트·horizon null)은 즉시 스윕 가능해야 한다.
    -- 고정 2h5m floor 는 그 계정에 어떤 불변식도 보태지 않으면서(토큰 ABA 는
    -- intent-선행 계약이 보증) 재활성만 2시간+ 차단했다(2026-08-01 운영 실측).
    -- intent 보유 계정은 horizon(발급 토큰 만료 지평)이 기존과 동일하게 지배한다.
    coalesce(v_horizon, pg_catalog.clock_timestamp())
  )
  returning id into v_job_id;

  for lot in
    select id, (qty - consumed - refunded - refund_reserved) as avail
      from public.credit_lots
     where user_id = p_user_id
       and expired_at is null
     for update
  loop
    update public.credit_lots
       set expired_at = pg_catalog.now(),
           expiration_reason = 'account_deleted'
     where id = lot.id;
    if lot.avail > 0 then
      update public.member_accounts
         set gen_credits = gen_credits - lot.avail
       where user_id = p_user_id;
    end if;
    perform public.bp_credit_ledger_write(
      p_user_id, -lot.avail, 'expire',
      null, null, lot.id, null, null, null, 'account_deleted'
    );
  end loop;

  update public.score_highlights sh
     set highlight_deleted_at =
           coalesce(sh.highlight_deleted_at, pg_catalog.now())
    from public.scores s
   where sh.score_id = s.id
     and s.owner_id = p_user_id;

  update public.content_reports
     set status = 'actioned',
         resolved_at = pg_catalog.now(),
         resolved_by = null
   where target_type = 'doll'
     and status = 'pending'
     and target_id in (
       select id from public.dolls where owner_id = p_user_id
     );

  update public.profiles
     set deleted_at = coalesce(deleted_at, pg_catalog.now()),
         display_name = '탈퇴한 사용자',
         avatar_url = null
   where id = p_user_id;
  update public.member_accounts
     set email = null,
         gen_credits = 0
   where user_id = p_user_id;

  delete from public.dolls where owner_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'user_id', p_user_id,
    'cleanup_status', 'pending',
    'manifest', v_manifest
  );
end;
$$;
