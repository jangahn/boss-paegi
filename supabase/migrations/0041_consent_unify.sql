-- 0041: 계정 동의 통합 — 신규가입·재활성·레거시·구버전 재동의를 단일 엔드포인트(/api/account/consent)가 호출.
-- member_accounts 의 insert(보너스·stamp) / update(필요 항목만)를 원자적으로 처리하고
-- '실제 신규 insert 여부'(is_new)를 반환 → 보너스·익명데이터 이전을 **신규 insert 1회로만** 보장(라우트가 is_new 로 게이트).
-- 동시 클릭 안전: `insert ... on conflict (user_id) do nothing` 으로 단일 승자만 is_new=true.
-- (Auth API 가 필요한 익명데이터 이전·프로필 시드·익명 정리는 라우트가 is_new 일 때만 수행 — SQL 범위 밖.)

create or replace function public.create_or_update_member_consent(
  p_user_id     uuid,
  p_bonus       int,
  p_set_age     boolean,
  p_set_terms   boolean,
  p_terms_ver   int,
  p_set_privacy boolean,
  p_privacy_ver int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now  timestamptz := now();
  v_rows int;
begin
  -- 검증: 유효·비탈퇴 프로필만(profiles 는 트리거로 익명 포함 항상 존재 → in-between 신규도 통과).
  if not exists (
    select 1 from public.profiles where id = p_user_id and deleted_at is null
  ) then
    raise exception 'invalid_account';
  end if;

  -- 원자적 신규 insert(보너스 + 필요 항목 stamp). 충돌(기존 회원) 시 아무것도 안 함.
  insert into public.member_accounts (
    user_id, gen_credits,
    age_confirmed_at,
    terms_agreed_at, terms_version,
    privacy_agreed_at, privacy_version
  ) values (
    p_user_id, greatest(coalesce(p_bonus, 0), 0),
    case when p_set_age     then v_now else null end,
    case when p_set_terms   then v_now       else null end,
    case when p_set_terms   then p_terms_ver else null end,
    case when p_set_privacy then v_now        else null end,
    case when p_set_privacy then p_privacy_ver else null end
  )
  on conflict (user_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    return true;  -- 실제 신규 insert(보너스 지급) → 라우트가 익명이전·프로필 시드 수행
  end if;

  -- 기존 row: 필요한 항목만 갱신(보너스·이전 없음). age 는 아직 null 일 때만(이미 확인된 연령 보존).
  update public.member_accounts set
    age_confirmed_at   = case when p_set_age and age_confirmed_at is null then v_now else age_confirmed_at end,
    terms_agreed_at    = case when p_set_terms   then v_now        else terms_agreed_at end,
    terms_version      = case when p_set_terms   then p_terms_ver  else terms_version end,
    privacy_agreed_at  = case when p_set_privacy then v_now         else privacy_agreed_at end,
    privacy_version    = case when p_set_privacy then p_privacy_ver else privacy_version end,
    reconsent_required = false,  -- 재활성(0037) 플래그도 동의 완료로 청산
    updated_at         = v_now
  where user_id = p_user_id;

  return false;
end;
$$;

-- 권한: 클라 직접 호출 금지 — 라우트가 세션 검증 후 service_role 로만 호출(I4).
revoke all on function public.create_or_update_member_consent(uuid,int,boolean,boolean,int,boolean,int)
  from public, anon, authenticated;
grant execute on function public.create_or_update_member_consent(uuid,int,boolean,boolean,int,boolean,int)
  to service_role;
