-- 0107_consent_boolean_model_contract.sql
-- 동의 모델 단순화(2026-08-21 운영 결정) 2/2 — contract.
-- 새 앱(8-arg 체인) 배포 완료 후 적용: 구 버전-동의 체인과 버전·재동의 컬럼 제거.

drop function if exists public.create_or_update_member_consent_with_profile(
  uuid, integer, boolean, boolean, integer, boolean, integer, text, text, text);
drop function if exists public.create_or_update_member_consent(
  uuid, integer, boolean, boolean, integer, boolean, integer);
drop function if exists public.bp_0084_create_or_update_member_consent_with_profile_impl(
  uuid, integer, boolean, boolean, integer, boolean, integer, text, text, text);
drop function if exists public.bp_0084_create_or_update_member_consent_impl(
  uuid, integer, boolean, boolean, integer, boolean, integer);
drop function if exists public.bp_create_or_update_member_consent_locked(
  uuid, integer, boolean, boolean, integer, boolean, integer, text, text, text);

create or replace function public.bp_scrub_member_consent_on_delete()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    -- 탈퇴 = 동의·연령확인 전부 초기화(2026-08-21) — 재가입은 신규가입과 동일 플로우.
    update public.member_accounts
       set email = null,
           age_confirmed_at = null,
           terms_agreed_at = null,
           privacy_agreed_at = null,
           updated_at = clock_timestamp()
     where user_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bp_0084_admin_reactivate_account_impl(p_user_id uuid, p_admin uuid, p_reason text, p_email_override text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deleted timestamptz;
  v_provider text;
  v_id_email text;
  v_name text;
  v_avatar text;
  v_email text;
  v_norm text;
begin
  if pg_catalog.char_length(coalesce(p_reason, '')) < 5
     or pg_catalog.char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;

  select p.deleted_at
    into v_deleted
    from public.profiles p
   where p.id = p_user_id
   for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_deleted is null then
    raise exception 'not_withdrawn';
  end if;

  select u.raw_app_meta_data->>'provider'
    into v_provider
    from auth.users u
   where u.id = p_user_id;

  select
    coalesce(i.email, i.identity_data->>'email'),
    coalesce(
      i.identity_data->>'name',
      i.identity_data->>'full_name',
      i.identity_data->>'nickname'
    ),
    coalesce(i.identity_data->>'avatar_url', i.identity_data->>'picture')
    into v_id_email, v_name, v_avatar
   from auth.identities i
   where i.user_id = p_user_id
   order by coalesce(
              pg_catalog.lower(
                coalesce(i.email, i.identity_data->>'email')
              ) not like '%@deleted.invalid',
              false
            ) desc,
            (i.provider <> 'email') desc,
            (i.provider is not distinct from v_provider) desc,
            (
              coalesce(i.email, i.identity_data->>'email') is not null
            ) desc,
            i.created_at desc nulls last,
            i.id desc
   limit 1;

  v_email := nullif(
    pg_catalog.btrim(coalesce(v_id_email, p_email_override)),
    ''
  );
  if pg_catalog.lower(v_email) like '%@deleted.invalid' then
    v_email := nullif(pg_catalog.btrim(p_email_override), '');
  end if;
  if v_email is null then
    raise exception 'identity_email_missing';
  end if;
  v_norm := pg_catalog.lower(v_email);

  if exists (
    select 1
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
     where m.user_id <> p_user_id
       and p.deleted_at is null
       and pg_catalog.lower(pg_catalog.btrim(m.email)) = v_norm
  ) then
    raise exception 'email_conflict';
  end if;

  v_name := nullif(pg_catalog.btrim(coalesce(v_name, '')), '');
  v_name := case
    when v_name is not null then pg_catalog.left(v_name, 12)
    else '사용자'
  end;

  update public.profiles
     set deleted_at = null,
         display_name = v_name,
         avatar_url = v_avatar
   where id = p_user_id;

  update public.member_accounts
     set email = v_email,
         age_confirmed_at = null,
         terms_agreed_at = null,
         privacy_agreed_at = null,
         updated_at = pg_catalog.now()
   where user_id = p_user_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  insert into public.account_admin_actions_ledger(
    admin_user_id,
    action_type,
    target_user_id,
    reason,
    metadata
  )
  values (
    p_admin,
    'account_reactivate',
    p_user_id,
    p_reason,
    pg_catalog.jsonb_build_object(
      'restored_email', v_email,
      'restored_name', v_name,
      'provider', v_provider,
      'email_source',
      case
        when v_id_email is not null
         and pg_catalog.lower(v_id_email) not like '%@deleted.invalid'
        then 'identity'
        else 'override'
      end
    )
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'email', v_email,
    'display_name', v_name
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.bp_complete_account_reactivation_job(p_user_id uuid, p_admin uuid, p_request_id uuid, p_lease_token uuid, p_lease_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_request public.admin_mutation_requests%rowtype;
  v_result jsonb;
  v_expected_deleted_at timestamptz;
  v_expected_withdrawal_generation bigint;
  v_deleted_at timestamptz;
  v_withdrawal_generation bigint;
  v_reason text;
  v_email_override text;
  v_expected_email text;
  v_current_email text;
  v_auth_email text;
  v_auth_meta jsonb;
  v_auth_fence jsonb;
  v_clear_auth_fence boolean := false;
  v_provider text;
  v_identity_email text;
  v_name text;
  v_avatar text;
begin
  -- Durable job row is always the first row lock. Claim/reclaim/fenced finish
  -- use the same order, eliminating job↔receipt lock inversion.
  select *
    into v_job
    from public.account_reactivation_jobs j
   where j.request_id = p_request_id
   for update;
  if not found then
    raise exception 'reactivation_job_not_found' using errcode = 'P0001';
  end if;
  if v_job.admin_user_id is distinct from p_admin
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;

  perform public.bp_admin_mutation_request_lock(p_request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = p_request_id
   for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;
  if v_request.admin_user_id is distinct from p_admin
     or v_request.operation <> 'account_reactivate'
     or v_request.target_key is distinct from p_user_id::text then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  v_expected_deleted_at :=
    (v_request.request_payload->>'expected_deleted_at')::timestamptz;
  v_expected_withdrawal_generation :=
    (v_request.request_payload->>'expected_withdrawal_generation')::bigint;
  v_expected_email := v_request.request_payload->>'resolved_email';
  if v_expected_email is null
     or v_job.expected_deleted_at is distinct from v_expected_deleted_at
     or v_job.expected_withdrawal_generation is distinct from
          v_expected_withdrawal_generation
     or pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email))
          is distinct from
          pg_catalog.lower(pg_catalog.btrim(v_expected_email)) then
    raise exception 'reactivation_receipt_invalid' using errcode = 'P0001';
  end if;
  if v_request.state = 'cancelled' then
    if v_job.status <> 'cancelled' then
      raise exception 'reactivation_job_invalid' using errcode = 'P0001';
    end if;
    return v_request.result
      || pg_catalog.jsonb_build_object('idempotent', true);
  elsif v_request.state = 'completed' then
    if v_job.status <> 'completed' then
      update public.account_reactivation_jobs
         set status = 'completed',
             lease_token = null,
             leased_until = null,
             last_error = null,
             completed_at = coalesce(completed_at, clock_timestamp()),
             updated_at = clock_timestamp()
       where request_id = p_request_id;
    end if;
    return v_request.result
      || pg_catalog.jsonb_build_object('idempotent', true);
  end if;
  if v_request.state <> 'pending' then
    raise exception 'request_aborted' using errcode = 'P0001';
  end if;
  if v_job.cancel_requested_at is not null then
    raise exception 'reactivation_cancellation_requested'
      using errcode = 'P0001';
  end if;

  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
  perform public.bp_user_mutation_lock(p_user_id);

  v_reason := v_request.request_payload->>'reason';
  v_email_override := v_request.request_payload->>'email_override';

  select p.deleted_at, p.withdrawal_generation
    into v_deleted_at, v_withdrawal_generation
    from public.profiles p
   where p.id = p_user_id
   for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is null then
    raise exception 'not_withdrawn' using errcode = 'P0001';
  end if;
  if v_deleted_at is distinct from v_expected_deleted_at then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;
  if v_withdrawal_generation is distinct from
       v_expected_withdrawal_generation then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;

  perform 1
    from public.member_accounts m
   where m.user_id = p_user_id
   for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  -- Supabase Auth updates email identities before auth.users. Take every
  -- identity row in deterministic PK order, then the user row, matching that
  -- order and preventing identity selection from changing between validation
  -- and DB activation.
  perform 1
    from auth.identities i
   where i.user_id = p_user_id
   order by i.id
   for update;
  select pg_catalog.btrim(u.email), u.raw_app_meta_data
    into v_auth_email, v_auth_meta
    from auth.users u
   where u.id = p_user_id
   for update;
  if not found then
    raise exception 'auth_user_missing' using errcode = 'P0001';
  end if;

  -- Revalidate the immutable identity-derived side effect before reporting
  -- the transient GoTrue user-email synchronization state. If both drifted,
  -- the permanent receipt/identity conflict is the actionable root cause;
  -- retrying the Auth write cannot make that changed identity authoritative.
  v_current_email := public.bp_prepare_account_reactivation_email(
    p_user_id,
    v_email_override
  );
  if pg_catalog.lower(pg_catalog.btrim(v_current_email))
       is distinct from pg_catalog.lower(pg_catalog.btrim(v_expected_email)) then
    raise exception 'reactivation_email_changed' using errcode = 'P0001';
  end if;
  if v_auth_email is null
     or pg_catalog.lower(v_auth_email)
          is distinct from pg_catalog.lower(v_expected_email) then
    raise exception 'auth_email_not_synchronized' using errcode = 'P0001';
  end if;
  if (p_lease_token is null) <> (p_lease_version is null) then
    raise exception 'reactivation_fence_incomplete' using errcode = 'P0001';
  end if;
  v_auth_fence :=
    coalesce(v_auth_meta, '{}'::jsonb)->'bp_reactivation_fence';
  if p_lease_token is not null then
    if v_job.status <> 'leased'
       or v_job.lease_token is distinct from p_lease_token
       or v_job.lease_version <> p_lease_version
       or v_job.leased_until <= clock_timestamp() then
      raise exception 'stale_lease' using errcode = 'P0001';
    end if;
    begin
      if pg_catalog.jsonb_typeof(v_auth_fence) is distinct from 'object'
         or v_auth_fence->>'request_id' is distinct from
              v_job.request_id::text
         or v_auth_fence->>'admin_user_id' is distinct from
              v_job.admin_user_id::text
         or v_auth_fence->>'user_id' is distinct from v_job.user_id::text
         or v_auth_fence->>'lease_token' is distinct from
              p_lease_token::text
         or (v_auth_fence->>'lease_version')::integer is distinct from
              p_lease_version
         or v_auth_fence->>'action' is distinct from 'activate'
         or (v_auth_fence->>'expected_deleted_at')::timestamptz
              is distinct from v_job.expected_deleted_at
         or (
              v_auth_fence->>'expected_withdrawal_generation'
            )::bigint is distinct from
              v_job.expected_withdrawal_generation then
        raise exception 'auth_reactivation_fence_invalid'
          using errcode = 'P0001';
      end if;
      v_clear_auth_fence := true;
    exception
      when invalid_text_representation
        or datetime_field_overflow
        or numeric_value_out_of_range then
        raise exception 'auth_reactivation_fence_invalid'
          using errcode = 'P0001';
    end;
  else
    -- During the 0085 expand window an already-deployed server can invoke the
    -- retained no-lease completion after a new worker has armed Auth. Remove
    -- only a fence that is exactly bound to this same immutable operation.
    begin
      v_clear_auth_fence :=
        pg_catalog.jsonb_typeof(v_auth_fence) = 'object'
        and v_auth_fence->>'request_id' = v_job.request_id::text
        and v_auth_fence->>'admin_user_id' =
              v_job.admin_user_id::text
        and v_auth_fence->>'user_id' = v_job.user_id::text
        and v_auth_fence->>'action' = 'activate'
        and (v_auth_fence->>'expected_deleted_at')::timestamptz =
              v_job.expected_deleted_at
        and (
              v_auth_fence->>'expected_withdrawal_generation'
            )::bigint = v_job.expected_withdrawal_generation;
    exception
      when invalid_text_representation
        or datetime_field_overflow
        or numeric_value_out_of_range then
        v_clear_auth_fence := false;
    end;
  end if;
  if v_clear_auth_fence then
    v_auth_meta := coalesce(v_auth_meta, '{}'::jsonb)
      - 'bp_reactivation_fence';
    update auth.users u
       set raw_app_meta_data = v_auth_meta,
           updated_at = clock_timestamp()
     where u.id = p_user_id;
  end if;

  -- Release the lifecycle trigger fence inside this transaction only. If any
  -- subsequent activation/audit/receipt statement fails, the job transition
  -- rolls back with it and every other path remains fenced.
  update public.account_reactivation_jobs
     set status = 'completed',
         lease_token = null,
         leased_until = null,
         last_error = null,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where request_id = p_request_id;

  v_provider := v_auth_meta->>'provider';
  select
    coalesce(i.email, i.identity_data->>'email'),
    coalesce(
      i.identity_data->>'name',
      i.identity_data->>'full_name',
      i.identity_data->>'nickname'
    ),
    coalesce(i.identity_data->>'avatar_url', i.identity_data->>'picture')
    into v_identity_email, v_name, v_avatar
    from auth.identities i
   where i.user_id = p_user_id
   order by coalesce(
              pg_catalog.lower(
                coalesce(i.email, i.identity_data->>'email')
              ) not like '%@deleted.invalid',
              false
            ) desc,
            coalesce(i.provider <> 'email', false) desc,
            (i.provider is not distinct from v_provider) desc,
            (
              coalesce(i.email, i.identity_data->>'email') is not null
            ) desc,
            i.created_at desc nulls last,
            i.id desc
   limit 1;

  v_name := nullif(pg_catalog.btrim(coalesce(v_name, '')), '');
  v_name := case
    when v_name is not null then pg_catalog.left(v_name, 12)
    else '사용자'
  end;

  update public.profiles
     set deleted_at = null,
         display_name = v_name,
         avatar_url = v_avatar
   where id = p_user_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  update public.member_accounts
     set email = v_expected_email,
         age_confirmed_at = null,
         terms_agreed_at = null,
         privacy_agreed_at = null,
         updated_at = pg_catalog.now()
   where user_id = p_user_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  insert into public.account_admin_actions_ledger(
    admin_user_id,
    action_type,
    target_user_id,
    reason,
    metadata
  )
  values (
    p_admin,
    'account_reactivate',
    p_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'restored_email', v_expected_email,
      'restored_name', v_name,
      'provider', v_provider,
      'email_source',
      case
        when v_identity_email is not null
         and pg_catalog.lower(v_identity_email)
               not like '%@deleted.invalid'
        then 'identity'
        else 'override'
      end
    )
  );

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'userId', p_user_id,
    'accountReactivated', true,
    'idempotent', false
  );
  update public.admin_mutation_requests
     set state = 'completed',
         result = v_result,
         completed_at = clock_timestamp()
   where request_id = p_request_id;
  return v_result;
end;
$function$;

alter table public.member_accounts
  drop column if exists terms_version,
  drop column if exists privacy_version,
  drop column if exists reconsent_required;

notify pgrst, 'reload schema';
