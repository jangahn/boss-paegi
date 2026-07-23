-- business_info 도메인 추가 — 사업자정보(전역 푸터·PG 심사 요건)를 site_content(소개·FAQ)에서 분리해
-- 독립 콘솔 탭·발행단위(CAS)·변경이력으로 관리. app_settings key allowlist 2곳(테이블 CHECK + RPC) 확장
-- + 기존 site_content 발행값의 businessInfo 를 새 key 로 seed. additive.
-- ⚠️ 코드 배포와 동시 적용 필수(0058 선례): 배포된 코드는 business_info 도메인만 읽으므로 seed 없이
--    배포되면 푸터가 코드기본값(미설정=비노출)으로 떨어져 심사 요건 노출이 끊긴다.

-- 1) 테이블 key CHECK 확장
alter table public.app_settings drop constraint if exists app_settings_key_check;
alter table public.app_settings add constraint app_settings_key_check
  check (key in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers','site_content','media_config','business_info'));

-- 2) 원자 업데이트 RPC allowlist 확장(0045 본문 + business_info). CAS·감사·동시최초생성 정규화 동일.
create or replace function public.admin_update_app_setting(
  p_key text, p_value jsonb, p_base_version int, p_admin_id uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old public.app_settings;
  v_new_version int;
begin
  if p_key not in ('marketing_copy','role_content','score_config','badge_catalog','session_limits','growth_levers','site_content','media_config','business_info') then
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

-- 3) 기존 발행값 이관(seed) — site_content 발행값에 businessInfo 가 채워져 있으면 새 key 로 복사.
--    도메인 value 형태 = {"info": {...}} (미설정이면 {} — lib/config/domains/business-info.ts 스키마).
--    site_content 쪽 잔존 businessInfo 키는 zod 파싱이 무시하고 다음 발행 때 자연 소거되므로 여기서 건드리지 않음.
--    seed 는 콘솔 발행이 아니라 이관이므로 audit 행은 남기지 않음(새 탭 이력은 '최초 발행'부터 시작).
insert into public.app_settings (key, value, version, updated_by, updated_at)
select 'business_info',
       jsonb_build_object('info', s.value->'businessInfo'),
       1,
       s.updated_by,
       now()
from public.app_settings s
where s.key = 'site_content'
  and jsonb_typeof(s.value->'businessInfo') = 'object'
on conflict (key) do nothing;

notify pgrst, 'reload schema';
