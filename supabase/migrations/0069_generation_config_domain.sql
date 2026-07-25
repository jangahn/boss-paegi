-- generation_config 도메인 추가 — 캐릭터 생성(fal-ai/flux-pulid) 파라미터·프롬프트를 어드민 콘텐츠
-- 콘솔에서 편집·버전이력·롤백하도록 이관. app_settings key allowlist 2곳(테이블 CHECK + RPC) 확장.
-- **seed 없음**: 코드 기본값(GENERATION_CONFIG_DEFAULT = 현행 하드코딩 바이트동일)이 폴백이라
--   미설정 상태에서도 현행 동작 그대로(session_limits 선례). 최초 발행부터 이력 시작.
-- 소비는 uncached 강한읽기(getGenerationConfig) 1회 → 발행 즉시 첫 생성부터 반영(SWR 우회).

-- 1) 테이블 key CHECK 확장
alter table public.app_settings drop constraint if exists app_settings_key_check;
alter table public.app_settings add constraint app_settings_key_check
  check (key in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers','site_content','media_config','business_info','generation_config'));

-- 2) 원자 업데이트 RPC allowlist 확장(0061 본문 + generation_config). CAS·감사·동시최초생성 정규화 동일.
create or replace function public.admin_update_app_setting(
  p_key text, p_value jsonb, p_base_version int, p_admin_id uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.app_settings;
  v_new_version int;
begin
  if p_key not in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers','site_content','media_config','business_info','generation_config') then
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
    if p_base_version <> 0 then raise exception 'version_conflict'; end if;
    v_new_version := 1;
    begin
      insert into public.app_settings(key, value, version, updated_by, updated_at)
        values (p_key, p_value, 1, p_admin_id, now());
    exception when unique_violation then
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

notify pgrst, 'reload schema';
