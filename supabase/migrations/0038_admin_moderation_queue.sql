-- 0038: 어드민 모더레이션 — 캐릭터 단위 큐 + 신고 일괄 기각
--
-- 적용: Management API query 엔드포인트. 끝에 notify pgrst(신규 RPC 노출). additive(기존 무영향).
-- 신고탭 재편: 신고 1건당 1행 → 신고된/조치된 '캐릭터' 1행. 처리상태 단일축:
--   purged(영구삭제) > hidden(숨김) > pending(대기·미결정 신고 있음) > dismissed(기각·공개유지).
-- 포함 대상: 신고 이력 있는 doll + 숨김/영구삭제된 doll(신고 없이 조치된 것도). RPC 라 PostgREST
--   임베드 모호성 회피(profiles 직접 조인).

-- ── 1. 모더레이션 큐(집계 + 상태 + 신고목록 + 필터 + 페이지) ──
create or replace function public.admin_moderation_queue(
  p_admin_id uuid,
  p_state text,       -- null=전체 / 'pending'|'hidden'|'purged'|'dismissed'
  p_doll_id uuid,
  p_owner_id uuid,
  p_limit int,
  p_offset int
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;

  with cand as (
    select d.id, d.image_url, d.owner_id, d.deleted_at, d.artifacts_purged_at
    from public.dolls d
    where d.deleted_at is not null
       or exists (select 1 from public.content_reports r
                   where r.target_type = 'doll' and r.target_id = d.id)
  ),
  agg as (
    select c.id, c.image_url, c.owner_id, c.deleted_at, c.artifacts_purged_at,
      pr.display_name as owner_name,
      coalesce(rc.report_count, 0) as report_count,
      coalesce(rc.pending_count, 0) as pending_count,
      rc.latest_report_at,
      case
        when c.artifacts_purged_at is not null then 'purged'
        when c.deleted_at is not null then 'hidden'
        when coalesce(rc.pending_count, 0) > 0 then 'pending'
        else 'dismissed'
      end as state
    from cand c
    left join public.profiles pr on pr.id = c.owner_id
    left join lateral (
      select count(*) as report_count,
             count(*) filter (where r.status = 'pending') as pending_count,
             max(r.created_at) as latest_report_at
      from public.content_reports r
      where r.target_type = 'doll' and r.target_id = c.id
    ) rc on true
  ),
  filtered as (
    select a.*, count(*) over() as total
    from agg a
    where (p_state is null or a.state = p_state)
      and (p_doll_id is null or a.id = p_doll_id)
      and (p_owner_id is null or a.owner_id = p_owner_id)
  ),
  page as (
    select * from filtered
    order by coalesce(latest_report_at, deleted_at) desc nulls last, id
    limit greatest(coalesce(p_limit, 10), 1) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', coalesce((select max(total) from filtered), 0),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dollId', p.id,
        'image_url', p.image_url,
        'owner_id', p.owner_id,
        'owner_name', p.owner_name,
        'deleted_at', p.deleted_at,
        'artifacts_purged_at', p.artifacts_purged_at,
        'state', p.state,
        'report_count', p.report_count,
        'pending_count', p.pending_count,
        'latest_report_at', p.latest_report_at,
        'reports', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', r.id, 'reason', r.reason, 'detail', r.detail,
            'contact', r.reporter_contact, 'status', r.status, 'created_at', r.created_at
          ) order by r.created_at desc)
          from public.content_reports r
          where r.target_type = 'doll' and r.target_id = p.id
        ), '[]'::jsonb)
      ) order by coalesce(p.latest_report_at, p.deleted_at) desc nulls last, p.id)
      from page p
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end; $$;
revoke all on function public.admin_moderation_queue(uuid, text, uuid, uuid, int, int) from public, anon, authenticated;
grant execute on function public.admin_moderation_queue(uuid, text, uuid, uuid, int, int) to service_role;

-- ── 2. 신고 일괄 기각(이 캐릭터의 대기중 신고 전부 dismissed, 공개 유지) ──
--   단일 신고 기각(admin_dismiss_report)과 별개 — 캐릭터 단위 UI 용.
create or replace function public.admin_dismiss_doll(
  p_admin_id uuid, p_doll_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;

  update public.content_reports
     set status = 'dismissed', resolved_at = now(), resolved_by = p_admin_id
   where target_type = 'doll' and target_id = p_doll_id and status = 'pending';
  get diagnostics v_n = row_count;

  insert into public.moderation_actions_ledger
    (admin_user_id, action_type, target_type, target_id, reason)
  values (p_admin_id, 'dismiss_report', 'doll', p_doll_id, p_reason);

  return jsonb_build_object('ok', true, 'dismissed', v_n);
end; $$;
revoke all on function public.admin_dismiss_doll(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_dismiss_doll(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
