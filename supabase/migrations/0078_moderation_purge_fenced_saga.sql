-- 0078: moderation permanent-delete fenced saga.
--
-- Migration-first additive rollout:
--   * old takedown/restore/permanent-delete code keeps working while this DDL lands;
--   * new code uses begin -> claim(token+version) -> Storage delete -> finish;
--   * restore and every direct deleted_at=NULL transition are rejected while a purge
--     job is pending/leased, so an active doll can never race a physical delete.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create table public.moderation_purge_jobs (
  id uuid primary key default gen_random_uuid(),
  doll_id uuid not null references public.dolls(id) on delete cascade,
  admin_user_id uuid not null references public.profiles(id),
  reason text not null check (char_length(reason) between 5 and 500),
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed')),
  manifest jsonb not null,
  lease_version int not null default 0 check (lease_version >= 0),
  lease_token uuid,
  leased_until timestamptz,
  attempt_count int not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint moderation_purge_manifest_check check (
    jsonb_typeof(manifest) = 'array'
    and (status <> 'completed' or manifest = '[]'::jsonb)
  ),
  constraint moderation_purge_lease_check check (
    (status = 'leased') =
      (lease_token is not null and leased_until is not null)
  ),
  constraint moderation_purge_completion_check check (
    (status = 'completed') = (completed_at is not null)
  )
);

comment on table public.moderation_purge_jobs is
  'Fenced doll/highlight Storage purge outbox. Restore is blocked until an active job completes.';

alter table public.moderation_purge_jobs enable row level security;
revoke all on table public.moderation_purge_jobs
  from public, anon, authenticated, service_role;

create unique index uq_moderation_purge_active_doll
  on public.moderation_purge_jobs(doll_id)
  where status in ('pending', 'leased');
create index idx_moderation_purge_claim
  on public.moderation_purge_jobs(next_attempt_at, created_at, id)
  where status in ('pending', 'leased');

create or replace function public.bp_assert_active_admin(p_admin_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
begin
  select p.deleted_at
    into v_deleted_at
    from public.member_accounts m
    join public.profiles p on p.id = m.user_id
   where m.user_id = p_admin_id
     and m.is_admin = true
   for key share of p;
  if not found or v_deleted_at is not null then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.bp_assert_active_admin(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.admin_begin_doll_purge(
  p_admin_id uuid,
  p_doll_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doll public.dolls%rowtype;
  v_existing public.moderation_purge_jobs%rowtype;
  v_manifest jsonb;
  v_job_id uuid;
begin
  if char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 5 and 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  perform public.bp_assert_active_admin(p_admin_id);

  -- The doll row is the global ordering point shared with restore and the
  -- deleted_at backstop trigger.
  select *
    into v_doll
    from public.dolls
   where id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.artifacts_purged_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'already_purged', true, 'job_id', null);
  end if;
  if v_doll.deleted_at is null then
    raise exception 'not_taken_down' using errcode = 'P0001';
  end if;

  select *
    into v_existing
    from public.moderation_purge_jobs
   where doll_id = p_doll_id
     and status in ('pending', 'leased')
   order by created_at desc, id desc
   limit 1
   for update;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already_purged', false,
      'job_id', v_existing.id,
      'status', v_existing.status
    );
  end if;

  -- score_highlights INSERT takes a KEY SHARE lock on this same doll and rejects
  -- deleted dolls. Therefore an insert either commits before this snapshot and
  -- is included, or waits and fails after this transaction commits.
  select coalesce(
           pg_catalog.jsonb_agg(target order by target->>'bucket', target->>'path'),
           '[]'::jsonb
         )
    into v_manifest
    from (
      select pg_catalog.jsonb_build_object(
               'bucket', 'dolls',
               'path', public.bp_account_cleanup_storage_path(
                 v_doll.image_url,
                 'dolls'
               )
             ) as target
       where public.bp_account_cleanup_storage_path(
               v_doll.image_url,
               'dolls'
             ) is not null
      union
      select pg_catalog.jsonb_build_object(
               'bucket', 'highlights',
               'path', public.bp_account_cleanup_storage_path(
                 sh.highlight_clip_path,
                 'highlights'
               )
             ) as target
        from public.scores s
        join public.score_highlights sh on sh.score_id = s.id
       where s.doll_id = p_doll_id
         and public.bp_account_cleanup_storage_path(
               sh.highlight_clip_path,
               'highlights'
             ) is not null
    ) targets;

  insert into public.moderation_purge_jobs(
    doll_id,
    admin_user_id,
    reason,
    manifest
  )
  values (
    p_doll_id,
    p_admin_id,
    pg_catalog.btrim(p_reason),
    v_manifest
  )
  returning id into v_job_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'already_purged', false,
    'job_id', v_job_id,
    'status', 'pending'
  );
end;
$$;
revoke all on function public.admin_begin_doll_purge(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_begin_doll_purge(uuid, uuid, text)
  to service_role;

create or replace function public.claim_moderation_purge(
  p_job_id uuid default null,
  p_lease_seconds int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.moderation_purge_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds int := greatest(15, least(coalesce(p_lease_seconds, 120), 600));
begin
  with candidate as (
    select j.id
      from public.moderation_purge_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and (
         (j.status = 'pending' and j.next_attempt_at <= clock_timestamp())
         or
         (j.status = 'leased' and j.leased_until <= clock_timestamp())
       )
     order by j.next_attempt_at, j.created_at, j.id
     limit 1
     for update skip locked
  )
  update public.moderation_purge_jobs j
     set status = 'leased',
         lease_version = j.lease_version + 1,
         lease_token = v_token,
         leased_until =
           clock_timestamp() + pg_catalog.make_interval(secs => v_seconds),
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
    'doll_id', v_job.doll_id,
    'manifest', v_job.manifest,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count
  );
end;
$$;
revoke all on function public.claim_moderation_purge(uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_moderation_purge(uuid, int)
  to service_role;

create or replace function public.finish_moderation_purge(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version int,
  p_success boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.moderation_purge_jobs%rowtype;
  v_doll public.dolls%rowtype;
  v_doll_id uuid;
  v_delay int;
begin
  -- Global lock order is dolls -> moderation_purge_jobs, matching begin/restore.
  -- The first read is only a hint; the exact lease fence is revalidated after
  -- the doll lock, so a concurrent claim/finish cannot be accepted stale.
  select doll_id
    into v_doll_id
    from public.moderation_purge_jobs
   where id = p_job_id;
  if not found then
    raise exception 'purge_lease_lost' using errcode = 'P0001';
  end if;

  select *
    into v_doll
    from public.dolls
   where id = v_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_job
    from public.moderation_purge_jobs
   where id = p_job_id
     and status = 'leased'
     and lease_token = p_lease_token
     and lease_version = p_lease_version
     and leased_until > clock_timestamp()
   for update;
  if not found then
    raise exception 'purge_lease_lost' using errcode = 'P0001';
  end if;

  if p_success then
    if v_doll.deleted_at is null then
      raise exception 'purge_state_conflict' using errcode = 'P0001';
    end if;

    update public.dolls
       set artifacts_purged_at =
             coalesce(artifacts_purged_at, clock_timestamp())
     where id = v_job.doll_id;

    insert into public.moderation_actions_ledger(
      admin_user_id,
      action_type,
      target_type,
      target_id,
      reason,
      metadata
    )
    values (
      v_job.admin_user_id,
      'purge_doll',
      'doll',
      v_job.doll_id,
      v_job.reason,
      pg_catalog.jsonb_build_object(
        'purge_job_id', v_job.id,
        'purged_targets', pg_catalog.jsonb_array_length(v_job.manifest),
        'lease_version', v_job.lease_version
      )
    );

    update public.moderation_purge_jobs
       set status = 'completed',
           manifest = '[]'::jsonb,
           lease_token = null,
           leased_until = null,
           last_error = null,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = v_job.id;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'doll_id', v_job.doll_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'completed'
    );
  end if;

  v_delay := least(
    3600,
    (
      30 * pg_catalog.power(
        2::numeric,
        least(greatest(v_job.attempt_count - 1, 0), 7)
      )
    )::int
  );
  update public.moderation_purge_jobs
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         last_error = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_error), ''), 'purge_failed'),
           1000
         ),
         next_attempt_at =
           clock_timestamp() + pg_catalog.make_interval(secs => v_delay),
         updated_at = clock_timestamp()
   where id = v_job.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'doll_id', v_job.doll_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', 'pending',
    'retry_in_seconds', v_delay
  );
end;
$$;
revoke all on function public.finish_moderation_purge(
  uuid, uuid, int, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_moderation_purge(
  uuid, uuid, int, boolean, text
) to service_role;

-- DB-level backstop for every current/future restore implementation.
create or replace function public.bp_reject_doll_restore_during_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is not null
     and new.deleted_at is null
     and exists (
       select 1
         from public.moderation_purge_jobs j
        where j.doll_id = new.id
          and j.status in ('pending', 'leased')
     ) then
    raise exception 'purge_pending' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_reject_doll_restore_during_purge()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_dolls_reject_restore_during_purge on public.dolls;
create trigger trg_dolls_reject_restore_during_purge
  before update of deleted_at on public.dolls
  for each row execute function public.bp_reject_doll_restore_during_purge();

-- 0035 restore body, now serialized with begin via dolls FOR UPDATE and blocked
-- by both an explicit check and the table trigger.
create or replace function public.admin_restore_doll(
  p_admin_id uuid,
  p_doll_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doll public.dolls%rowtype;
begin
  if char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 5 and 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  perform public.bp_assert_active_admin(p_admin_id);

  select *
    into v_doll
    from public.dolls
   where id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.artifacts_purged_at is not null then
    raise exception 'already_purged' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.moderation_purge_jobs j
     where j.doll_id = p_doll_id
       and j.status in ('pending', 'leased')
  ) then
    raise exception 'purge_pending' using errcode = 'P0001';
  end if;
  if v_doll.deleted_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'already_active', true);
  end if;

  update public.dolls
     set deleted_at = null,
         deleted_by = null,
         deletion_reason = null
   where id = p_doll_id;

  update public.score_highlights
     set highlight_deleted_at = null,
         highlight_deleted_by_doll = null
   where highlight_deleted_by_doll = p_doll_id;

  insert into public.moderation_actions_ledger(
    admin_user_id,
    action_type,
    target_type,
    target_id,
    reason
  )
  values (
    p_admin_id,
    'restore_doll',
    'doll',
    p_doll_id,
    pg_catalog.btrim(p_reason)
  );

  return pg_catalog.jsonb_build_object(
    'ok', true, 'already_active', false);
end;
$$;
revoke all on function public.admin_restore_doll(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_restore_doll(uuid, uuid, text)
  to service_role;

-- Extend 0072's score-highlight lifecycle fence: a score whose doll is hidden
-- cannot acquire a new clip after the purge manifest snapshot.
create or replace function public.bp_reject_deleted_score_highlight_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_review_status text;
  v_doll_id uuid;
  v_doll_deleted_at timestamptz;
begin
  select p.deleted_at, s.review_status, s.doll_id
    into v_deleted_at, v_review_status, v_doll_id
    from public.scores s
    join public.profiles p on p.id = s.owner_id
   where s.id = new.score_id
   for share of s, p;
  if not found then
    raise exception 'score_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  if v_review_status not in ('registered', 'cleared') then
    raise exception 'score_not_publishable' using errcode = 'P0001';
  end if;
  if v_doll_id is not null then
    select d.deleted_at
      into v_doll_deleted_at
      from public.dolls d
     where d.id = v_doll_id
     for key share;
    if found and v_doll_deleted_at is not null then
      raise exception 'doll_unavailable' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.bp_reject_deleted_score_highlight_insert()
  from public, anon, authenticated, service_role;

do $$
begin
  if not (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.moderation_purge_jobs'::regclass
  ) then
    raise exception '0078 postflight: purge jobs RLS disabled';
  end if;
  if exists (
    select 1
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.moderation_purge_jobs'::regclass
  ) then
    raise exception '0078 postflight: purge jobs policy leak';
  end if;
  if pg_catalog.has_table_privilege(
    'service_role', 'public.moderation_purge_jobs', 'SELECT')
  then
    raise exception '0078 postflight: purge jobs must be RPC-only';
  end if;
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.admin_begin_doll_purge(uuid,uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_moderation_purge(uuid,integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finish_moderation_purge(uuid,uuid,integer,boolean,text)',
       'EXECUTE')
  then
    raise exception '0078 postflight: service RPC grant missing';
  end if;
  if pg_catalog.has_function_privilege(
       'anon',
       'public.admin_begin_doll_purge(uuid,uuid,text)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_moderation_purge(uuid,integer)',
       'EXECUTE')
  then
    raise exception '0078 postflight: client purge RPC access leaked';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0078_moderation_purge_fenced_saga', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
