-- 0052: 어드민 무결성 조치 RPC (clear/void/ban/unban)
--
-- 적용: management API query 엔드포인트.
--
-- 각 RPC: security definer · set search_path=public · execute revoke(service_role only) ·
--   is_admin 재검증(defense in depth) · advisory lock(동시 조치 직렬화) ·
--   scores.review_status + score_flags + integrity_actions_ledger 를 한 트랜잭션에서 갱신.
-- 큐/상세 조회는 서버 route(requireAdmin) + admin client(TS)에서 처리 — 여긴 상태변경만.
--
-- 상태 전이: registered/pending → cleared(clear) · * → voided(void) · member banned + 전 점수 voided(ban).
-- unban 은 member status 만 clean, 기존 voided 자동복구 안 함(score 별 clear 별도).

-- clear: 정상 확인 → cleared(공개면 노출). 자동 registered 와 구분(cron 재flag 방지).
create or replace function public.admin_clear_score(p_admin_id uuid, p_score_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prev text;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('score:' || p_score_id::text)::bigint);
  select review_status into v_prev from public.scores where id = p_score_id for update;
  if v_prev is null then raise exception 'score_not_found'; end if;

  update public.scores set review_status = 'cleared' where id = p_score_id;
  insert into public.score_flags (score_id, status, action, reviewed_by, reviewed_at, reason)
  values (p_score_id, 'cleared', 'clear', p_admin_id, now(), p_reason)
  on conflict (score_id) do update
    set status = 'cleared', action = 'clear', reviewed_by = p_admin_id, reviewed_at = now(), reason = p_reason;
  insert into public.integrity_actions_ledger (admin_user_id, action_type, target_type, target_id, reason, meta)
  values (p_admin_id, 'score_clear', 'score', p_score_id, p_reason,
          jsonb_build_object('previous_status', v_prev, 'next_status', 'cleared'));
  return jsonb_build_object('ok', true, 'previousStatus', v_prev, 'nextStatus', 'cleared');
end; $$;
revoke all on function public.admin_clear_score(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_clear_score(uuid, uuid, text) to service_role;

-- void: 무효 → voided(숨김) + 이 점수 기반 뱃지 회수. clean score 직접 void 도 score_flags 생성.
create or replace function public.admin_void_score(p_admin_id uuid, p_score_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prev text; v_badges int;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('score:' || p_score_id::text)::bigint);
  select review_status into v_prev from public.scores where id = p_score_id for update;
  if v_prev is null then raise exception 'score_not_found'; end if;

  update public.scores set review_status = 'voided' where id = p_score_id;
  insert into public.score_flags (score_id, signals, status, action, reviewed_by, reviewed_at, reason)
  values (p_score_id, '[{"id":"MANUAL_VOID","source":"admin"}]'::jsonb, 'voided', 'void', p_admin_id, now(), p_reason)
  on conflict (score_id) do update
    set status = 'voided', action = 'void', reviewed_by = p_admin_id, reviewed_at = now(), reason = p_reason;
  delete from public.user_badges where first_score_id = p_score_id;
  get diagnostics v_badges = row_count;
  insert into public.integrity_actions_ledger (admin_user_id, action_type, target_type, target_id, reason, meta)
  values (p_admin_id, 'score_void', 'score', p_score_id, p_reason,
          jsonb_build_object('previous_status', v_prev, 'next_status', 'voided', 'badges_removed', v_badges));
  return jsonb_build_object('ok', true, 'previousStatus', v_prev, 'nextStatus', 'voided', 'badgesRemoved', v_badges);
end; $$;
revoke all on function public.admin_void_score(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_void_score(uuid, uuid, text) to service_role;

-- ban: 공개 등록 차단 — member banned + 전 점수 voided + 뱃지 회수.
create or replace function public.admin_ban_member(p_admin_id uuid, p_member_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_scores int; v_badges int;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('member:' || p_member_id::text)::bigint);

  update public.member_accounts set abuse_status = 'banned' where user_id = p_member_id;
  update public.scores set review_status = 'voided'
   where owner_id = p_member_id and review_status <> 'voided';
  get diagnostics v_scores = row_count;
  delete from public.user_badges where owner_id = p_member_id;
  get diagnostics v_badges = row_count;
  insert into public.integrity_actions_ledger (admin_user_id, action_type, target_type, target_id, reason, meta)
  values (p_admin_id, 'member_ban', 'member', p_member_id, p_reason,
          jsonb_build_object('scores_voided', v_scores, 'badges_removed', v_badges));
  return jsonb_build_object('ok', true, 'scoresVoided', v_scores, 'badgesRemoved', v_badges);
end; $$;
revoke all on function public.admin_ban_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_ban_member(uuid, uuid, text) to service_role;

-- unban: member status 만 clean. 기존 voided 점수는 자동복구 안 함(score 별 clear 별도).
create or replace function public.admin_unban_member(p_admin_id uuid, p_member_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('member:' || p_member_id::text)::bigint);
  update public.member_accounts set abuse_status = 'clean' where user_id = p_member_id;
  insert into public.integrity_actions_ledger (admin_user_id, action_type, target_type, target_id, reason, meta)
  values (p_admin_id, 'member_unban', 'member', p_member_id, p_reason,
          jsonb_build_object('note', 'scores not auto-restored'));
  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_unban_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_unban_member(uuid, uuid, text) to service_role;
