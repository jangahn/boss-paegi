-- 0034: 콘텐츠 모더레이션 — 비동의 제3자 얼굴 신고/takedown 능력 (Phase 1)
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN).
-- additive(기존 활성 데이터 무영향). 착수 시 git fetch 로 번호 충돌 재확인(레포 이동 중).
--
-- 설계: takedown = doll soft-delete(deleted_at) + 그 doll 을 쓰는 scores 의 하이라이트 cascade 숨김.
--   Phase 1 은 public 버킷 유지 → 라우트가 storage 객체를 물리삭제(직링크 사망). RPC 는 DB 상태만 책임지고
--   삭제할 {bucket,path} 를 반환. 물리삭제 성공 시 artifacts_purged_at 세팅(라우트), 실패 시 null 유지→cron 재시도.
--   Phase 1 비가역(restore 없음): public 버킷에선 "숨김"만으론 origin 객체가 안 죽기 때문.

-- ── 1. dolls soft-delete + 물리삭제 추적 컬럼 ──────────────────────────
alter table public.dolls add column if not exists deleted_at timestamptz;
-- ⚠️ deleted_by 는 audit 용 plain uuid(FK 안 검). references profiles 를 걸면 dolls 가 profiles 로
--   가는 FK 2개(owner_id+deleted_by)가 되어 PostgREST `profiles(...)` 임베드가 모호해짐
--   → /doll·OG·어드민 모더레이션 null/404(2026-06-25 실장애). 임베드 단일 FK 전제 유지.
alter table public.dolls add column if not exists deleted_by uuid;
alter table public.dolls add column if not exists deletion_reason text;
-- artifacts_purged_at = doll image + 관련 highlight clip 전부 storage 삭제 성공 시각(하나라도 실패면 null).
alter table public.dolls add column if not exists artifacts_purged_at timestamptz;
create index if not exists idx_dolls_deleted on public.dolls(deleted_at) where deleted_at is not null;
-- 물리삭제 미확정(=cron 재시도 대상) 부분 인덱스.
create index if not exists idx_dolls_purge_pending on public.dolls(deleted_at)
  where deleted_at is not null and artifacts_purged_at is null;

-- ── 2. content_reports (신고 접수; 익명 신고 허용 → reporter_user_id nullable) ──
create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('doll')),   -- Phase 1=doll 만
  target_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 40),   -- allowlist 코드(API 검증)
  detail text check (char_length(detail) <= 2000),
  reporter_user_id uuid null references public.profiles(id),    -- 비로그인 신고 → null
  reporter_contact text check (char_length(reporter_contact) <= 200),  -- 선택, admin/이메일 전용
  status text not null check (status in ('pending', 'actioned', 'dismissed')) default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid null references public.profiles(id)
);
alter table public.content_reports enable row level security;
-- 공개 API(service-role) 경유로만 insert. anon/authenticated 직접 접근 차단(신고자 PII 보호).
revoke all on public.content_reports from anon, authenticated;
grant all on public.content_reports to service_role;
create index if not exists idx_content_reports_status on public.content_reports(status, created_at desc);
create index if not exists idx_content_reports_target on public.content_reports(target_type, target_id);

-- ── 3. 모더레이션 감사 원장 (결제용 admin_actions_ledger 와 별도) ──
create table if not exists public.moderation_actions_ledger (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.profiles(id),
  action_type text not null check (action_type in ('takedown_doll', 'dismiss_report')),
  target_type text not null check (target_type in ('doll')),
  target_id uuid not null,
  report_id uuid null references public.content_reports(id),
  reason text not null check (char_length(reason) between 5 and 500),
  metadata jsonb,                              -- 예: storage_remove_failed_paths
  created_at timestamptz not null default now()
);
alter table public.moderation_actions_ledger enable row level security;
revoke all on public.moderation_actions_ledger from anon, authenticated;
grant all on public.moderation_actions_ledger to service_role;
create index if not exists idx_moderation_ledger_created on public.moderation_actions_ledger(created_at desc);
create index if not exists idx_moderation_ledger_target on public.moderation_actions_ledger(target_type, target_id);

-- ── 4. takedown RPC — 멱등, cascade, {bucket,path} 반환 ──
--   라우트가 requireAdmin 후 호출하지만 내부에서도 is_admin 재검증(defense in depth, 0029 패턴).
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

  -- 삭제 대상 storage 참조를 {bucket,path} 로 정규화해 수집(라우트가 public URL 파싱 안 하도록).
  --   doll 이미지: image_url(공개 URL)에서 버킷상대경로 추출. highlight: clip_path(이미 상대경로).
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

  -- 이 doll 에 대한 pending 신고는 (신규/기존 삭제 무관) 모두 actioned 로 종료.
  update public.content_reports
     set status = 'actioned', resolved_at = now(), resolved_by = p_admin_id
   where target_type = 'doll' and target_id = p_doll_id and status = 'pending';

  -- 멱등: 이미 삭제면 상태변경/ledger 없이 대상만 반환(라우트의 물리삭제 재시도 허용).
  if v_doll.deleted_at is not null then
    return jsonb_build_object('ok', true, 'already_deleted', true, 'targets', v_targets);
  end if;

  update public.dolls
     set deleted_at = now(), deleted_by = p_admin_id, deletion_reason = p_reason
   where id = p_doll_id;

  -- cascade: 이 doll 을 쓰는 scores 의 하이라이트 숨김(highlightLive 가 이미 deleted_at 확인).
  update public.score_highlights sh
     set highlight_deleted_at = coalesce(sh.highlight_deleted_at, now())
    from public.scores s
   where sh.score_id = s.id and s.doll_id = p_doll_id;

  insert into public.moderation_actions_ledger
    (admin_user_id, action_type, target_type, target_id, reason)
  values (p_admin_id, 'takedown_doll', 'doll', p_doll_id, p_reason);

  return jsonb_build_object('ok', true, 'already_deleted', false, 'targets', v_targets);
end; $$;
revoke all on function public.admin_takedown_doll(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_takedown_doll(uuid, uuid, text) to service_role;

-- ── 5. dismiss RPC — 신고 기각(콘텐츠 유지, 가역) ──
create or replace function public.admin_dismiss_report(
  p_admin_id uuid, p_report_id uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_report public.content_reports;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;

  select * into v_report from public.content_reports where id = p_report_id for update;
  if not found then raise exception 'report_not_found'; end if;
  if v_report.status <> 'pending' then raise exception 'report_not_pending'; end if;

  update public.content_reports
     set status = 'dismissed', resolved_at = now(), resolved_by = p_admin_id
   where id = p_report_id;

  insert into public.moderation_actions_ledger
    (admin_user_id, action_type, target_type, target_id, report_id, reason)
  values (p_admin_id, 'dismiss_report', v_report.target_type, v_report.target_id, p_report_id, p_reason);

  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_dismiss_report(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_dismiss_report(uuid, uuid, text) to service_role;

-- ── 6. 탈퇴 정책 보강 — admin_soft_delete_account 재정의(0030 → +하이라이트·고아신고) ──
--   탈퇴 시 크레딧 0(전면 스크럽)과 일관되게 하이라이트(얼굴 영상)도 render-block.
--   + 탈퇴로 hard-delete 되는 dolls 의 미처리 신고는 actioned 로 종결(target 사라져 takedown 불가한 고아 방지).
--   clip/이미지 storage 물리삭제는 account/delete 라우트가 best-effort 수행(SQL 불가).
create or replace function public.admin_soft_delete_account(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set deleted_at = coalesce(deleted_at, now()),
         display_name = '탈퇴한 사용자',
         avatar_url = null
   where id = p_user_id;

  update public.member_accounts
     set email = null, gen_credits = 0
   where user_id = p_user_id;

  -- 하이라이트 render-block (highlightLive 가 이미 확인). clip 물리삭제는 라우트.
  update public.score_highlights sh
     set highlight_deleted_at = coalesce(sh.highlight_deleted_at, now())
    from public.scores s
   where sh.score_id = s.id and s.owner_id = p_user_id;

  -- 곧 hard-delete 될 dolls 의 미처리 신고 종결(고아 방지). 시스템 종결이라 resolved_by null.
  update public.content_reports
     set status = 'actioned', resolved_at = now(), resolved_by = null
   where target_type = 'doll' and status = 'pending'
     and target_id in (select id from public.dolls where owner_id = p_user_id);

  -- 캐릭터 row 삭제(얼굴 기반 식별성). scores.doll_id 는 set null(0017). 여러번 안전.
  delete from public.dolls where owner_id = p_user_id;

  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_soft_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.admin_soft_delete_account(uuid) to service_role;
