-- 0123: 캐릭터 속성(롤·성별) 제어를 어드민 전용으로 (v1.29, PR-D2)
--
-- 결정(2026-09-09): 캐릭터의 롤·성별은 생성 뒤 유저가 바꾸지 못하고 어드민만 바꾼다. 생성 시 역할 선택(입력)은 유지.
--  1) 유저 RPC request_doll_role_update(0079·0120) 폐기 — 갤러리 「역할 변경」 메뉴·PATCH /api/doll 과 함께 제거.
--     이미 바뀐 캐릭터(24개)의 현재 롤은 그대로 둔다(데이터 변경 없음).
--  2) 어드민 RPC 는 "캐릭터 속성" 한 개념으로 통일: admin_update_doll_profile_idempotent(롤+성별, 0085 receipt +
--     dolls.version CAS). 0121 의 성별 전용 admin_update_doll_gender_idempotent 는 여기에 흡수해 폐기.
--  3) admin_mutation_requests.operation 어휘에 doll_profile_update 추가. 구 doll_gender_update 는 이미 저장된 receipt
--     (이력)를 위해 어휘에 남긴다 — 앱은 더 이상 만들지 않는다.

-- ── 1) 유저 롤 변경 RPC 폐기 ─────────────────────────────────────────────────
revoke all on function public.request_doll_role_update(uuid, uuid, text)
  from public, anon, authenticated, service_role;
drop function if exists public.request_doll_role_update(uuid, uuid, text);

-- ── 2) 성별 전용 어드민 RPC 폐기(속성 RPC 로 흡수) ───────────────────────────
drop function if exists public.admin_update_doll_gender_idempotent(uuid, uuid, text, integer, uuid);

-- ── 3) receipt 어휘 ──────────────────────────────────────────────────────────
alter table public.admin_mutation_requests
  drop constraint if exists admin_mutation_requests_operation_check;
alter table public.admin_mutation_requests
  add constraint admin_mutation_requests_operation_check
  check (operation in (
    'config_update', 'event_save', 'event_publish', 'event_unpublish', 'event_delete',
    'moderation_takedown', 'moderation_dismiss', 'moderation_restore', 'moderation_permanent_delete',
    'integrity_clear', 'integrity_void', 'integrity_ban', 'integrity_unban',
    'account_reactivate', 'order_settle',
    'doll_gender_update', -- 0121 이력 전용(앱 미사용)
    'doll_profile_update'
  ));

-- ── 4) 캐릭터 속성(롤·성별) 어드민 RPC — 0085 receipt + dolls.version CAS ─────
CREATE OR REPLACE FUNCTION public.admin_update_doll_profile_idempotent(p_admin_id uuid, p_doll_id uuid, p_role text, p_gender text, p_expected_version integer, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_doll public.dolls%rowtype;
  v_next_version integer;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_doll_id is null then
    raise exception 'target_invalid' using errcode = 'P0001';
  end if;
  if p_role not in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend') then
    raise exception 'invalid_role' using errcode = 'P0001';
  end if;
  if p_gender not in ('male', 'female') then
    raise exception 'gender_invalid' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'version_invalid' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'doll_id', p_doll_id,
    'role', p_role,
    'gender', p_gender,
    'expected_version', p_expected_version
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    'doll_profile_update',
    p_doll_id::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select *
    into v_doll
    from public.dolls d
   where d.id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.artifacts_purged_at is not null then
    raise exception 'already_purged' using errcode = 'P0001';
  end if;
  -- 숨김(takedown) 캐릭터는 모더레이션 큐에서 복구한 뒤에만 속성을 바꾼다.
  if v_doll.deleted_at is not null then
    raise exception 'doll_unavailable' using errcode = 'P0001';
  end if;
  -- dolls.version 은 모든 update 에서 트리거(set_updated_at_and_version)가 +1 — 후처리 CAS 기준.
  if v_doll.version <> p_expected_version then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;

  if v_doll.role = p_role and v_doll.gender = p_gender then
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'previousRole', v_doll.role,
      'nextRole', p_role,
      'previousGender', v_doll.gender,
      'nextGender', p_gender,
      'version', v_doll.version,
      'noOp', true,
      'idempotent', false
    );
  else
    update public.dolls
       set role = p_role,
           gender = p_gender
     where id = p_doll_id;
    select d.version
      into v_next_version
      from public.dolls d
     where d.id = p_doll_id;
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'previousRole', v_doll.role,
      'nextRole', p_role,
      'previousGender', v_doll.gender,
      'nextGender', p_gender,
      'version', v_next_version,
      'noOp', false,
      'idempotent', false
    );
  end if;

  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    'doll_profile_update',
    p_doll_id::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.admin_update_doll_profile_idempotent(uuid, uuid, text, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_update_doll_profile_idempotent(uuid, uuid, text, text, integer, uuid)
  to service_role;

notify pgrst, 'reload schema';
