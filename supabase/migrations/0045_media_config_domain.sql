-- media_config 도메인 추가 — 기본 OG 이미지·서비스 로고를 app_settings 콘솔(어드민 편집·수정내역)로 관리.
-- app_settings key allowlist 2곳(테이블 CHECK + RPC)에 'media_config' 추가. additive·무중단.
-- 저장값은 site-assets(public) 버킷의 path 문자열만(URL 아님). 버킷 자체는 대시보드/Management API 로
-- 수동 생성(events 버킷과 동일 방식 — SQL 마이그 아님). 여기선 path 를 담을 key 만 허용 추가.

-- 1) 테이블 key CHECK 확장
alter table public.app_settings drop constraint if exists app_settings_key_check;
alter table public.app_settings add constraint app_settings_key_check
  check (key in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers','site_content','media_config'));

-- 2) 원자 업데이트 RPC allowlist 확장(0040 본문 + media_config). CAS·감사·동시최초생성 정규화 동일.
create or replace function public.admin_update_app_setting(
  p_key text, p_value jsonb, p_base_version int, p_admin_id uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.app_settings;
  v_new_version int;
begin
  if p_key not in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers','site_content','media_config') then
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
