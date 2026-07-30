-- 0083: reviewer Auth <-> database durable convergence saga.
--
-- GoTrue admin mutations and Postgres cannot share a transaction. The former
-- route attempted an immediate compensation, but a second dependency failure
-- could leave:
--   * an orphan reviewer Auth user after create,
--   * DB active state different from Auth ban state after toggle/delete, or
--   * a response-loss retry that creates another logical account.
--
-- This migration makes every cross-system intent durable before GoTrue is
-- called. `auth_sync_pending` is part of the payment classification boundary:
-- while external state is uncertain, checkout must fail closed. Lease fencing
-- makes route and cron workers safely retry the same job.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if to_regclass('public.reviewer_accounts') is null
     or to_regprocedure('public.bp_assert_active_admin(uuid)') is null
     or to_regprocedure(
       'public.create_or_update_member_consent(uuid,integer,boolean,boolean,integer,boolean,integer)'
     ) is null then
    raise exception '0083 preflight: reviewer/admin/consent dependencies missing';
  end if;
end;
$$;

alter table public.reviewer_accounts
  add column auth_sync_pending boolean not null default false;

comment on column public.reviewer_accounts.auth_sync_pending is
  'True while a durable GoTrue ban/unban/delete convergence job is unfinished. Payment classification must fail closed.';

create table public.reviewer_account_jobs (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  action text not null check (
    action in ('provision', 'set_active', 'reset_password', 'delete')
  ),
  status text not null default 'pending' check (
    status in ('pending', 'leased', 'completed', 'failed')
  ),
  user_id uuid,
  email text not null check (
    char_length(email) between 3 and 320
    and email = lower(btrim(email))
  ),
  note text check (note is null or char_length(note) <= 2000),
  desired_active boolean,
  request_payload jsonb not null check (
    jsonb_typeof(request_payload) = 'object'
    and octet_length(request_payload::text) <= 8192
  ),
  created_by uuid not null references public.profiles(id) on delete restrict,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_version integer not null default 0 check (lease_version >= 0),
  lease_token uuid,
  leased_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text check (
    last_error is null or char_length(last_error) <= 500
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint reviewer_job_action_shape check (
    (action = 'set_active' and user_id is not null and desired_active is not null)
    or
    (action = 'delete' and user_id is not null and desired_active is null)
    or
    (action = 'reset_password' and user_id is not null and desired_active is null)
    or
    (action = 'provision' and desired_active is null)
  ),
  constraint reviewer_job_lease_shape check (
    (
      status = 'leased'
      and lease_token is not null
      and leased_until is not null
    )
    or
    (
      status <> 'leased'
      and lease_token is null
      and leased_until is null
    )
  ),
  constraint reviewer_job_completion_shape check (
    (status in ('completed', 'failed') and completed_at is not null)
    or
    (status in ('pending', 'leased') and completed_at is null)
  )
);

comment on table public.reviewer_account_jobs is
  'Durable, fenced reviewer provisioning and GoTrue ban-state convergence jobs. Contains no password or credential secret.';

alter table public.reviewer_account_jobs enable row level security;
revoke all on table public.reviewer_account_jobs
  from public, anon, authenticated, service_role;

create unique index uq_reviewer_job_active_user
  on public.reviewer_account_jobs(user_id)
  where user_id is not null and status in ('pending', 'leased');
create unique index uq_reviewer_job_active_email
  on public.reviewer_account_jobs(lower(email))
  where status in ('pending', 'leased');
create index idx_reviewer_job_claim
  on public.reviewer_account_jobs(next_attempt_at, created_at, id)
  where status in ('pending', 'leased');

-- Exact operation replay. The full canonical request is compared, never only a
-- digest, so correctness does not depend on collision resistance.
create or replace function public.bp_reviewer_job_replay(
  p_operation_id uuid,
  p_admin_id uuid,
  p_action text,
  p_request_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.reviewer_account_jobs%rowtype;
begin
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'reviewer-operation:' || p_operation_id::text,
      0::bigint
    )
  );
  select *
    into v_job
    from public.reviewer_account_jobs
   where operation_id = p_operation_id;
  if not found then
    return null;
  end if;
  if v_job.created_by is distinct from p_admin_id
     or v_job.action <> p_action
     or v_job.request_payload is distinct from p_request_payload then
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'action', v_job.action,
    'status', v_job.status,
    'user_id', v_job.user_id,
    'replayed', true
  );
end;
$$;
revoke all on function public.bp_reviewer_job_replay(
  uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.start_reviewer_provision(
  p_admin_id uuid,
  p_operation_id uuid,
  p_email text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_payload jsonb;
  v_replay jsonb;
  v_job_id uuid;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if v_email is null
     or pg_catalog.char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;
  if v_note is not null and pg_catalog.char_length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = 'P0001';
  end if;
  v_payload := pg_catalog.jsonb_build_object(
    'email', v_email,
    'note', v_note
  );
  v_replay := public.bp_reviewer_job_replay(
    p_operation_id,
    p_admin_id,
    'provision',
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'reviewer-email:' || v_email,
      0::bigint
    )
  );
  if exists (
    select 1
      from public.reviewer_accounts r
     where pg_catalog.lower(r.email) = v_email
  ) then
    raise exception 'email_exists' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.reviewer_account_jobs j
     where pg_catalog.lower(j.email) = v_email
       and j.status in ('pending', 'leased')
  ) then
    raise exception 'provision_in_progress' using errcode = 'P0001';
  end if;

  insert into public.reviewer_account_jobs(
    operation_id,
    action,
    status,
    email,
    note,
    desired_active,
    request_payload,
    created_by
  )
  values (
    p_operation_id,
    'provision',
    'pending',
    v_email,
    v_note,
    null,
    v_payload,
    p_admin_id
  )
  returning id into v_job_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'action', 'provision',
    'status', 'pending',
    'user_id', null,
    'replayed', false
  );
end;
$$;

create or replace function public.start_reviewer_auth_sync(
  p_admin_id uuid,
  p_operation_id uuid,
  p_user_id uuid,
  p_action text,
  p_desired_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer public.reviewer_accounts%rowtype;
  v_payload jsonb;
  v_replay jsonb;
  v_job_id uuid;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_user_id is null then
    raise exception 'user_id_required' using errcode = 'P0001';
  end if;
  if p_action is null
     or p_action not in ('set_active', 'reset_password', 'delete')
     or (p_action = 'set_active' and p_desired_active is null)
     or (p_action in ('reset_password', 'delete')
         and p_desired_active is not null) then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
  v_payload := pg_catalog.jsonb_build_object(
    'user_id', p_user_id,
    'action', p_action,
    'desired_active', p_desired_active
  );
  v_replay := public.bp_reviewer_job_replay(
    p_operation_id,
    p_admin_id,
    p_action,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select *
    into v_reviewer
    from public.reviewer_accounts
   where user_id = p_user_id
   for update;
  if not found then
    raise exception 'reviewer_not_found' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.reviewer_account_jobs j
     where j.user_id = p_user_id
       and j.status in ('pending', 'leased')
  ) then
    raise exception 'sync_in_progress' using errcode = 'P0001';
  end if;

  -- Payment classification sees pending and stops before choosing any channel.
  update public.reviewer_accounts
     set active =
           case
             when p_action = 'set_active' then p_desired_active
             when p_action = 'delete' then false
             else v_reviewer.active
           end,
         auth_sync_pending = true,
         updated_at = clock_timestamp()
   where user_id = p_user_id;

  insert into public.reviewer_account_jobs(
    operation_id,
    action,
    status,
    user_id,
    email,
    note,
    desired_active,
    request_payload,
    created_by
  )
  values (
    p_operation_id,
    p_action,
    'pending',
    p_user_id,
    pg_catalog.lower(v_reviewer.email),
    null,
    case when p_action = 'set_active' then p_desired_active else null end,
    v_payload,
    p_admin_id
  )
  returning id into v_job_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'action', p_action,
    'status', 'pending',
    'user_id', p_user_id,
    'replayed', false
  );
end;
$$;

create or replace function public.claim_reviewer_account_job(
  p_job_id uuid default null,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.reviewer_account_jobs%rowtype;
  v_token uuid := pg_catalog.gen_random_uuid();
  v_seconds integer :=
    greatest(15, least(coalesce(p_lease_seconds, 120), 600));
begin
  with candidate as (
    select j.id
      from public.reviewer_account_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and (
         (j.status = 'pending' and j.next_attempt_at <= clock_timestamp())
         or
         (j.status = 'leased' and j.leased_until <= clock_timestamp())
       )
     order by j.next_attempt_at asc, j.created_at asc, j.id asc
     limit 1
     for update skip locked
  )
  update public.reviewer_account_jobs j
     set status = 'leased',
         lease_token = v_token,
         leased_until = clock_timestamp() + pg_catalog.make_interval(
           secs => v_seconds
         ),
         lease_version = j.lease_version + 1,
         attempt_count = j.attempt_count + 1,
         updated_at = clock_timestamp()
    from candidate c
   where j.id = c.id
  returning j.* into v_job;
  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'job_id', v_job.id,
    'operation_id', v_job.operation_id,
    'action', v_job.action,
    'user_id', v_job.user_id,
    'email', v_job.email,
    'desired_active', v_job.desired_active,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count
  );
end;
$$;

create or replace function public.record_reviewer_provision_auth(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.reviewer_account_jobs%rowtype;
  v_auth_email text;
  v_auth_meta jsonb;
begin
  select *
    into v_job
    from public.reviewer_account_jobs
   where id = p_job_id
   for update;
  if not found
     or v_job.status <> 'leased'
     or v_job.action <> 'provision'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;
  if v_job.user_id is not null and v_job.user_id <> p_user_id then
    raise exception 'auth_identity_conflict' using errcode = 'P0001';
  end if;

  select pg_catalog.lower(u.email), u.raw_app_meta_data
    into v_auth_email, v_auth_meta
    from auth.users u
   where u.id = p_user_id;
  if not found
     or v_auth_email is distinct from v_job.email
     or coalesce(v_auth_meta->>'reviewer', '') <> 'true'
     or coalesce(v_auth_meta->>'reviewer_job_id', '') <> v_job.id::text then
    raise exception 'auth_identity_invalid' using errcode = 'P0001';
  end if;

  update public.reviewer_account_jobs
     set user_id = p_user_id,
         updated_at = clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'user_id', p_user_id
  );
end;
$$;

create or replace function public.finalize_reviewer_provision(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.reviewer_account_jobs%rowtype;
  v_auth_email text;
  v_auth_meta jsonb;
  v_today date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_terms integer;
  v_privacy integer;
begin
  select *
    into v_job
    from public.reviewer_account_jobs
   where id = p_job_id
   for update;
  if not found
     or v_job.status <> 'leased'
     or v_job.action <> 'provision'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;
  if v_job.user_id is null then
    raise exception 'auth_identity_missing' using errcode = 'P0001';
  end if;

  select pg_catalog.lower(u.email), u.raw_app_meta_data
    into v_auth_email, v_auth_meta
    from auth.users u
   where u.id = v_job.user_id;
  if not found
     or v_auth_email is distinct from v_job.email
     or coalesce(v_auth_meta->>'reviewer', '') <> 'true'
     or coalesce(v_auth_meta->>'reviewer_job_id', '') <> v_job.id::text then
    raise exception 'auth_identity_invalid' using errcode = 'P0001';
  end if;

  -- Same lock family and fixed order as legal publish and member consent.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:terms', 0::bigint)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('legal:privacy', 0::bigint)
  );
  select l.version
    into v_terms
    from public.legal_documents l
   where l.doc_type = 'terms'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;
  select l.version
    into v_privacy
    from public.legal_documents l
   where l.doc_type = 'privacy'
     and l.status = 'published'
     and l.effective_date <= v_today
   order by l.effective_date desc, l.version desc, l.id desc
   limit 1;

  perform public.create_or_update_member_consent(
    v_job.user_id,
    0,
    true,
    v_terms is not null,
    coalesce(v_terms, 0),
    v_privacy is not null,
    coalesce(v_privacy, 0)
  );

  insert into public.reviewer_accounts(
    user_id,
    email,
    active,
    auth_sync_pending,
    note,
    created_by
  )
  values (
    v_job.user_id,
    v_job.email,
    true,
    false,
    v_job.note,
    v_job.created_by
  );

  update public.reviewer_account_jobs
     set status = 'completed',
         lease_token = null,
         leased_until = null,
         last_error = null,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = v_job.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'status', 'completed',
    'user_id', v_job.user_id,
    'email', v_job.email
  );
end;
$$;

create or replace function public.finish_reviewer_account_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_success boolean,
  p_terminal boolean,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.reviewer_account_jobs%rowtype;
  v_status text;
  v_backoff integer;
begin
  select *
    into v_job
    from public.reviewer_account_jobs
   where id = p_job_id
   for update;
  if not found
     or v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;

  if not coalesce(p_success, false) then
    if p_error is null
       or pg_catalog.char_length(p_error) not between 1 and 500 then
      raise exception 'error_required' using errcode = 'P0001';
    end if;
    v_status := case when coalesce(p_terminal, false) then 'failed' else 'pending' end;
    v_backoff := least(
      3600,
      5 * (1 << least(v_job.attempt_count, 10))
    );
    update public.reviewer_account_jobs
       set status = v_status,
           lease_token = null,
           leased_until = null,
           next_attempt_at =
             case
               when v_status = 'pending'
                 then clock_timestamp() + pg_catalog.make_interval(
                   secs => v_backoff
                 )
               else next_attempt_at
             end,
           last_error = p_error,
           completed_at =
             case when v_status = 'failed' then clock_timestamp() else null end,
           updated_at = clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'status', v_status
    );
  end if;

  if v_job.action = 'provision' then
    raise exception 'use_provision_finalize' using errcode = 'P0001';
  elsif v_job.action = 'set_active' then
    update public.reviewer_accounts
       set active = v_job.desired_active,
           auth_sync_pending = false,
           updated_at = clock_timestamp()
     where user_id = v_job.user_id;
    if not found then
      raise exception 'reviewer_not_found' using errcode = 'P0001';
    end if;
  elsif v_job.action = 'reset_password' then
    update public.reviewer_accounts
       set auth_sync_pending = false,
           updated_at = clock_timestamp()
     where user_id = v_job.user_id;
    if not found then
      raise exception 'reviewer_not_found' using errcode = 'P0001';
    end if;
  elsif v_job.action = 'delete' then
    delete from public.reviewer_accounts
     where user_id = v_job.user_id;
    -- Missing is already the desired database state after a successful ban.
  else
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  update public.reviewer_account_jobs
     set status = 'completed',
         lease_token = null,
         leased_until = null,
         last_error = null,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'status', 'completed'
  );
end;
$$;

create or replace function public.admin_set_reviewer_note(
  p_admin_id uuid,
  p_user_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(pg_catalog.btrim(p_note), '');
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_user_id is null then
    raise exception 'user_id_required' using errcode = 'P0001';
  end if;
  if v_note is not null and pg_catalog.char_length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = 'P0001';
  end if;
  update public.reviewer_accounts
     set note = v_note,
         updated_at = clock_timestamp()
   where user_id = p_user_id;
  if not found then
    raise exception 'reviewer_not_found' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$$;

create or replace function public.admin_list_reviewer_jobs(
  p_admin_id uuid,
  p_limit integer default 50
)
returns table (
  job_id uuid,
  action text,
  status text,
  user_id uuid,
  email text,
  desired_active boolean,
  attempt_count integer,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bp_assert_active_admin(p_admin_id);
  return query
  select
    j.id,
    j.action,
    j.status,
    j.user_id,
    j.email,
    j.desired_active,
    j.attempt_count,
    j.last_error,
    j.created_at,
    j.updated_at
  from public.reviewer_account_jobs j
  where j.status in ('pending', 'leased', 'failed')
  order by j.created_at desc, j.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

-- Rolling expand stage: SELECT is a permanent server read contract. Existing
-- servers keep direct CUD until the saga-aware app is live; 0092 removes CUD.
revoke insert, update, delete on table public.reviewer_accounts
  from service_role;
grant select, insert, update, delete on table public.reviewer_accounts
  to service_role;

revoke all on function public.start_reviewer_provision(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_reviewer_provision(uuid,uuid,text,text)
  to service_role;
revoke all on function public.start_reviewer_auth_sync(
  uuid,uuid,uuid,text,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.start_reviewer_auth_sync(
  uuid,uuid,uuid,text,boolean
) to service_role;
revoke all on function public.claim_reviewer_account_job(uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_reviewer_account_job(uuid,integer)
  to service_role;
revoke all on function public.record_reviewer_provision_auth(
  uuid,uuid,integer,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.record_reviewer_provision_auth(
  uuid,uuid,integer,uuid
) to service_role;
revoke all on function public.finalize_reviewer_provision(
  uuid,uuid,integer
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_reviewer_provision(
  uuid,uuid,integer
) to service_role;
revoke all on function public.finish_reviewer_account_job(
  uuid,uuid,integer,boolean,boolean,text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_reviewer_account_job(
  uuid,uuid,integer,boolean,boolean,text
) to service_role;
revoke all on function public.admin_set_reviewer_note(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_reviewer_note(uuid,uuid,text)
  to service_role;
revoke all on function public.admin_list_reviewer_jobs(uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_list_reviewer_jobs(uuid,integer)
  to service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.start_reviewer_provision(uuid,uuid,text,text)',
    'public.start_reviewer_auth_sync(uuid,uuid,uuid,text,boolean)',
    'public.claim_reviewer_account_job(uuid,integer)',
    'public.record_reviewer_provision_auth(uuid,uuid,integer,uuid)',
    'public.finalize_reviewer_provision(uuid,uuid,integer)',
    'public.finish_reviewer_account_job(uuid,uuid,integer,boolean,boolean,text)',
    'public.admin_set_reviewer_note(uuid,uuid,text)',
    'public.admin_list_reviewer_jobs(uuid,integer)'
  ]
  loop
    if to_regprocedure(v_signature) is null
       or not has_function_privilege(
         'service_role',
         to_regprocedure(v_signature),
         'EXECUTE'
       )
       or has_function_privilege(
         'anon',
         to_regprocedure(v_signature),
         'EXECUTE'
       )
       or has_function_privilege(
         'authenticated',
         to_regprocedure(v_signature),
         'EXECUTE'
       ) then
      raise exception '0083 postflight: RPC/ACL drift (%)', v_signature;
    end if;
  end loop;
  if not has_table_privilege(
       'service_role',
       'public.reviewer_accounts',
       'SELECT'
     )
     or not has_table_privilege(
       'service_role',
       'public.reviewer_accounts',
       'INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'service_role',
       'public.reviewer_account_jobs',
       'SELECT'
     ) then
    raise exception '0083 postflight: reviewer rollout/read ACL drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0083_reviewer_account_saga', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
