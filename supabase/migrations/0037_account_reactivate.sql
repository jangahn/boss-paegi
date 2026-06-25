-- 0037: 회원 재활성(탈퇴 복구) — 어드민이 본인 요청 시 "계정만" 복구(데이터 미복구).
--   탈퇴(0034 §6 admin_soft_delete_account)는 profiles.deleted_at 세팅·익명화 + member_accounts
--   email=null·gen_credits=0 + dolls 하드삭제 + 하이라이트 차단. auth.users 는 보존(결제 FK RESTRICT).
--   복구 = deleted_at 해제 + auth.identities 원본 닉/프사/이메일 즉시 복원 + 재동의 트리거(약관/방침 동의 클리어).
--   gen_credits(0 유지)·age_confirmed_at(유지)·dolls/하이라이트/Storage(영구삭제, 미복구)는 건드리지 않음.
--   additive only — 신규 RPC 2 + 전용 감사 원장. 기존 동작 영향 0.

-- ── A0. 계정 라이프사이클 전용 감사 원장 ──
--   admin_actions_ledger 는 credit_delta/before/after NOT NULL(결제 원장 UI 가 렌더)이고,
--   moderation_actions_ledger 는 target_type='doll' 전용이라 둘 다 부적합 → 전용 테이블 분리(legal_documents_audit 선례).
create table if not exists public.account_admin_actions_ledger (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.profiles(id),
  action_type text not null check (action_type in ('account_reactivate')),
  target_user_id uuid not null references public.profiles(id),
  reason text not null check (char_length(reason) between 5 and 500),
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table public.account_admin_actions_ledger enable row level security;
revoke all on public.account_admin_actions_ledger from anon, authenticated;  -- 정책 없음 → service_role 만
grant all on public.account_admin_actions_ledger to service_role;
create index if not exists idx_account_admin_ledger_target
  on public.account_admin_actions_ledger(target_user_id, created_at desc);

-- ── A0b. 재동의 필요 플래그 ──
--   "동의 stamp null" 로 게이트하면 동의흐름 이전 생성된 레거시 회원(현재 전원 stamp null)까지
--   잠긴다 → 재활성 전용 명시 플래그로 분리. 재활성만 true → 레거시/신규 회원 무영향.
alter table public.member_accounts
  add column if not exists reconsent_required boolean not null default false;

-- ── A1. 재활성 RPC ──
create or replace function public.admin_reactivate_account(
  p_user_id uuid, p_admin uuid, p_reason text, p_email_override text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_deleted   timestamptz;
  v_provider  text;
  v_id_email  text;
  v_name      text;
  v_avatar    text;
  v_email     text;
  v_norm      text;
begin
  if char_length(coalesce(p_reason, '')) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;

  -- 멱등 가드 — 탈퇴 상태가 아니면 중단.
  select deleted_at into v_deleted from public.profiles where id = p_user_id;
  if not found then raise exception 'not_found'; end if;
  if v_deleted is null then raise exception 'not_withdrawn'; end if;

  select u.raw_app_meta_data->>'provider' into v_provider from auth.users u where u.id = p_user_id;

  -- 원본 복원값 — provider 일치 우선 → 이메일 있는 것 → 최신 identity 1개.
  select coalesce(i.email, i.identity_data->>'email'),
         coalesce(i.identity_data->>'name', i.identity_data->>'full_name', i.identity_data->>'nickname'),
         coalesce(i.identity_data->>'avatar_url', i.identity_data->>'picture')
    into v_id_email, v_name, v_avatar
  from auth.identities i
  where i.user_id = p_user_id
  order by (i.provider is not distinct from v_provider) desc,
           (coalesce(i.email, i.identity_data->>'email') is not null) desc,
           i.created_at desc
  limit 1;

  -- 이메일: identity 원본 → 없으면 어드민 입력 override → 둘 다 없으면 중단.
  v_email := nullif(btrim(coalesce(v_id_email, p_email_override)), '');
  if v_email is null then raise exception 'identity_email_missing'; end if;
  v_norm := lower(v_email);

  -- 다른 활성 계정이 같은 이메일을 쓰면 식별 충돌 → 중단.
  if exists (
    select 1 from public.member_accounts m
    join public.profiles p on p.id = m.user_id
    where m.user_id <> p_user_id
      and p.deleted_at is null
      and lower(btrim(m.email)) = v_norm
  ) then
    raise exception 'email_conflict';
  end if;

  -- 닉네임: 원본(12자 클램프) → 없으면 '사용자'. 아바타: 원본 또는 null.
  v_name := nullif(btrim(coalesce(v_name, '')), '');
  v_name := case when v_name is not null then left(v_name, 12) else '사용자' end;

  update public.profiles
     set deleted_at = null, display_name = v_name, avatar_url = v_avatar
   where id = p_user_id;

  -- email 복원 + 재동의 트리거(플래그 + 동의 클리어). gen_credits·age_confirmed_at 미변경.
  update public.member_accounts
     set email = v_email,
         reconsent_required = true,
         terms_agreed_at = null, privacy_agreed_at = null,
         terms_version = null, privacy_version = null,
         updated_at = now()
   where user_id = p_user_id;

  insert into public.account_admin_actions_ledger
    (admin_user_id, action_type, target_user_id, reason, metadata)
  values (p_admin, 'account_reactivate', p_user_id, p_reason,
          jsonb_build_object('restored_email', v_email, 'restored_name', v_name, 'provider', v_provider,
                             'email_source', case when v_id_email is not null then 'identity' else 'override' end));

  return jsonb_build_object('ok', true, 'email', v_email, 'display_name', v_name);
end; $$;
revoke all on function public.admin_reactivate_account(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_reactivate_account(uuid, uuid, text, text) to service_role;

-- ── A2. 탈퇴자 원본 이메일 검색(스크럽돼 search_members 가 못 찾음) ──
create or replace function public.admin_find_withdrawn_by_email(p_email text)
returns table (user_id uuid, original_email text, deleted_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (p.id)
    p.id,
    coalesce(i.email, i.identity_data->>'email'),
    p.deleted_at,
    u.last_sign_in_at
  from public.profiles p
  join auth.identities i on i.user_id = p.id
  left join auth.users u on u.id = p.id
  where p.deleted_at is not null
    and length(btrim(coalesce(p_email, ''))) >= 3
    and strpos(lower(coalesce(i.email, i.identity_data->>'email', '')), lower(btrim(p_email))) > 0
  order by p.id, p.deleted_at desc
  limit 30;
$$;
revoke all on function public.admin_find_withdrawn_by_email(text) from public, anon, authenticated;
grant execute on function public.admin_find_withdrawn_by_email(text) to service_role;
