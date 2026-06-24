-- 0025: 마케터 콘텐츠/설정 콘솔 substrate — app_settings(도메인별 jsonb) + 감사 + 원자 업데이트 RPC.
--
-- 설계:
--  · app_settings = 도메인 key→jsonb 단일 저장소. **server-only**: anon/authenticated 전부 revoke,
--    읽기·쓰기 모두 서버 getter/RPC 에서 service_role 로만. 주 방어선=requireAdmin()+server-only(앱 레이어).
--  · 변경 감사는 **전용 app_settings_audit** 테이블(머니 원장 admin_actions_ledger 는 order/credit NOT NULL
--    스키마라 config 에 부적합 → 오염·제약위반 방지 위해 분리). revert 의 소스이기도.
--  · admin_update_app_setting = CAS(낙관적 version) + 감사 insert 를 **한 트랜잭션**(security definer).
-- additive·무중단(소비자는 코드 기본값과 공존, config 미시드 시 무변경).

create table if not exists public.app_settings (
  key text primary key
    check (key in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers')),
  value jsonb not null,
  version int not null default 1,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;   -- 정책 없음 → 비-service_role 접근 0
grant all on public.app_settings to service_role;

-- 변경 감사 + revert 소스 (운영자 정보 포함 → service_role 전용)
create table if not exists public.app_settings_audit (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  old_value jsonb,
  new_value jsonb not null,
  old_version int,
  new_version int not null,
  admin_user_id uuid not null references public.profiles(id),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);
alter table public.app_settings_audit enable row level security;
revoke all on public.app_settings_audit from anon, authenticated;
grant all on public.app_settings_audit to service_role;
create index if not exists idx_app_settings_audit_key on public.app_settings_audit(key, created_at desc);

-- 원자 업데이트: key allowlist + version CAS + 감사 insert (한 txn). 최초 생성은 base_version=0.
create or replace function public.admin_update_app_setting(
  p_key text, p_value jsonb, p_base_version int, p_admin_id uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.app_settings;
  v_new_version int;
begin
  if p_key not in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers') then
    raise exception 'invalid_key';
  end if;

  select * into v_old from public.app_settings where key = p_key for update;
  if found then
    if v_old.version <> p_base_version then raise exception 'version_conflict'; end if;
    v_new_version := v_old.version + 1;
    update public.app_settings
      set value = p_value, version = v_new_version, updated_by = p_admin_id, updated_at = now()
      where key = p_key;
  else
    if p_base_version <> 0 then raise exception 'version_conflict'; end if;   -- 최초 생성 기대값
    v_new_version := 1;
    begin
      insert into public.app_settings(key, value, version, updated_by, updated_at)
        values (p_key, p_value, 1, p_admin_id, now());
    exception when unique_violation then
      -- 동시 최초생성 경쟁(둘 다 base=0): FOR UPDATE 가 0행을 못 잠그므로 패자는 PK 충돌 →
      -- update_failed 가 아니라 version_conflict 로 정규화(API 409 + 재시도 유도).
      raise exception 'version_conflict';
    end;
  end if;

  insert into public.app_settings_audit
    (key, old_value, new_value, old_version, new_version, admin_user_id, note)
  values (p_key, v_old.value, p_value, v_old.version, v_new_version, p_admin_id, p_note);

  return jsonb_build_object('ok', true, 'key', p_key, 'version', v_new_version);
end; $$;

revoke all on function public.admin_update_app_setting(text, jsonb, int, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_update_app_setting(text, jsonb, int, uuid, text) to service_role;
