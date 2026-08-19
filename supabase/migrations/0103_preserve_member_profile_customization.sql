-- 0103: 회원 프로필 커스터마이징 보존 — OAuth 재로그인/재동의가 닉네임·프사를 되돌리지 않게
--
-- 문제: 기존 회원의 OAuth 콜백 sync(bp_0084_sync_active_member_oauth_profile_impl)와
-- 재동의 update 경로(bp_create_or_update_member_consent_locked)가 profiles 를
-- `coalesce(OAuth값, 기존값)` 으로 써서, 마이페이지에서 바꾼 닉네임과 프로필 사진
-- (기본 프사로 되돌린 avatar_url null 포함)이 다음 로그인/재동의 때마다 OAuth
-- 프로필로 초기화됐다.
--
-- 확정 semantics (두 함수 공통):
--   * 신규 가입(consent 의 member INSERT 성공, v_rows > 0): handle_new_user 트리거의
--     랜덤 기본 닉네임을 OAuth 닉/프사로 시드 — 현행 유지.
--   * 기존 회원(재로그인 sync·재동의 update 경로): display_name/avatar_url 불가침.
--     단 탈퇴 스크럽 플레이스홀더('탈퇴한 사용자')가 남아 있으면 재활성 복원을 위해
--     OAuth 값으로 재시드한다(스크럽이 avatar_url 도 null 로 만들므로 이때만 프사도 시드).
--   * member_accounts.email 은 계속 동기화(coalesce(OAuth, 기존)) — 리뷰어 게이트·
--     재활성 판별이 최신 이메일에 의존한다.
--
-- body-only 교체: 시그니처·반환형·ACL·0084 wrapper 의 advisory lock 순서 불변.

-- 기존 회원 OAuth 콜백 sync — 0079 원본이 0084 에서 impl 로 rename 된 함수.
create or replace function public.bp_0084_sync_active_member_oauth_profile_impl(
  p_user_id uuid,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_name text := nullif(pg_catalog.btrim(p_display_name), '');
  v_avatar text := nullif(pg_catalog.btrim(p_avatar_url), '');
  v_email text := nullif(pg_catalog.btrim(p_email), '');
begin
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found or v_profile.deleted_at is not null then
    raise exception 'invalid_account' using errcode = 'P0001';
  end if;
  if v_name is not null and char_length(v_name) > 12
     or v_avatar is not null and char_length(v_avatar) > 2048
     or v_email is not null
        and (
          char_length(v_email) > 320
          or v_email like 'deleted+%@deleted.invalid'
        ) then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;

  perform 1
    from public.member_accounts
   where user_id = p_user_id
   for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  -- 기존 회원의 닉네임·프사는 사용자 소유(마이페이지 편집·기본 프사 복귀 포함) —
  -- OAuth 재로그인은 덮어쓰지 않는다. 탈퇴 스크럽 플레이스홀더만 OAuth 로 재시드
  -- (재활성 직후 상태 복원; OAuth 값이 없으면 플레이스홀더 유지).
  if v_profile.display_name = '탈퇴한 사용자' then
    update public.profiles
       set display_name = coalesce(v_name, display_name),
           avatar_url = coalesce(v_avatar, avatar_url)
     where id = p_user_id;
  end if;
  update public.member_accounts
     set email = coalesce(v_email, email),
         updated_at = clock_timestamp()
   where user_id = p_user_id;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$$;

-- 동의(consent) 원자 RPC 의 locked 구현 — 신규 가입 시드는 유지하고,
-- 재동의(update 경로)에서는 위와 동일한 보존 규칙을 적용한다.
create or replace function public.bp_create_or_update_member_consent_locked(
  p_user_id uuid,
  p_bonus int,
  p_set_age boolean,
  p_set_terms boolean,
  p_terms_ver int,
  p_set_privacy boolean,
  p_privacy_ver int,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_now timestamptz := clock_timestamp();
  v_rows int;
  v_bonus int := greatest(coalesce(p_bonus, 0), 0);
  v_name text := nullif(pg_catalog.btrim(p_display_name), '');
  v_avatar text := nullif(pg_catalog.btrim(p_avatar_url), '');
  v_email text := nullif(pg_catalog.btrim(p_email), '');
  v_current_legal_version int;
begin
  -- Match admin legal mutation lock order (terms -> privacy). The version is
  -- re-read inside this transaction so publish/rollback cannot occur between
  -- HTTP comparison and the persisted consent stamp.
  if p_set_terms then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('legal:terms', 0::bigint)
    );
    select l.version
      into v_current_legal_version
      from public.legal_documents l
     where l.doc_type = 'terms'
       and l.status = 'published'
       and l.effective_date <= (
         clock_timestamp() at time zone 'Asia/Seoul'
       )::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1;
    if not found
       or v_current_legal_version is distinct from p_terms_ver then
      raise exception 'legal_version_changed' using errcode = 'P0001';
    end if;
  end if;
  if p_set_privacy then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('legal:privacy', 0::bigint)
    );
    select l.version
      into v_current_legal_version
      from public.legal_documents l
     where l.doc_type = 'privacy'
       and l.status = 'published'
       and l.effective_date <= (
         clock_timestamp() at time zone 'Asia/Seoul'
       )::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1;
    if not found
       or v_current_legal_version is distinct from p_privacy_ver then
      raise exception 'legal_version_changed' using errcode = 'P0001';
    end if;
  end if;

  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found or v_profile.deleted_at is not null then
    raise exception 'invalid_account' using errcode = 'P0001';
  end if;

  if v_name is not null and char_length(v_name) > 12 then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;
  if v_avatar is not null and char_length(v_avatar) > 2048 then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;
  if v_email is not null
     and (
       char_length(v_email) > 320
       or v_email like 'deleted+%@deleted.invalid'
     ) then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;

  -- Existing rows are locked after the profile. The insert path remains fenced
  -- by the profile lock and the member PK unique constraint.
  perform 1
    from public.member_accounts
   where user_id = p_user_id
   for update;

  insert into public.member_accounts(
    user_id,
    gen_credits,
    email,
    age_confirmed_at,
    terms_agreed_at,
    terms_version,
    privacy_agreed_at,
    privacy_version
  )
  values (
    p_user_id,
    v_bonus,
    v_email,
    case when p_set_age then v_now else null end,
    case when p_set_terms then v_now else null end,
    case when p_set_terms then p_terms_ver else null end,
    case when p_set_privacy then v_now else null end,
    case when p_set_privacy then p_privacy_ver else null end
  )
  on conflict (user_id) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    if v_bonus > 0 then
      insert into public.credit_lots(
        user_id, source, order_uuid, qty, granted_at, expires_at
      )
      values (
        p_user_id,
        'signup_bonus',
        null,
        v_bonus,
        v_now,
        v_now + interval '1 year'
      );
    end if;
  else
    update public.member_accounts
       set age_confirmed_at =
             case
               when p_set_age and age_confirmed_at is null then v_now
               else age_confirmed_at
             end,
           terms_agreed_at =
             case when p_set_terms then v_now else terms_agreed_at end,
           terms_version =
             case when p_set_terms then p_terms_ver else terms_version end,
           privacy_agreed_at =
             case when p_set_privacy then v_now else privacy_agreed_at end,
           privacy_version =
             case
               when p_set_privacy then p_privacy_ver
               else privacy_version
             end,
           email = coalesce(v_email, email),
           reconsent_required = false,
           updated_at = v_now
     where user_id = p_user_id;
  end if;

  if v_name is not null or v_avatar is not null then
    if v_rows > 0 then
      -- 신규 가입: handle_new_user 의 랜덤 기본 닉네임을 OAuth 프로필로 시드(현행 유지).
      update public.profiles
         set display_name = coalesce(v_name, display_name),
             avatar_url = coalesce(v_avatar, avatar_url)
       where id = p_user_id;
    elsif v_profile.display_name = '탈퇴한 사용자' then
      -- 재활성 후 재동의: 탈퇴 스크럽 플레이스홀더만 OAuth 로 재시드.
      update public.profiles
         set display_name = coalesce(v_name, display_name),
             avatar_url = coalesce(v_avatar, avatar_url)
       where id = p_user_id;
    end if;
    -- 그 외 기존 회원의 재동의는 프로필 불가침(사용자 커스터마이징 보존).
  end if;

  return v_rows > 0;
end;
$$;
