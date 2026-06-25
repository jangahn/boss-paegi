-- 0035: Phase 2 — 가역 takedown(복구/영구삭제) RPC + 하이라이트 takedown 태깅
--
-- 적용: management API query 엔드포인트(POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN).
--   DDL 을 Management API 로 적용하면 PostgREST 스키마 캐시가 안 도므로 끝에 notify pgrst 동봉(신규 RPC 노출).
-- additive(기존 활성 데이터 무영향). 착수 시 git fetch 로 번호 충돌 재확인.
--
-- 설계: private 버킷 전환(0036)으로 takedown=deleted_at(신규 서명 중단)만으로 가역.
--   - 복구(admin_restore_doll): 이 doll 의 takedown 이 숨긴 하이라이트만 되살림(만료 등 기존 숨김 불간섭).
--     → 그러려면 takedown 이 "어떤 doll 이 숨겼는지" 태깅해야 함 = highlight_deleted_by_doll.
--   - 영구삭제(artifact purge)는 라우트가 storage 객체 제거 후 artifacts_purged_at 세팅(전부 성공 시만).
--     purged 면 객체가 없어 복구 불가 → restore 가 already_purged 로 거절.

-- ── 1. 하이라이트 takedown 태깅 컬럼 ──────────────────────────────────
-- 어떤 doll 의 takedown 이 이 하이라이트를 숨겼는지. 복구 시 "이 doll 이 숨긴 것만" 되살리기 위함.
--   만료(highlight_expires_at) 등 다른 이유로 숨긴 행은 이 값이 null → 복구가 안 건드림.
alter table public.score_highlights add column if not exists highlight_deleted_by_doll uuid;

-- ── 2. takedown RPC 재정의(0034 → cascade 를 "null 인 것만 숨김 + 태깅") ──
create or replace function public.admin_takedown_doll(
  p_admin_id uuid, p_doll_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_doll public.dolls;
  v_targets jsonb;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;

  select * into v_doll from public.dolls where id = p_doll_id for update;
  if not found then raise exception 'doll_not_found'; end if;

  -- 삭제 대상 storage 참조를 {bucket,path} 로 정규화해 수집(영구삭제 라우트가 재사용).
  --   doll 이미지: image_url 이 path(0036 후) 또는 공개 URL(과도기) 둘 다 — regexp 비매치 시 원본(=path) 유지.
  v_targets := (
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select jsonb_build_object(
        'bucket', 'dolls',
        'path', regexp_replace(v_doll.image_url, '^.*/object/public/dolls/', '')
      ) as t
      union all
      select jsonb_build_object('bucket', 'highlights', 'path', sh.highlight_clip_path)
      from public.scores s
      join public.score_highlights sh on sh.score_id = s.id
      where s.doll_id = p_doll_id and sh.highlight_clip_path is not null
    ) q
  );

  -- 이 doll 에 대한 pending 신고는 모두 actioned 로 종료(신규/기존 삭제 무관).
  update public.content_reports
     set status = 'actioned', resolved_at = now(), resolved_by = p_admin_id
   where target_type = 'doll' and target_id = p_doll_id and status = 'pending';

  -- 멱등: 이미 삭제면 상태변경/ledger 없이 대상만 반환.
  if v_doll.deleted_at is not null then
    return jsonb_build_object('ok', true, 'already_deleted', true, 'targets', v_targets);
  end if;

  update public.dolls
     set deleted_at = now(), deleted_by = p_admin_id, deletion_reason = p_reason
   where id = p_doll_id;

  -- cascade: 이 doll 을 쓰는 scores 의 하이라이트 중 **아직 안 숨겨진 것만** 새로 숨기고 이 doll 로 태깅.
  --   (이미 만료 등으로 숨긴 행은 불간섭 → 복구 시 이 doll 이 숨긴 것만 되살리기 위함.)
  update public.score_highlights sh
     set highlight_deleted_at = now(), highlight_deleted_by_doll = p_doll_id
    from public.scores s
   where sh.score_id = s.id and s.doll_id = p_doll_id
     and sh.highlight_deleted_at is null;

  insert into public.moderation_actions_ledger
    (admin_user_id, action_type, target_type, target_id, reason)
  values (p_admin_id, 'takedown_doll', 'doll', p_doll_id, p_reason);

  return jsonb_build_object('ok', true, 'already_deleted', false, 'targets', v_targets);
end; $$;
revoke all on function public.admin_takedown_doll(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_takedown_doll(uuid, uuid, text) to service_role;

-- ── 3. restore RPC — takedown 가역 복구(이 doll 이 숨긴 하이라이트만) ──
create or replace function public.admin_restore_doll(
  p_admin_id uuid, p_doll_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_doll public.dolls;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;

  select * into v_doll from public.dolls where id = p_doll_id for update;
  if not found then raise exception 'doll_not_found'; end if;
  -- 영구삭제(artifact purged)된 건 객체가 없어 복구 불가.
  if v_doll.artifacts_purged_at is not null then raise exception 'already_purged'; end if;
  -- 활성(미삭제) 복구는 무의미 — 멱등(상태변경/ledger 없이 ok).
  if v_doll.deleted_at is null then
    return jsonb_build_object('ok', true, 'already_active', true);
  end if;

  update public.dolls
     set deleted_at = null, deleted_by = null, deletion_reason = null
   where id = p_doll_id;

  -- 이 doll 의 takedown 이 숨긴 하이라이트만 되살림(highlight_deleted_by_doll = 이 doll).
  --   만료 등 다른 이유로 숨긴 행(by_doll null 또는 다른 doll)은 불간섭.
  update public.score_highlights
     set highlight_deleted_at = null, highlight_deleted_by_doll = null
   where highlight_deleted_by_doll = p_doll_id;

  insert into public.moderation_actions_ledger
    (admin_user_id, action_type, target_type, target_id, reason)
  values (p_admin_id, 'restore_doll', 'doll', p_doll_id, p_reason);

  -- 신고는 actioned 유지(복구는 새 결정; pending 되돌리면 재알림 루프).
  return jsonb_build_object('ok', true, 'already_active', false);
end; $$;
revoke all on function public.admin_restore_doll(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_restore_doll(uuid, uuid, text) to service_role;

-- ── 4. ledger action_type CHECK 에 restore_doll/purge_doll 추가 ──
alter table public.moderation_actions_ledger
  drop constraint if exists moderation_actions_ledger_action_type_check;
alter table public.moderation_actions_ledger
  add constraint moderation_actions_ledger_action_type_check
  check (action_type in ('takedown_doll', 'dismiss_report', 'restore_doll', 'purge_doll'));

-- 신규 RPC(admin_restore_doll) PostgREST 노출 — Management API DDL 은 캐시 자동 리로드 안 됨.
notify pgrst, 'reload schema';
