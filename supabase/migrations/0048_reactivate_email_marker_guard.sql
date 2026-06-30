-- 0048: 재활성 RPC 이메일 복원 하드닝 — 탈퇴 스크럽 marker('deleted+<uid>@deleted.invalid')를 절대 복원 안 함.
--   배경(0037 §3 트랩): admin updateUserById(email=marker) 가 GoTrue 에 confirmed 'email' provider identity
--   (identity_data.email=marker)를 만든다. 0037 의 identity 선택 order-by 는 provider 매칭이 1순위라 통상
--   google 을 골라 실 이메일을 복원하지만, provider 가 비거나 email-identity 가 더 최근이면 marker 를 집어
--   member_accounts.email 에 marker 를 복원할 수 있었다.
--   → 선택 정렬에 (1)non-marker 우선 (2)OAuth identity(provider<>'email') 우선 을 최상위로 추가하고,
--     최종 v_email 이 그래도 marker 면 override 로 폴백(없으면 중단). 그 외 동작은 0037 과 동일.
--   additive — create or replace 함수 1개. 컬럼/데이터 변경 없음. 코드 배포와 함께 적용.

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

  -- 원본 복원값 — **(1)스크럽 marker 가 아닌 이메일 우선 → (2)OAuth identity(=provider<>'email') 우선**
  -- → (3)원래 provider 일치 → (4)이메일 있는 것 → (5)최신. marker 만 있는 email-identity 를 회피.
  select coalesce(i.email, i.identity_data->>'email'),
         coalesce(i.identity_data->>'name', i.identity_data->>'full_name', i.identity_data->>'nickname'),
         coalesce(i.identity_data->>'avatar_url', i.identity_data->>'picture')
    into v_id_email, v_name, v_avatar
  from auth.identities i
  where i.user_id = p_user_id
  order by (coalesce(i.email, i.identity_data->>'email') not like 'deleted+%@deleted.invalid') desc,
           (i.provider <> 'email') desc,
           (i.provider is not distinct from v_provider) desc,
           (coalesce(i.email, i.identity_data->>'email') is not null) desc,
           i.created_at desc
  limit 1;

  -- 이메일: identity 원본 → 없으면 어드민 입력 override → 둘 다 없으면 중단.
  v_email := nullif(btrim(coalesce(v_id_email, p_email_override)), '');
  -- 스크럽 marker 는 실 이메일이 아님 — identity 가 marker 뿐이면 override 로 폴백, 그것도 없으면 중단.
  if v_email like 'deleted+%@deleted.invalid' then
    v_email := nullif(btrim(p_email_override), '');
  end if;
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
                             'email_source', case when v_id_email is not null and v_id_email not like 'deleted+%@deleted.invalid' then 'identity' else 'override' end));

  return jsonb_build_object('ok', true, 'email', v_email, 'display_name', v_name);
end; $$;
revoke all on function public.admin_reactivate_account(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_reactivate_account(uuid, uuid, text, text) to service_role;
