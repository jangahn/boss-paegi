-- 0085: external admin mutations get durable exactly-once receipts, explicit
-- state preconditions, and response-loss recovery.
--
-- 0082 covered credit adjustment, 0081 legal, 0083 reviewer provisioning, and
-- 0078/0079 destructive moderation/storage cleanup. This migration closes the
-- remaining admin write surfaces:
--   * config publish/restore
--   * event create/save/publish/unpublish/delete
--   * permanent moderation begin (reusing the 0078 fenced purge saga)
--   * integrity clear/void/ban/unban
--   * account reactivation (DB -> GoTrue two-system saga)
--   * stuck-order settlement
--
-- A request UUID is bound to the exact canonical jsonb payload. Replaying the
-- same UUID returns the stored result; reusing it with a different operation,
-- target, admin, or payload fails closed. Recovery-before-POST writes an
-- aborted tombstone under the same advisory lock, so a late POST cannot mutate.
-- No password, auth token, provider secret, or other credential is accepted or
-- persisted by these operations.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if to_regprocedure(
       'public.bp_0084_admin_reactivate_account_impl(uuid,uuid,text,text)'
     ) is null
     or to_regprocedure(
       'public.admin_settle_stuck_order(uuid,uuid,text)'
     ) is null
     or to_regprocedure(
       'public.admin_begin_doll_purge(uuid,uuid,text)'
     ) is null
     or to_regprocedure(
       'public.admin_ban_member(uuid,uuid,text)'
     ) is null
     or to_regprocedure(
       'public.admin_unban_member(uuid,uuid,text)'
     ) is null then
    raise exception '0085 preflight: 0084 mutation lock wrappers missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'pgcrypto'
       and n.nspname = 'extensions'
  ) then
    raise exception '0085 preflight: pgcrypto in extensions schema missing';
  end if;
end;
$$;

-- ── 1. Generic durable operation request/receipt ───────────────────────────

create table public.admin_mutation_requests (
  request_id uuid primary key,
  admin_user_id uuid not null
    references public.profiles(id) on delete restrict,
  operation text not null check (
    operation in (
      'config_update',
      'event_save',
      'event_publish',
      'event_unpublish',
      'event_delete',
      'moderation_takedown',
      'moderation_dismiss',
      'moderation_restore',
      'moderation_permanent_delete',
      'integrity_clear',
      'integrity_void',
      'integrity_ban',
      'integrity_unban',
      'account_reactivate',
      'order_settle'
    )
  ),
  target_key text not null
    check (char_length(target_key) between 1 and 200),
  state text not null check (
    state in ('pending', 'completed', 'cancelled', 'aborted')
  ),
  -- Exact jsonb equality, rather than a truncated hash, is the authority for
  -- payload binding. The full SHA-256 is kept only for indexed diagnostics.
  request_payload jsonb,
  payload_sha256 text check (
    payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint admin_mutation_request_shape check (
    (
      state = 'pending'
      and request_payload is not null
      and pg_catalog.jsonb_typeof(request_payload) = 'object'
      and payload_sha256 is not null
      and result is null
      and completed_at is null
    )
    or (
      state in ('completed', 'cancelled')
      and request_payload is not null
      and pg_catalog.jsonb_typeof(request_payload) = 'object'
      and payload_sha256 is not null
      and result is not null
      and pg_catalog.jsonb_typeof(result) = 'object'
      and completed_at is not null
    )
    or (
      state = 'aborted'
      and request_payload is null
      and payload_sha256 is null
      and result is null
      and completed_at is not null
    )
  ),
  constraint admin_mutation_request_payload_size check (
    request_payload is null
    or pg_catalog.octet_length(request_payload::text) <= 1048576
  ),
  constraint admin_mutation_request_result_size check (
    result is null
    or pg_catalog.octet_length(result::text) <= 16384
  )
);

comment on table public.admin_mutation_requests is
  '외부 admin mutation의 exact-payload request/receipt와 recovery tombstone. credential payload 금지.';

alter table public.admin_mutation_requests enable row level security;
revoke all on table public.admin_mutation_requests
  from public, anon, authenticated, service_role;
grant select on table public.admin_mutation_requests to service_role;

create index idx_admin_mutation_requests_admin_created
  on public.admin_mutation_requests(admin_user_id, created_at desc, request_id);
create index idx_admin_mutation_requests_target
  on public.admin_mutation_requests(operation, target_key, created_at desc);
create unique index uq_admin_reactivation_pending_target
  on public.admin_mutation_requests(operation, target_key)
  where operation = 'account_reactivate' and state = 'pending';

-- Establish a closed installation boundary with the already-deployed
-- DB-first wrapper. Calls that owned the namespace first commit before the
-- backfill below. Calls already invoked but queued behind this transaction
-- resume with their old function body after commit and are captured by the
-- deferred transition trigger installed below.
do $$
begin
  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
end;
$$;

-- A rolling DB-first repair performs its Auth email change after the legacy
-- activation transaction. Serialize that external statement with a new
-- withdrawal before either side inspects lifecycle evidence. This namespace
-- is intentionally separate from the general user-mutation lock: GoTrue
-- already owns auth.identities/auth.users when its email trigger runs, while
-- account deletion never locks Auth rows in its DB transaction.
create or replace function
  public.bp_account_reactivation_auth_transition_lock(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'user_lock_id_required' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      'account-reactivation-auth:' || p_user_id::text
    )::bigint
  );
end;
$$;
revoke all on function
  public.bp_account_reactivation_auth_transition_lock(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.admin_soft_delete_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform public.bp_account_reactivation_auth_transition_lock(
      p_user_id
    );
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  return public.bp_0084_admin_soft_delete_account_impl(p_user_id);
end;
$$;
revoke all on function public.admin_soft_delete_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_soft_delete_account(uuid)
  to service_role;

-- A timestamp alone is not a mathematical lifecycle identity: a later
-- withdrawal can be assigned the same timestamptz. Advance an immutable,
-- bounded per-user generation on every active -> deleted transition so old
-- completed receipts and stale Auth workers can never match a later cycle.
alter table public.profiles
  add column withdrawal_generation bigint not null default 0;
update public.profiles
   set withdrawal_generation = 1
 where deleted_at is not null;
alter table public.profiles
  add constraint profiles_withdrawal_generation_exact_integer check (
    withdrawal_generation between 0 and 9007199254740991
  );

create or replace function public.bp_advance_withdrawal_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    if old.withdrawal_generation >= 9007199254740991 then
      raise exception 'withdrawal_generation_exhausted'
        using errcode = 'P0001';
    end if;
    new.withdrawal_generation := old.withdrawal_generation + 1;
  elsif new.withdrawal_generation is distinct from
        old.withdrawal_generation then
    raise exception 'withdrawal_generation_immutable'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_advance_withdrawal_generation()
  from public, anon, authenticated, service_role;

create trigger trg_profiles_advance_withdrawal_generation
  before update of deleted_at, withdrawal_generation on public.profiles
  for each row execute function public.bp_advance_withdrawal_generation();

-- One immutable external-sync job is bound 1:1 to each pending reactivation
-- receipt. No role gets table DML/SELECT; all access is through the exact
-- correlation + lease RPCs below.
create table public.account_reactivation_jobs (
  request_id uuid primary key
    references public.admin_mutation_requests(request_id)
      on delete restrict,
  admin_user_id uuid not null
    references public.profiles(id) on delete restrict,
  user_id uuid not null
    references public.profiles(id) on delete restrict,
  expected_deleted_at timestamptz not null,
  expected_withdrawal_generation bigint not null check (
    expected_withdrawal_generation between 1 and 9007199254740991
  ),
  resolved_email text not null check (
    pg_catalog.char_length(resolved_email) between 3 and 320
    and resolved_email = pg_catalog.btrim(resolved_email)
    and pg_catalog.lower(resolved_email)
          not like '%@deleted.invalid'
  ),
  cancel_requested_by uuid
    references public.profiles(id) on delete restrict,
  cancel_reason text check (
    cancel_reason is null
    or pg_catalog.char_length(cancel_reason) between 5 and 500
  ),
  cancel_requested_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed', 'cancelled')),
  lease_token uuid,
  lease_version integer not null default 0
    check (lease_version between 0 and 2147483647),
  leased_until timestamptz,
  attempt_count integer not null default 0
    check (attempt_count between 0 and 2147483647),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text check (
    last_error is null or pg_catalog.char_length(last_error) between 1 and 500
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint account_reactivation_job_shape check (
    (
      status = 'pending'
      and lease_token is null
      and leased_until is null
      and completed_at is null
    )
    or (
      status = 'leased'
      and lease_token is not null
      and leased_until is not null
      and completed_at is null
    )
    or (
      status in ('completed', 'cancelled')
      and lease_token is null
      and leased_until is null
      and completed_at is not null
    )
  ),
  constraint account_reactivation_job_cancel_shape check (
    (
      cancel_requested_by is null
      and cancel_reason is null
      and cancel_requested_at is null
    )
    or (
      cancel_requested_by is not null
      and cancel_reason is not null
      and cancel_requested_at is not null
    )
  )
);

comment on table public.account_reactivation_jobs is
  'pending account_reactivate receipt의 GoTrue email sync lease/outbox. RPC-only.';

alter table public.account_reactivation_jobs enable row level security;
revoke all on table public.account_reactivation_jobs
  from public, anon, authenticated, service_role;

create index idx_account_reactivation_jobs_due
  on public.account_reactivation_jobs(
    status,
    next_attempt_at,
    created_at,
    request_id
  )
  where status in ('pending', 'leased');

create or replace function public.bp_account_reactivation_jobs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'account_reactivation_job_append_only'
      using errcode = 'P0001';
  end if;
  if old.request_id is distinct from new.request_id
     or old.admin_user_id is distinct from new.admin_user_id
     or old.user_id is distinct from new.user_id
     or old.expected_deleted_at is distinct from new.expected_deleted_at
     or old.expected_withdrawal_generation is distinct from
          new.expected_withdrawal_generation
     or old.resolved_email is distinct from new.resolved_email
     or old.created_at is distinct from new.created_at then
    raise exception 'account_reactivation_job_immutable'
      using errcode = 'P0001';
  end if;
  if old.cancel_requested_at is not null
     and (
       old.cancel_requested_by is distinct from new.cancel_requested_by
       or old.cancel_reason is distinct from new.cancel_reason
       or old.cancel_requested_at is distinct from new.cancel_requested_at
     ) then
    raise exception 'account_reactivation_job_cancel_immutable'
      using errcode = 'P0001';
  end if;
  if old.cancel_requested_at is null
     and new.cancel_requested_at is not null
     and (
       new.cancel_requested_by is null
       or new.cancel_reason is null
     ) then
    raise exception 'account_reactivation_job_cancel_invalid'
      using errcode = 'P0001';
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'account_reactivation_job_terminal'
      using errcode = 'P0001';
  end if;
  if old.status = 'pending' and new.status = 'leased' then
    if new.lease_version <> old.lease_version + 1
       or new.attempt_count <> old.attempt_count + 1
       or new.cancel_requested_at is distinct from
            old.cancel_requested_at then
      raise exception 'account_reactivation_job_invalid_claim'
        using errcode = 'P0001';
    end if;
  elsif old.status = 'leased' and new.status = 'leased' then
    if old.leased_until > clock_timestamp()
       or new.lease_version <> old.lease_version + 1
       or new.attempt_count <> old.attempt_count + 1
       or new.cancel_requested_at is distinct from
            old.cancel_requested_at then
      raise exception 'account_reactivation_job_invalid_reclaim'
        using errcode = 'P0001';
    end if;
  elsif old.status = 'leased' and new.status = 'pending' then
    if not (
         (
           new.lease_version = old.lease_version
           and new.attempt_count = old.attempt_count
         )
         or (
           (
             (
               old.cancel_requested_at is null
               and new.cancel_requested_at is not null
             )
             or (
               old.cancel_requested_at is not null
               and new.cancel_requested_at is not distinct from
                     old.cancel_requested_at
             )
           )
           and (
             old.lease_version = 2147483647
             or old.attempt_count = 2147483647
           )
           and new.lease_version = case
                 when old.lease_version = 2147483647 then 0
                 else old.lease_version
               end
           and new.attempt_count = case
                 when old.attempt_count = 2147483647 then 0
                 else old.attempt_count
               end
         )
       )
       or not (
         new.cancel_requested_at is not distinct from
           old.cancel_requested_at
         or (
           old.cancel_requested_at is null
           and new.cancel_requested_at is not null
         )
       ) then
      raise exception 'account_reactivation_job_invalid_retry'
        using errcode = 'P0001';
    end if;
  elsif old.status = 'pending' and new.status = 'pending' then
    if not (
      (
        old.cancel_requested_at is null
        and new.cancel_requested_at is not null
        and new.lease_version = case
              when old.lease_version = 2147483647 then 0
              else old.lease_version
            end
        and new.attempt_count = case
              when old.attempt_count = 2147483647 then 0
              else old.attempt_count
            end
      )
      or (
        old.cancel_requested_at is not null
        and new.cancel_requested_at is not distinct from
              old.cancel_requested_at
        and (
          old.lease_version = 2147483647
          or old.attempt_count = 2147483647
        )
        and new.lease_version = case
              when old.lease_version = 2147483647 then 0
              else old.lease_version
            end
        and new.attempt_count = case
              when old.attempt_count = 2147483647 then 0
              else old.attempt_count
            end
        and new.last_error = 'cancellation_requested'
      )
      or (
        new.cancel_requested_at is not distinct from
          old.cancel_requested_at
        and new.lease_version = old.lease_version
        and new.attempt_count = old.attempt_count
        and (
          old.lease_version = 2147483647
          or old.attempt_count = 2147483647
        )
        and new.last_error = 'lease_counter_exhausted'
        and new.next_attempt_at =
              '9999-12-31 23:59:59+00'::timestamptz
      )
    ) then
      raise exception 'account_reactivation_job_invalid_cancel_request'
        using errcode = 'P0001';
    end if;
  elsif new.status in ('completed', 'cancelled')
        and old.status in ('pending', 'leased') then
    if new.lease_version <> old.lease_version
       or new.attempt_count <> old.attempt_count
       or (
         new.status = 'completed'
         and new.cancel_requested_at is not null
       )
       or (
         new.status = 'cancelled'
         and new.cancel_requested_at is null
       ) then
      raise exception 'account_reactivation_job_invalid_completion'
        using errcode = 'P0001';
    end if;
  else
    raise exception 'account_reactivation_job_invalid_transition'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_account_reactivation_jobs_guard()
  from public, anon, authenticated, service_role;

create trigger trg_account_reactivation_jobs_guard
  before update or delete on public.account_reactivation_jobs
  for each row execute function public.bp_account_reactivation_jobs_guard();

-- During the expand window the previously deployed route still calls the
-- DB-first admin_reactivate_account RPC and treats the subsequent GoTrue
-- email update as best effort. Persist a second, rolling-only outbox in the
-- same transaction as that legacy activation. It also backfills an orphan
-- produced before this migration (active profile + exact deletion marker +
-- real member email). 0092 refuses to contract while any repair is live.
create table public.account_reactivation_legacy_repairs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  admin_user_id uuid references public.profiles(id) on delete restrict,
  user_id uuid not null
    references public.profiles(id) on delete restrict,
  expected_withdrawal_generation bigint not null check (
    expected_withdrawal_generation between 0 and 9007199254740991
  ),
  resolved_email text not null check (
    pg_catalog.char_length(resolved_email) between 3 and 320
    and resolved_email = pg_catalog.btrim(resolved_email)
    and pg_catalog.lower(resolved_email)
          not like '%@deleted.invalid'
  ),
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed', 'superseded')),
  lease_token uuid,
  lease_version integer not null default 0
    check (lease_version between 0 and 2147483647),
  leased_until timestamptz,
  attempt_count integer not null default 0
    check (attempt_count between 0 and 2147483647),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text check (
    last_error is null or pg_catalog.char_length(last_error) between 1 and 500
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint account_reactivation_legacy_repair_shape check (
    (
      status = 'pending'
      and lease_token is null
      and leased_until is null
      and completed_at is null
    )
    or (
      status = 'leased'
      and lease_token is not null
      and leased_until is not null
      and completed_at is null
    )
    or (
      status in ('completed', 'superseded')
      and lease_token is null
      and leased_until is null
      and completed_at is not null
    )
  ),
  unique(user_id, expected_withdrawal_generation)
);

comment on table public.account_reactivation_legacy_repairs is
  'Rolling DB-first reactivation의 Auth email durable repair outbox. 0092 이후에도 지연된 구 서버 transaction을 exact lease fence로 수렴.';

alter table public.account_reactivation_legacy_repairs
  enable row level security;
revoke all on table public.account_reactivation_legacy_repairs
  from public, anon, authenticated, service_role;

create index idx_account_reactivation_legacy_repairs_due
  on public.account_reactivation_legacy_repairs(
    status,
    next_attempt_at,
    created_at,
    id
  )
  where status in ('pending', 'leased');

create or replace function
  public.bp_account_reactivation_legacy_repairs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'account_reactivation_legacy_repair_append_only'
      using errcode = 'P0001';
  end if;
  if old.id is distinct from new.id
     or old.admin_user_id is distinct from new.admin_user_id
     or old.user_id is distinct from new.user_id
     or old.expected_withdrawal_generation is distinct from
          new.expected_withdrawal_generation
     or old.resolved_email is distinct from new.resolved_email
     or old.created_at is distinct from new.created_at then
    raise exception 'account_reactivation_legacy_repair_immutable'
      using errcode = 'P0001';
  end if;
  if old.status in ('completed', 'superseded') then
    raise exception 'account_reactivation_legacy_repair_terminal'
      using errcode = 'P0001';
  end if;
  if old.status = 'pending' and new.status = 'leased' then
    if new.lease_version <> old.lease_version + 1
       or new.attempt_count <> old.attempt_count + 1 then
      raise exception 'account_reactivation_legacy_repair_invalid_claim'
        using errcode = 'P0001';
    end if;
  elsif old.status = 'leased' and new.status = 'leased' then
    if old.leased_until > clock_timestamp()
       or new.lease_version <> old.lease_version + 1
       or new.attempt_count <> old.attempt_count + 1 then
      raise exception 'account_reactivation_legacy_repair_invalid_reclaim'
        using errcode = 'P0001';
    end if;
  elsif old.status = 'leased' and new.status = 'pending' then
    if new.lease_version <> old.lease_version
       or new.attempt_count <> old.attempt_count then
      raise exception 'account_reactivation_legacy_repair_invalid_retry'
        using errcode = 'P0001';
    end if;
  elsif old.status = 'pending' and new.status = 'pending' then
    if new.lease_version <> old.lease_version
       or new.attempt_count <> old.attempt_count
       or (
         old.lease_version <> 2147483647
         and old.attempt_count <> 2147483647
       )
       or new.last_error <> 'lease_counter_exhausted'
       or new.next_attempt_at <>
            '9999-12-31 23:59:59+00'::timestamptz then
      raise exception
        'account_reactivation_legacy_repair_invalid_quarantine'
        using errcode = 'P0001';
    end if;
  elsif new.status in ('completed', 'superseded')
        and old.status in ('pending', 'leased') then
    if new.lease_version <> old.lease_version
       or new.attempt_count <> old.attempt_count then
      raise exception 'account_reactivation_legacy_repair_invalid_finish'
        using errcode = 'P0001';
    end if;
  else
    raise exception 'account_reactivation_legacy_repair_invalid_transition'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function
  public.bp_account_reactivation_legacy_repairs_guard()
  from public, anon, authenticated, service_role;

create trigger trg_account_reactivation_legacy_repairs_guard
  before update or delete
  on public.account_reactivation_legacy_repairs
  for each row
  execute function
    public.bp_account_reactivation_legacy_repairs_guard();

insert into public.account_reactivation_legacy_repairs(
  admin_user_id,
  user_id,
  expected_withdrawal_generation,
  resolved_email
)
select
  (
    select l.admin_user_id
      from public.account_admin_actions_ledger l
     where l.target_user_id = p.id
       and l.action_type = 'account_reactivate'
     order by l.created_at desc, l.id desc
     limit 1
  ),
  p.id,
  p.withdrawal_generation,
  pg_catalog.btrim(m.email)
from public.profiles p
join public.member_accounts m on m.user_id = p.id
left join auth.users u on u.id = p.id
where p.deleted_at is null
  and m.email is not null
  and pg_catalog.char_length(pg_catalog.btrim(m.email)) between 3 and 320
  and pg_catalog.lower(pg_catalog.btrim(m.email))
        not like '%@deleted.invalid'
  and pg_catalog.lower(pg_catalog.btrim(m.email)) ~
        '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  and (
    u.id is null
    or pg_catalog.lower(pg_catalog.btrim(u.email))
         is distinct from
           pg_catalog.lower(pg_catalog.btrim(m.email))
  )
on conflict (user_id, expected_withdrawal_generation) do nothing;

create or replace function
  public.bp_enqueue_legacy_account_reactivation_repair()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null
     or new.deleted_at is not null then
    return null;
  end if;

  -- Deferred until transaction end because the legacy implementation clears
  -- profiles.deleted_at before restoring member_accounts.email. The current
  -- row values now represent the final transaction state. New fenced
  -- reactivation has already restored Auth, so its real Auth email excludes
  -- it from this permanent rolling-transition repair outbox.
  insert into public.account_reactivation_legacy_repairs(
    admin_user_id,
    user_id,
    expected_withdrawal_generation,
    resolved_email
  )
  select
    (
      select l.admin_user_id
        from public.account_admin_actions_ledger l
       where l.target_user_id = new.id
         and l.action_type = 'account_reactivate'
       order by l.created_at desc, l.id desc
       limit 1
    ),
    new.id,
    new.withdrawal_generation,
    pg_catalog.btrim(m.email)
    from public.member_accounts m
    left join auth.users u on u.id = m.user_id
   where m.user_id = new.id
     and m.email is not null
     and pg_catalog.char_length(pg_catalog.btrim(m.email))
           between 3 and 320
     and pg_catalog.lower(pg_catalog.btrim(m.email))
           not like '%@deleted.invalid'
     and pg_catalog.lower(pg_catalog.btrim(m.email)) ~
           '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     and (
       u.id is null
       or pg_catalog.lower(pg_catalog.btrim(u.email))
            is distinct from
              pg_catalog.lower(pg_catalog.btrim(m.email))
     )
  on conflict (user_id, expected_withdrawal_generation) do nothing;
  return null;
end;
$$;
revoke all on function
  public.bp_enqueue_legacy_account_reactivation_repair()
  from public, anon, authenticated, service_role;

create constraint trigger
  trg_profiles_enqueue_legacy_account_reactivation_repair
  after update of deleted_at on public.profiles
  deferrable initially deferred
  for each row
  when (
    old.deleted_at is not null
    and new.deleted_at is null
  )
  execute function
    public.bp_enqueue_legacy_account_reactivation_repair();

-- A pending external intent owns this exact deleted_at lifecycle. Completion
-- marks the job completed in the same transaction immediately before the
-- profile transition. Every other path (including a stale old RPC or a manual
-- timestamp rewrite) is fenced until the receipt-bound job converges.
create or replace function public.bp_fence_account_reactivation_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is distinct from new.deleted_at
     and exists (
       select 1
         from public.account_reactivation_jobs j
        where j.user_id = new.id
          and j.status in ('pending', 'leased')
     ) then
    raise exception 'account_reactivation_in_progress'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_fence_account_reactivation_lifecycle()
  from public, anon, authenticated, service_role;

create trigger trg_profiles_fence_account_reactivation_lifecycle
  before update of deleted_at on public.profiles
  for each row
  execute function public.bp_fence_account_reactivation_lifecycle();

create or replace function public.bp_admin_mutation_requests_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'admin_mutation_request_append_only'
      using errcode = 'P0001';
  end if;
  if old.request_id is distinct from new.request_id
     or old.admin_user_id is distinct from new.admin_user_id
     or old.operation is distinct from new.operation
     or old.target_key is distinct from new.target_key
     or old.request_payload is distinct from new.request_payload
     or old.payload_sha256 is distinct from new.payload_sha256
     or old.created_at is distinct from new.created_at then
    raise exception 'admin_mutation_request_immutable'
      using errcode = 'P0001';
  end if;
  if old.state <> 'pending'
     or new.state not in ('completed', 'cancelled')
     or old.result is not null
     or new.result is null
     or old.completed_at is not null
     or new.completed_at is null then
    raise exception 'admin_mutation_request_invalid_transition'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_admin_mutation_requests_guard()
  from public, anon, authenticated, service_role;

create trigger trg_admin_mutation_requests_guard
  before update or delete on public.admin_mutation_requests
  for each row execute function public.bp_admin_mutation_requests_guard();

create or replace function public.bp_admin_mutation_payload_sha256(
  p_payload jsonb
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;
revoke all on function public.bp_admin_mutation_payload_sha256(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.bp_admin_mutation_request_lock(
  p_request_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_request_id is null then
    raise exception 'request_id_invalid' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'admin-mutation-request:' || p_request_id::text,
      0
    )
  );
end;
$$;
revoke all on function public.bp_admin_mutation_request_lock(uuid)
  from public, anon, authenticated, service_role;

-- Returns NULL for a new request, a stored result for a completed request, or
-- {"_state":"pending"} for the reactivation external-sync stage.
create or replace function public.bp_admin_mutation_replay(
  p_admin uuid,
  p_request_id uuid,
  p_operation text,
  p_target_key text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.admin_mutation_requests%rowtype;
begin
  perform public.bp_admin_mutation_request_lock(p_request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = p_request_id;
  if not found then
    return null;
  end if;
  if v_request.admin_user_id is distinct from p_admin
     or v_request.operation is distinct from p_operation
     or v_request.target_key is distinct from p_target_key then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_request.state = 'aborted' then
    raise exception 'request_aborted' using errcode = 'P0001';
  end if;
  if v_request.request_payload is distinct from p_payload then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_request.state = 'pending' then
    return pg_catalog.jsonb_build_object('_state', 'pending');
  end if;
  return v_request.result
    || pg_catalog.jsonb_build_object('idempotent', true);
end;
$$;
revoke all on function public.bp_admin_mutation_replay(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.bp_admin_mutation_store_completed(
  p_request_id uuid,
  p_admin uuid,
  p_operation text,
  p_target_key text,
  p_payload jsonb,
  p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_result is null
     or pg_catalog.jsonb_typeof(p_result) <> 'object'
     or p_result->>'ok' is distinct from 'true' then
    raise exception 'invalid_operation_result' using errcode = 'P0001';
  end if;
  insert into public.admin_mutation_requests(
    request_id,
    admin_user_id,
    operation,
    target_key,
    state,
    request_payload,
    payload_sha256,
    result,
    completed_at
  )
  values (
    p_request_id,
    p_admin,
    p_operation,
    p_target_key,
    'completed',
    p_payload,
    public.bp_admin_mutation_payload_sha256(p_payload),
    p_result,
    clock_timestamp()
  );
end;
$$;
revoke all on function public.bp_admin_mutation_store_completed(
  uuid, uuid, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.get_admin_mutation_receipt(
  p_admin uuid,
  p_request_id uuid,
  p_operation text,
  p_target_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.admin_mutation_requests%rowtype;
begin
  perform public.bp_assert_active_admin(p_admin);
  if p_operation not in (
    'config_update',
    'event_save',
    'event_publish',
    'event_unpublish',
    'event_delete',
    'moderation_takedown',
    'moderation_dismiss',
    'moderation_restore',
    'moderation_permanent_delete',
    'integrity_clear',
    'integrity_void',
    'integrity_ban',
    'integrity_unban'
  ) or p_target_key is null
    or pg_catalog.char_length(p_target_key) not between 1 and 200 then
    raise exception 'invalid_request_context' using errcode = 'P0001';
  end if;

  perform public.bp_admin_mutation_request_lock(p_request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = p_request_id;
  if not found then
    insert into public.admin_mutation_requests(
      request_id,
      admin_user_id,
      operation,
      target_key,
      state,
      completed_at
    )
    values (
      p_request_id,
      p_admin,
      p_operation,
      p_target_key,
      'aborted',
      clock_timestamp()
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'state', 'aborted',
      'result', null
    );
  end if;
  if v_request.admin_user_id is distinct from p_admin
     or v_request.operation is distinct from p_operation
     or v_request.target_key is distinct from p_target_key then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'state', v_request.state,
    'result', v_request.result
  );
end;
$$;
revoke all on function public.get_admin_mutation_receipt(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.get_admin_mutation_receipt(
  uuid, uuid, text, text
) to service_role;

-- ── 2. Config publish/restore exactly-once ─────────────────────────────────

create or replace function public.admin_update_app_setting_idempotent(
  p_key text,
  p_value jsonb,
  p_base_version int,
  p_admin_id uuid,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  v_payload := pg_catalog.jsonb_build_object(
    'key', p_key,
    'value', p_value,
    'base_version', p_base_version,
    'note', p_note
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    'config_update',
    p_key,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  v_result := public.admin_update_app_setting(
    p_key,
    p_value,
    p_base_version,
    p_admin_id,
    p_note
  );
  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    'config_update',
    p_key,
    v_payload,
    v_result || pg_catalog.jsonb_build_object('idempotent', false)
  );
  return v_result || pg_catalog.jsonb_build_object('idempotent', false);
end;
$$;
revoke all on function public.admin_update_app_setting_idempotent(
  text, jsonb, integer, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_update_app_setting_idempotent(
  text, jsonb, integer, uuid, text, uuid
) to service_role;

revoke all on function public.admin_update_app_setting(
  text, jsonb, integer, uuid, text
) from service_role;

-- ── 3. Event version/CAS + exactly-once create and transitions ─────────────

alter table public.events
  add column mutation_version bigint not null default 0
    check (mutation_version between 0 and 9007199254740991);

create or replace function public.admin_save_event_idempotent(
  p_id uuid,
  p_type text,
  p_title text,
  p_summary text,
  p_body text,
  p_cover_image_path text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_popup_active boolean,
  p_banner_home_active boolean,
  p_banner_gallery_active boolean,
  p_banner_leaderboard_active boolean,
  p_priority int,
  p_pinned boolean,
  p_noindex boolean,
  p_popup_dismiss_days int,
  p_admin_id uuid,
  p_expected_version bigint,
  p_request_id uuid,
  p_target_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_event public.events%rowtype;
  v_existing public.admin_mutation_requests%rowtype;
  v_id uuid;
  v_version bigint;
  v_cover text := nullif(
    pg_catalog.btrim(coalesce(p_cover_image_path, '')),
    ''
  );
  v_same boolean;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'version_invalid' using errcode = 'P0001';
  end if;
  if p_target_key is null
     or pg_catalog.char_length(p_target_key) not between 1 and 200
     or (
       p_id is not null
       and p_target_key is distinct from p_id::text
     )
     or (
       p_id is null
       and p_target_key !~ (
         '^new:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-'
         || '[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
     ) then
    raise exception 'target_key_invalid' using errcode = 'P0001';
  end if;
  if p_type not in ('notice', 'event') then
    raise exception 'invalid_type' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, '')))
       not between 1 and 200 then
    raise exception 'invalid_title' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, '')))
       not between 1 and 200 then
    raise exception 'invalid_summary' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, '')))
       not between 1 and 50000 then
    raise exception 'invalid_body' using errcode = 'P0001';
  end if;
  if p_popup_dismiss_days is null
     or p_popup_dismiss_days not between 1 and 365 then
    raise exception 'invalid_dismiss_days' using errcode = 'P0001';
  end if;
  if p_starts_at is not null
     and p_ends_at is not null
     and p_starts_at >= p_ends_at then
    raise exception 'invalid_window' using errcode = 'P0001';
  end if;
  if v_cover is not null and not (
    pg_catalog.char_length(v_cover) <= 300
    and pg_catalog.strpos(v_cover, '://') = 0
    and pg_catalog.left(v_cover, 1) <> '/'
    and pg_catalog.strpos(v_cover, '..') = 0
    and v_cover !~* '\.svg$'
  ) then
    raise exception 'invalid_cover' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'id', p_id,
    'type', p_type,
    'title', pg_catalog.btrim(p_title),
    'summary', pg_catalog.btrim(p_summary),
    'body', p_body,
    'cover_image_path', v_cover,
    'starts_at', p_starts_at,
    'ends_at', p_ends_at,
    'popup_active', coalesce(p_popup_active, false),
    'banner_home_active', coalesce(p_banner_home_active, false),
    'banner_gallery_active', coalesce(p_banner_gallery_active, false),
    'banner_leaderboard_active',
      coalesce(p_banner_leaderboard_active, false),
    'priority', coalesce(p_priority, 0),
    'pinned', coalesce(p_pinned, false),
    'noindex', coalesce(p_noindex, false),
    'popup_dismiss_days', p_popup_dismiss_days,
    'expected_version', p_expected_version,
    'target_key', p_target_key
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    'event_save',
    p_target_key,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if p_id is null then
    -- target_key is the durable create intent, while request_id identifies a
    -- particular delivery attempt.  Serialize different request UUIDs for the
    -- same intent before the legacy admin-level create lock and bind that
    -- intent permanently to one exact payload/result.  This closes the
    -- response-loss case where client storage survives but a caller rotates
    -- only the delivery UUID.
    perform public.bp_mutation_object_lock(
      'event-create-intent',
      p_target_key
    );
    select *
      into v_existing
      from public.admin_mutation_requests r
     where r.operation = 'event_save'
       and r.target_key = p_target_key
       and r.state = 'completed'
     order by r.completed_at, r.request_id
     limit 1;
    if found then
      if v_existing.admin_user_id is distinct from p_admin_id
         or v_existing.request_payload is distinct from v_payload then
        raise exception 'idempotency_conflict' using errcode = 'P0001';
      end if;
      v_result := v_existing.result
        || pg_catalog.jsonb_build_object('idempotent', true);
      perform public.bp_admin_mutation_store_completed(
        p_request_id,
        p_admin_id,
        'event_save',
        p_target_key,
        v_payload,
        v_result
      );
      return v_result;
    end if;
    if p_expected_version <> 0 then
      raise exception 'version_conflict' using errcode = 'P0001';
    end if;
    v_id := public.admin_save_event(
      null,
      p_type,
      p_title,
      p_summary,
      p_body,
      v_cover,
      p_starts_at,
      p_ends_at,
      p_popup_active,
      p_banner_home_active,
      p_banner_gallery_active,
      p_banner_leaderboard_active,
      p_priority,
      p_pinned,
      p_noindex,
      p_popup_dismiss_days,
      p_admin_id
    );
    update public.events
       set mutation_version = 1
     where id = v_id
    returning mutation_version into v_version;
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('event:' || p_id::text)::bigint
    );
    select *
      into v_event
      from public.events e
     where e.id = p_id
     for update;
    if not found or v_event.deleted_at is not null then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    v_same :=
      v_event.type is not distinct from p_type
      and v_event.title is not distinct from pg_catalog.btrim(p_title)
      and v_event.summary is not distinct from pg_catalog.btrim(p_summary)
      and v_event.body is not distinct from p_body
      and v_event.cover_image_path is not distinct from v_cover
      and v_event.starts_at is not distinct from p_starts_at
      and v_event.ends_at is not distinct from p_ends_at
      and v_event.popup_active
        is not distinct from coalesce(p_popup_active, false)
      and v_event.banner_home_active
        is not distinct from coalesce(p_banner_home_active, false)
      and v_event.banner_gallery_active
        is not distinct from coalesce(p_banner_gallery_active, false)
      and v_event.banner_leaderboard_active
        is not distinct from
          coalesce(p_banner_leaderboard_active, false)
      and v_event.priority
        is not distinct from coalesce(p_priority, 0)
      and v_event.pinned
        is not distinct from coalesce(p_pinned, false)
      and v_event.noindex
        is not distinct from coalesce(p_noindex, false)
      and v_event.popup_dismiss_days
        is not distinct from p_popup_dismiss_days;
    if v_same then
      -- A same-state response is only a valid no-op for the snapshot the
      -- caller actually read, or for the immediately following version made
      -- by an equivalent concurrent save.  Without this fence, a very old
      -- tab could be accepted after A -> B -> A cycled back to identical
      -- content, defeating the CAS token.
      if not (
        v_event.mutation_version = p_expected_version
        or (
          v_event.mutation_version > 0
          and v_event.mutation_version - 1 = p_expected_version
        )
      ) then
        raise exception 'version_conflict' using errcode = 'P0001';
      end if;
      v_id := p_id;
      v_version := v_event.mutation_version;
    else
      if v_event.mutation_version <> p_expected_version then
        raise exception 'version_conflict' using errcode = 'P0001';
      end if;
      if v_event.mutation_version = 9007199254740991 then
        raise exception 'mutation_version_exhausted' using errcode = 'P0001';
      end if;
      v_id := public.admin_save_event(
        p_id,
        p_type,
        p_title,
        p_summary,
        p_body,
        v_cover,
        p_starts_at,
        p_ends_at,
        p_popup_active,
        p_banner_home_active,
        p_banner_gallery_active,
        p_banner_leaderboard_active,
        p_priority,
        p_pinned,
        p_noindex,
        p_popup_dismiss_days,
        p_admin_id
      );
      update public.events
         set mutation_version = mutation_version + 1
       where id = v_id
      returning mutation_version into v_version;
    end if;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'version', v_version,
    'noOp', coalesce(v_same, false),
    'idempotent', false
  );
  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    'event_save',
    p_target_key,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.admin_save_event_idempotent(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, boolean, integer, boolean, boolean, integer,
  uuid, bigint, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_event_idempotent(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, boolean, integer, boolean, boolean, integer,
  uuid, bigint, uuid, text
) to service_role;

create or replace function public.admin_transition_event_idempotent(
  p_id uuid,
  p_action text,
  p_expected_version bigint,
  p_admin_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_event public.events%rowtype;
  v_version bigint;
  v_no_op boolean := false;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_id is null
     or p_expected_version is null
     or p_expected_version < 0 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_operation := case p_action
    when 'publish' then 'event_publish'
    when 'unpublish' then 'event_unpublish'
    when 'delete' then 'event_delete'
    else null
  end;
  if v_operation is null then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
  v_payload := pg_catalog.jsonb_build_object(
    'id', p_id,
    'action', p_action,
    'expected_version', p_expected_version
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    v_operation,
    p_id::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('event:' || p_id::text)::bigint
  );
  select *
    into v_event
    from public.events e
   where e.id = p_id
   for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if p_action = 'delete' and v_event.deleted_at is not null then
    v_no_op := true;
  elsif v_event.deleted_at is not null then
    raise exception 'not_found' using errcode = 'P0001';
  elsif p_action = 'publish' and v_event.status = 'published' then
    v_no_op := true;
  elsif p_action = 'unpublish' and v_event.status = 'draft' then
    v_no_op := true;
  end if;

  if v_no_op then
    -- Permit an already-current request and a distinct equivalent request
    -- that lost the race by exactly one transition.  Reject older snapshots
    -- even if the event later cycled back to the same status/deleted state.
    if not (
      v_event.mutation_version = p_expected_version
      or (
        v_event.mutation_version > 0
        and v_event.mutation_version - 1 = p_expected_version
      )
    ) then
      raise exception 'version_conflict' using errcode = 'P0001';
    end if;
    v_version := v_event.mutation_version;
  else
    if v_event.mutation_version <> p_expected_version then
      raise exception 'version_conflict' using errcode = 'P0001';
    end if;
    if v_event.mutation_version = 9007199254740991 then
      raise exception 'mutation_version_exhausted' using errcode = 'P0001';
    end if;
    if p_action = 'publish' then
      perform public.admin_publish_event(p_id, p_admin_id);
    elsif p_action = 'unpublish' then
      perform public.admin_unpublish_event(p_id, p_admin_id);
    else
      perform public.admin_delete_event(p_id, p_admin_id);
    end if;
    update public.events
       set mutation_version = mutation_version + 1
     where id = p_id
    returning mutation_version into v_version;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'id', p_id,
    'version', v_version,
    'state', case
      when p_action = 'delete' then 'deleted'
      when p_action = 'publish' then 'published'
      else 'draft'
    end,
    'noOp', v_no_op,
    'idempotent', false
  );
  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    v_operation,
    p_id::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.admin_transition_event_idempotent(
  uuid, text, bigint, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_transition_event_idempotent(
  uuid, text, bigint, uuid, uuid
) to service_role;

revoke all on function public.admin_save_event(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, boolean, integer, boolean, boolean, integer, uuid
) from service_role;
revoke all on function public.admin_save_event(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, integer, boolean, boolean, integer, uuid
) from service_role;
revoke all on function public.admin_publish_event(uuid, uuid)
  from service_role;
revoke all on function public.admin_unpublish_event(uuid, uuid)
  from service_role;
revoke all on function public.admin_delete_event(uuid, uuid)
  from service_role;

-- ── 4. Reversible moderation actions: versioned CAS + receipt ──────────────

alter table public.dolls
  add column moderation_version bigint not null default 0
    check (moderation_version between 0 and 9007199254740991);

create or replace function public.bp_bump_doll_moderation_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state_changed boolean :=
    old.deleted_at is distinct from new.deleted_at
    or old.artifacts_purged_at is distinct from new.artifacts_purged_at;
begin
  if old.moderation_version = 9007199254740991
     and (
       v_state_changed
       or new.moderation_version is distinct from old.moderation_version
     ) then
    raise exception 'moderation_version_exhausted' using errcode = 'P0001';
  end if;
  if v_state_changed then
    new.moderation_version := old.moderation_version + 1;
  elsif new.moderation_version = old.moderation_version + 1 then
    -- content_reports' trigger advances the doll snapshot token.
    null;
  elsif new.moderation_version is distinct from old.moderation_version then
    raise exception 'moderation_version_invalid' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_bump_doll_moderation_version()
  from public, anon, authenticated, service_role;

create trigger trg_dolls_bump_moderation_version
  before update on public.dolls
  for each row execute function public.bp_bump_doll_moderation_version();

create or replace function public.bp_touch_report_doll_moderation_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_doll_id uuid;
begin
  if tg_op = 'UPDATE'
     and old.target_type is not distinct from new.target_type
     and old.target_id is not distinct from new.target_id
     and old.status is not distinct from new.status then
    return new;
  end if;
  for v_doll_id in
    select distinct q.doll_id
      from (
        select case
          when tg_op in ('UPDATE', 'DELETE')
           and old.target_type = 'doll'
          then old.target_id
          else null
        end as doll_id
        union all
        select case
          when tg_op in ('UPDATE', 'INSERT')
           and new.target_type = 'doll'
          then new.target_id
          else null
        end
      ) q
     where q.doll_id is not null
     order by q.doll_id
  loop
    update public.dolls
       set moderation_version = moderation_version + 1
     where id = v_doll_id;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.bp_touch_report_doll_moderation_version()
  from public, anon, authenticated, service_role;

create trigger trg_content_reports_touch_doll_moderation_version
  after insert or delete or update of target_type, target_id, status
  on public.content_reports
  for each row execute function
    public.bp_touch_report_doll_moderation_version();

-- Preserve the queue's catalog signature while adding the snapshot version
-- consumed by admin action preconditions.
create or replace function public.admin_moderation_queue(
  p_admin_id uuid,
  p_state text,
  p_doll_id uuid,
  p_owner_id uuid,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.bp_assert_active_admin(p_admin_id);

  with cand as (
    select
      d.id,
      d.image_url,
      d.owner_id,
      d.deleted_at,
      d.artifacts_purged_at,
      d.moderation_version
    from public.dolls d
    where d.deleted_at is not null
       or exists (
         select 1
           from public.content_reports r
          where r.target_type = 'doll'
            and r.target_id = d.id
       )
  ),
  agg as (
    select
      c.id,
      c.image_url,
      c.owner_id,
      c.deleted_at,
      c.artifacts_purged_at,
      c.moderation_version,
      pr.display_name as owner_name,
      coalesce(rc.report_count, 0) as report_count,
      coalesce(rc.pending_count, 0) as pending_count,
      rc.latest_report_at,
      case
        when c.artifacts_purged_at is not null then 'purged'
        when c.deleted_at is not null then 'hidden'
        when coalesce(rc.pending_count, 0) > 0 then 'pending'
        else 'dismissed'
      end as state
    from cand c
    left join public.profiles pr on pr.id = c.owner_id
    left join lateral (
      select
        pg_catalog.count(*) as report_count,
        pg_catalog.count(*) filter (
          where r.status = 'pending'
        ) as pending_count,
        pg_catalog.max(r.created_at) as latest_report_at
      from public.content_reports r
      where r.target_type = 'doll'
        and r.target_id = c.id
    ) rc on true
  ),
  filtered as (
    select a.*, pg_catalog.count(*) over() as total
      from agg a
     where (p_state is null or a.state = p_state)
       and (p_doll_id is null or a.id = p_doll_id)
       and (p_owner_id is null or a.owner_id = p_owner_id)
  ),
  page as (
    select *
      from filtered
     order by
       coalesce(latest_report_at, deleted_at) desc nulls last,
       id
     limit least(greatest(coalesce(p_limit, 10), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select pg_catalog.jsonb_build_object(
    'total',
      coalesce((select pg_catalog.max(total) from filtered), 0),
    'rows',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'dollId', p.id,
              'image_url', p.image_url,
              'owner_id', p.owner_id,
              'owner_name', p.owner_name,
              'deleted_at', p.deleted_at,
              'artifacts_purged_at', p.artifacts_purged_at,
              'moderationVersion', p.moderation_version,
              'state', p.state,
              'report_count', p.report_count,
              'pending_count', p.pending_count,
              'latest_report_at', p.latest_report_at,
              'reports_truncated', p.report_count > 100,
              'reports',
                coalesce(
                  (
                    select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'id', r.id,
                        'reason', r.reason,
                        'detail', r.detail,
                        'contact', r.reporter_contact,
                        'status', r.status,
                        'created_at', r.created_at
                      )
                      order by r.created_at desc, r.id desc
                    )
                    from (
                      select
                        r.id,
                        r.reason,
                        r.detail,
                        r.reporter_contact,
                        r.status,
                        r.created_at
                      from public.content_reports r
                      where r.target_type = 'doll'
                        and r.target_id = p.id
                      order by r.created_at desc, r.id desc
                      limit 100
                    ) r
                  ),
                  '[]'::jsonb
                )
            )
            order by
              coalesce(
                p.latest_report_at,
                p.deleted_at
              ) desc nulls last,
              p.id
          )
          from page p
        ),
        '[]'::jsonb
      )
  )
    into v_result;
  return v_result;
end;
$$;
revoke all on function public.admin_moderation_queue(
  uuid, text, uuid, uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.admin_moderation_queue(
  uuid, text, uuid, uuid, integer, integer
) to service_role;

create or replace function public.admin_moderation_action_idempotent(
  p_action text,
  p_admin_id uuid,
  p_doll_id uuid,
  p_reason text,
  p_expected_state text,
  p_expected_version bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation text;
  v_desired text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_doll public.dolls%rowtype;
  v_pending bigint;
  v_current text;
  v_next_version bigint;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_doll_id is null then
    raise exception 'target_invalid' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(
       coalesce(p_reason, '')
     )) not between 5 and 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  if p_expected_state not in (
    'pending', 'hidden', 'purged', 'dismissed'
  ) then
    raise exception 'state_invalid' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'version_invalid' using errcode = 'P0001';
  end if;
  v_operation := case p_action
    when 'takedown' then 'moderation_takedown'
    when 'dismiss' then 'moderation_dismiss'
    when 'restore' then 'moderation_restore'
    else null
  end;
  v_desired := case p_action
    when 'takedown' then 'hidden'
    when 'dismiss' then 'dismissed'
    when 'restore' then 'dismissed'
    else null
  end;
  if v_operation is null then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'action', p_action,
    'doll_id', p_doll_id,
    'reason', pg_catalog.btrim(p_reason),
    'expected_state', p_expected_state,
    'expected_version', p_expected_version
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    v_operation,
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
  select pg_catalog.count(*)
    into v_pending
    from public.content_reports r
   where r.target_type = 'doll'
     and r.target_id = p_doll_id
     and r.status = 'pending';
  v_current := case
    when v_doll.artifacts_purged_at is not null then 'purged'
    when v_doll.deleted_at is not null then 'hidden'
    when v_pending > 0 then 'pending'
    else 'dismissed'
  end;

  if v_current = 'purged' then
    raise exception 'already_purged' using errcode = 'P0001';
  end if;
  if v_current = v_desired then
    if v_current is distinct from p_expected_state
       or v_doll.moderation_version <> p_expected_version then
      raise exception 'state_conflict' using errcode = 'P0001';
    end if;
    v_next_version := v_doll.moderation_version;
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'previousState', v_current,
      'nextState', v_desired,
      'version', v_next_version,
      'dismissed', 0,
      'noOp', true,
      'idempotent', false
    );
  else
    if v_current is distinct from p_expected_state
       or v_doll.moderation_version <> p_expected_version then
      raise exception 'state_conflict' using errcode = 'P0001';
    end if;
    if p_action = 'takedown'
       and v_current not in ('pending', 'dismissed') then
      raise exception 'state_conflict' using errcode = 'P0001';
    elsif p_action = 'dismiss' and v_current <> 'pending' then
      raise exception 'state_conflict' using errcode = 'P0001';
    elsif p_action = 'restore' and v_current <> 'hidden' then
      raise exception 'state_conflict' using errcode = 'P0001';
    end if;

    if p_action = 'takedown' then
      v_result := public.admin_takedown_doll(
        p_admin_id, p_doll_id, pg_catalog.btrim(p_reason)
      );
    elsif p_action = 'dismiss' then
      v_result := public.admin_dismiss_doll(
        p_admin_id, p_doll_id, pg_catalog.btrim(p_reason)
      );
    else
      v_result := public.admin_restore_doll(
        p_admin_id, p_doll_id, pg_catalog.btrim(p_reason)
      );
    end if;
    select d.moderation_version
      into v_next_version
      from public.dolls d
     where d.id = p_doll_id;
    v_result := v_result || pg_catalog.jsonb_build_object(
      'previousState', v_current,
      'nextState', v_desired,
      'version', v_next_version,
      'dismissed',
        case
          when p_action = 'dismiss'
          then coalesce((v_result->>'dismissed')::integer, 0)
          else 0
        end,
      'noOp', false,
      'idempotent', false
    );
  end if;

  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    v_operation,
    p_doll_id::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.admin_moderation_action_idempotent(
  text, uuid, uuid, text, text, bigint, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_moderation_action_idempotent(
  text, uuid, uuid, text, text, bigint, uuid
) to service_role;

-- Permanent deletion reuses the 0078 fenced Storage saga, but adds the same
-- exact-payload receipt and snapshot CAS used by reversible moderation. Replay
-- must happen before consulting current state: the physical purge can advance
-- moderation_version after the begin response was lost, while the original
-- request still needs to recover the exact durable job ID.
create or replace function public.admin_begin_doll_purge_idempotent(
  p_admin_id uuid,
  p_doll_id uuid,
  p_reason text,
  p_expected_state text,
  p_expected_version bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_doll public.dolls%rowtype;
  v_pending bigint;
  v_current text;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_doll_id is null then
    raise exception 'target_invalid' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(
       coalesce(p_reason, '')
     )) not between 5 and 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  if p_expected_state is distinct from 'hidden' then
    raise exception 'state_invalid' using errcode = 'P0001';
  end if;
  if p_expected_version is null
     or p_expected_version < 0
     or p_expected_version > 9007199254740991 then
    raise exception 'version_invalid' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'action', 'permanent_delete',
    'doll_id', p_doll_id,
    'reason', pg_catalog.btrim(p_reason),
    'expected_state', p_expected_state,
    'expected_version', p_expected_version
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    'moderation_permanent_delete',
    p_doll_id::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- This lock stays held through the legacy begin implementation. It is the
  -- shared ordering point for restore, moderation_version, and purge-job
  -- creation, so no hidden -> restored -> hidden ABA can cross this CAS.
  select *
    into v_doll
    from public.dolls d
   where d.id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  select pg_catalog.count(*)
    into v_pending
    from public.content_reports r
   where r.target_type = 'doll'
     and r.target_id = p_doll_id
     and r.status = 'pending';
  v_current := case
    when v_doll.artifacts_purged_at is not null then 'purged'
    when v_doll.deleted_at is not null then 'hidden'
    when v_pending > 0 then 'pending'
    else 'dismissed'
  end;
  if v_current is distinct from p_expected_state
     or v_doll.moderation_version <> p_expected_version then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;

  v_result := public.admin_begin_doll_purge(
    p_admin_id,
    p_doll_id,
    pg_catalog.btrim(p_reason)
  ) || pg_catalog.jsonb_build_object(
    'previousState', v_current,
    'version', v_doll.moderation_version,
    'idempotent', false
  );
  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    'moderation_permanent_delete',
    p_doll_id::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.admin_begin_doll_purge_idempotent(
  uuid, uuid, text, text, bigint, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_begin_doll_purge_idempotent(
  uuid, uuid, text, text, bigint, uuid
) to service_role;

-- claim_moderation_purge returns NULL both for a terminal job and for a
-- currently leased/backed-off job. This correlated read is the authority that
-- lets a response-loss retry distinguish those cases without making the
-- append-only begin receipt mutable.
create or replace function public.get_moderation_purge_status(
  p_admin_id uuid,
  p_job_id uuid,
  p_doll_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.moderation_purge_jobs%rowtype;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_job_id is null or p_doll_id is null then
    raise exception 'target_invalid' using errcode = 'P0001';
  end if;
  select *
    into v_job
    from public.moderation_purge_jobs j
   where j.id = p_job_id
     and j.doll_id = p_doll_id
     and j.admin_user_id = p_admin_id;
  if not found then
    raise exception 'purge_job_not_found' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'doll_id', v_job.doll_id,
    'status', v_job.status,
    'attempt_count', v_job.attempt_count
  );
end;
$$;
revoke all on function public.get_moderation_purge_status(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_moderation_purge_status(
  uuid, uuid, uuid
) to service_role;

-- Keep legacy grants during the migration window. A pre-0085 server still
-- calls the 0078 begin RPC, while the new server uses the receipt-bearing
-- wrapper above. The contract migration closes the legacy external surface.

-- ── 5. Integrity actions: expected-state CAS + duplicate no-op ──────────────

alter table public.scores
  add column integrity_version bigint not null default 0
    check (integrity_version between 0 and 9007199254740991);
alter table public.member_accounts
  add column integrity_version bigint not null default 0
    check (integrity_version between 0 and 9007199254740991);

-- Status transitions can also be made by the integrity scanner and the
-- score-submission/ban paths. A trigger, rather than only the admin wrapper,
-- makes the version a complete monotonic history token for every writer.
create or replace function public.bp_bump_integrity_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status_changed boolean;
begin
  if tg_table_name = 'scores' then
    v_status_changed := old.review_status is distinct from new.review_status;
  elsif tg_table_name = 'member_accounts' then
    v_status_changed := old.abuse_status is distinct from new.abuse_status;
  else
    raise exception 'integrity_version_trigger_table_invalid'
      using errcode = 'P0001';
  end if;

  if v_status_changed then
    if old.integrity_version = 9007199254740991 then
      raise exception 'integrity_version_exhausted' using errcode = 'P0001';
    end if;
    new.integrity_version := old.integrity_version + 1;
  elsif new.integrity_version is distinct from old.integrity_version then
    raise exception 'integrity_version_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_bump_integrity_version()
  from public, anon, authenticated, service_role;

create trigger trg_scores_bump_integrity_version
  before update on public.scores
  for each row execute function public.bp_bump_integrity_version();
create trigger trg_member_accounts_bump_integrity_version
  before update on public.member_accounts
  for each row execute function public.bp_bump_integrity_version();

create or replace function public.admin_integrity_action_idempotent(
  p_action text,
  p_admin_id uuid,
  p_target_id uuid,
  p_reason text,
  p_expected_state text,
  p_expected_version bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_owner_hint uuid;
  v_owner uuid;
  v_current text;
  v_desired text;
  v_current_version bigint;
  v_next_version bigint;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_target_id is null then
    raise exception 'target_invalid' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'version_invalid' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(coalesce(p_reason, ''))
       not between 5 and 500 then
    raise exception 'reason_invalid' using errcode = 'P0001';
  end if;
  v_operation := case p_action
    when 'clear' then 'integrity_clear'
    when 'void' then 'integrity_void'
    when 'ban' then 'integrity_ban'
    when 'unban' then 'integrity_unban'
    else null
  end;
  if v_operation is null then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
  if p_action in ('clear', 'void') then
    if p_expected_state not in (
      'registered', 'pending', 'cleared', 'voided'
    ) then
      raise exception 'state_invalid' using errcode = 'P0001';
    end if;
    v_desired := case p_action
      when 'clear' then 'cleared'
      else 'voided'
    end;
  else
    if p_expected_state not in ('clean', 'flagged', 'banned') then
      raise exception 'state_invalid' using errcode = 'P0001';
    end if;
    v_desired := case p_action
      when 'ban' then 'banned'
      else 'clean'
    end;
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'action', p_action,
    'target_id', p_target_id,
    'reason', p_reason,
    'expected_state', p_expected_state,
    'expected_version', p_expected_version
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    v_operation,
    p_target_id::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if p_action in ('clear', 'void') then
    select s.owner_id
      into v_owner_hint
      from public.scores s
     where s.id = p_target_id;
    if not found then
      raise exception 'score_not_found' using errcode = 'P0001';
    end if;
    perform public.bp_user_mutation_lock(v_owner_hint);
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('score:' || p_target_id::text)::bigint
    );
    select s.owner_id, s.review_status, s.integrity_version
      into v_owner, v_current, v_current_version
      from public.scores s
     where s.id = p_target_id
     for update;
    if not found then
      raise exception 'score_not_found' using errcode = 'P0001';
    end if;
    if v_owner is distinct from v_owner_hint then
      raise exception 'score_owner_changed_retry' using errcode = '40001';
    end if;
  else
    perform public.bp_user_mutation_lock(p_target_id);
    select m.abuse_status, m.integrity_version
      into v_current, v_current_version
      from public.member_accounts m
     where m.user_id = p_target_id
     for update;
    if not found then
      raise exception 'member_not_found' using errcode = 'P0001';
    end if;
  end if;

  if v_current = v_desired then
    -- A distinct concurrent request from the same snapshot may observe the
    -- immediately-next version and converge as a no-op. A delayed request
    -- after any later status cycle has a larger version and must fail closed.
    if not (
      (
        v_current is not distinct from p_expected_state
        and v_current_version = p_expected_version
      )
      or (
        v_current_version > 0
        and v_current_version - 1 = p_expected_version
      )
    ) then
      raise exception 'state_conflict' using errcode = 'P0001';
    end if;
    v_next_version := v_current_version;
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'previousStatus', v_current,
      'nextStatus', v_desired,
      'version', v_next_version,
      'noOp', true,
      'idempotent', false
    );
  else
    if v_current is distinct from p_expected_state
       or v_current_version <> p_expected_version then
      raise exception 'state_conflict' using errcode = 'P0001';
    end if;
    if p_action = 'clear' then
      v_result := public.admin_clear_score(
        p_admin_id, p_target_id, p_reason
      );
    elsif p_action = 'void' then
      v_result := public.admin_void_score(
        p_admin_id, p_target_id, p_reason
      );
    elsif p_action = 'ban' then
      v_result := public.admin_ban_member(
        p_admin_id, p_target_id, p_reason
      );
    else
      v_result := public.admin_unban_member(
        p_admin_id, p_target_id, p_reason
      );
    end if;
    if p_action in ('clear', 'void') then
      select s.integrity_version
        into v_next_version
        from public.scores s
       where s.id = p_target_id;
    else
      select m.integrity_version
        into v_next_version
        from public.member_accounts m
       where m.user_id = p_target_id;
    end if;
    v_result := v_result || pg_catalog.jsonb_build_object(
      'previousStatus', v_current,
      'nextStatus', v_desired,
      'version', v_next_version,
      'noOp', false,
      'idempotent', false
    );
  end if;

  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    v_operation,
    p_target_id::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.admin_integrity_action_idempotent(
  text, uuid, uuid, text, text, bigint, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_integrity_action_idempotent(
  text, uuid, uuid, text, text, bigint, uuid
) to service_role;

revoke all on function public.admin_clear_score(uuid, uuid, text)
  from service_role;
revoke all on function public.admin_void_score(uuid, uuid, text)
  from service_role;
revoke all on function public.admin_ban_member(uuid, uuid, text)
  from service_role;
revoke all on function public.admin_unban_member(uuid, uuid, text)
  from service_role;

-- ── 5. Account reactivation durable DB -> GoTrue saga ──────────────────────

-- Extend the shared rolling switch without dropping the earlier compatibility
-- features. The legacy wrapper rechecks this only after owning the global
-- email namespace lock; 0092 takes that same lock before flipping all
-- features false, closing the already-invoked-but-waiting interleaving.
create or replace function public.bp_rollout_compatibility_enabled(
  p_feature text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_feature in (
    'legacy_generation_transition',
    'legacy_score_submission',
    'legacy_checkout_reuse',
    'legacy_account_reactivation'
  );
$$;
revoke all on function public.bp_rollout_compatibility_enabled(text)
  from public, anon, authenticated, service_role;

-- Read-only preparation mirrors the final 0084 implementation's email
-- selection. The external GoTrue update happens while the profile remains
-- deleted; only complete_account_reactivation makes the account active.
create or replace function public.bp_prepare_account_reactivation_email(
  p_user_id uuid,
  p_email_override text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_identity_email text;
  v_email text;
  v_normalized text;
begin
  select u.raw_app_meta_data->>'provider'
    into v_provider
    from auth.users u
   where u.id = p_user_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select coalesce(i.email, i.identity_data->>'email')
    into v_identity_email
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
              coalesce(i.email, i.identity_data->>'email')
                is not null
            ) desc,
            i.created_at desc nulls last,
            i.id desc
   limit 1;

  v_email := nullif(
    pg_catalog.btrim(
      coalesce(v_identity_email, p_email_override)
    ),
    ''
  );
  if pg_catalog.lower(v_email) like '%@deleted.invalid' then
    v_email := nullif(
      pg_catalog.btrim(p_email_override),
      ''
    );
  end if;
  if v_email is null then
    raise exception 'identity_email_missing' using errcode = 'P0001';
  end if;
  v_normalized := pg_catalog.lower(v_email);
  if pg_catalog.char_length(v_email) > 320
     or v_normalized !~
          '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'reactivation_email_invalid' using errcode = 'P0001';
  end if;

  if exists (
    select 1
      from public.member_accounts m
      join public.profiles p on p.id = m.user_id
     where m.user_id <> p_user_id
       and p.deleted_at is null
       and pg_catalog.lower(pg_catalog.btrim(m.email)) = v_normalized
  ) then
    raise exception 'email_conflict' using errcode = 'P0001';
  end if;
  return v_email;
end;
$$;
revoke all on function public.bp_prepare_account_reactivation_email(
  uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.admin_begin_account_reactivation(
  p_user_id uuid,
  p_admin uuid,
  p_reason text,
  p_email_override text,
  p_expected_deleted_at timestamptz,
  p_expected_withdrawal_generation bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input_payload jsonb;
  v_payload jsonb;
  v_request public.admin_mutation_requests%rowtype;
  v_existing public.admin_mutation_requests%rowtype;
  v_deleted_at timestamptz;
  v_withdrawal_generation bigint;
  v_email text;
begin
  perform public.bp_assert_active_admin(p_admin);
  if p_user_id is null
     or p_expected_deleted_at is null
     or p_expected_withdrawal_generation is null
     or p_expected_withdrawal_generation not between 1 and 9007199254740991
     or pg_catalog.char_length(coalesce(p_reason, ''))
          not between 5 and 500 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_input_payload := pg_catalog.jsonb_build_object(
    'user_id', p_user_id,
    'reason', p_reason,
    'email_override',
      nullif(pg_catalog.btrim(p_email_override), ''),
    'expected_deleted_at', p_expected_deleted_at,
    'expected_withdrawal_generation', p_expected_withdrawal_generation
  );

  -- Unlike single-database mutations, this saga has a server-derived external
  -- side effect: the exact email written to GoTrue. Bind that resolved value
  -- to the pending receipt on the first begin. Replays must return the stored
  -- value rather than following mutable auth.identities data.
  perform public.bp_admin_mutation_request_lock(p_request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = p_request_id;
  if found then
    if v_request.admin_user_id is distinct from p_admin
       or v_request.operation <> 'account_reactivate'
       or v_request.target_key is distinct from p_user_id::text
       or v_request.request_payload - 'resolved_email'
            is distinct from v_input_payload then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    if v_request.state = 'aborted' then
      raise exception 'request_aborted' using errcode = 'P0001';
    elsif v_request.state in ('completed', 'cancelled') then
      if not exists (
        select 1
          from public.account_reactivation_jobs j
         where j.request_id = v_request.request_id
           and j.admin_user_id = p_admin
           and j.user_id = p_user_id
           and j.expected_deleted_at = p_expected_deleted_at
           and j.expected_withdrawal_generation =
                 p_expected_withdrawal_generation
           and pg_catalog.lower(j.resolved_email) =
                 pg_catalog.lower(
                   v_request.request_payload->>'resolved_email'
                 )
           and (
             (
               v_request.state = 'completed'
               and j.status = 'completed'
             )
             or (
               v_request.state = 'cancelled'
               and j.status = 'cancelled'
             )
           )
      ) then
        raise exception 'reactivation_job_invalid' using errcode = 'P0001';
      end if;
      return v_request.result
        || pg_catalog.jsonb_build_object('idempotent', true);
    end if;
    v_email := v_request.request_payload->>'resolved_email';
    if v_email is null then
      raise exception 'reactivation_receipt_invalid' using errcode = 'P0001';
    end if;
    if not exists (
      select 1
        from public.account_reactivation_jobs j
       where j.request_id = v_request.request_id
         and j.admin_user_id = p_admin
         and j.user_id = p_user_id
         and j.expected_deleted_at = p_expected_deleted_at
         and j.expected_withdrawal_generation =
               p_expected_withdrawal_generation
         and pg_catalog.lower(j.resolved_email) =
               pg_catalog.lower(v_email)
         and j.status in ('pending', 'leased')
    ) then
      raise exception 'reactivation_job_invalid' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'pending', true,
      'operationRequestId', p_request_id,
      'email', v_email,
      'idempotent', true
    );
  end if;

  -- Same order as 0084's public wrapper, but call the private implementation
  -- after taking the locks so this wrapper never reacquires an object lock
  -- after the user lock.
  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
  perform public.bp_user_mutation_lock(p_user_id);

  -- A different tab/request can resume the exact same lifecycle operation.
  select *
    into v_existing
    from public.admin_mutation_requests r
   where r.operation = 'account_reactivate'
     and r.target_key = p_user_id::text
     and r.state = 'pending'
   order by r.created_at desc, r.request_id
   limit 1;
  if found then
    if v_existing.admin_user_id is distinct from p_admin
       or v_existing.request_payload - 'resolved_email'
            is distinct from v_input_payload then
      raise exception 'reactivation_in_progress' using errcode = 'P0001';
    end if;
    v_email := v_existing.request_payload->>'resolved_email';
    if v_email is null then
      raise exception 'reactivation_receipt_invalid' using errcode = 'P0001';
    end if;
    if not exists (
      select 1
        from public.account_reactivation_jobs j
       where j.request_id = v_existing.request_id
         and j.admin_user_id = p_admin
         and j.user_id = p_user_id
         and j.expected_deleted_at = p_expected_deleted_at
         and j.expected_withdrawal_generation =
               p_expected_withdrawal_generation
         and pg_catalog.lower(j.resolved_email) =
               pg_catalog.lower(v_email)
         and j.status in ('pending', 'leased')
    ) then
      raise exception 'reactivation_job_invalid' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'pending', true,
      'operationRequestId', v_existing.request_id,
      'email', v_email,
      'idempotent', true
    );
  end if;

  -- Lost client state after a completed response is recoverable only for the
  -- exact deletion timestamp and payload, so a later delete/reactivate cycle
  -- cannot be confused with an earlier one.
  select *
    into v_existing
    from public.admin_mutation_requests r
   where r.operation = 'account_reactivate'
     and r.target_key = p_user_id::text
     and r.state = 'completed'
     and r.admin_user_id = p_admin
     and r.request_payload - 'resolved_email' = v_input_payload
   order by r.completed_at desc, r.request_id
   limit 1;
  if found then
    if not exists (
      select 1
        from public.account_reactivation_jobs j
       where j.request_id = v_existing.request_id
         and j.admin_user_id = p_admin
         and j.user_id = p_user_id
         and j.expected_deleted_at = p_expected_deleted_at
         and j.expected_withdrawal_generation =
               p_expected_withdrawal_generation
         and pg_catalog.lower(j.resolved_email) =
               pg_catalog.lower(
                 v_existing.request_payload->>'resolved_email'
               )
         and j.status in ('completed', 'cancelled')
    ) then
      raise exception 'reactivation_job_invalid' using errcode = 'P0001';
    end if;
    return v_existing.result || pg_catalog.jsonb_build_object(
      'idempotent', true,
      'operationRequestId', v_existing.request_id
    );
  end if;

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
  if v_deleted_at is distinct from p_expected_deleted_at then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;
  if v_withdrawal_generation is distinct from
       p_expected_withdrawal_generation then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;
  perform 1
    from public.member_accounts m
   where m.user_id = p_user_id
   for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.account_deletion_cleanup_jobs j
     where j.user_id = p_user_id
       and j.status in ('pending', 'leased')
  ) then
    raise exception 'account_cleanup_pending' using errcode = 'P0001';
  end if;

  v_email := public.bp_prepare_account_reactivation_email(
    p_user_id,
    nullif(pg_catalog.btrim(p_email_override), '')
  );
  v_payload := v_input_payload || pg_catalog.jsonb_build_object(
    'resolved_email',
    v_email
  );

  insert into public.admin_mutation_requests(
    request_id,
    admin_user_id,
    operation,
    target_key,
    state,
    request_payload,
    payload_sha256
  )
  values (
    p_request_id,
    p_admin,
    'account_reactivate',
    p_user_id::text,
    'pending',
    v_payload,
    public.bp_admin_mutation_payload_sha256(v_payload)
  );
  insert into public.account_reactivation_jobs(
    request_id,
    admin_user_id,
    user_id,
    expected_deleted_at,
    expected_withdrawal_generation,
    resolved_email
  )
  values (
    p_request_id,
    p_admin,
    p_user_id,
    p_expected_deleted_at,
    p_expected_withdrawal_generation,
    v_email
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'pending', true,
    'operationRequestId', p_request_id,
    'email', v_email,
    'idempotent', false
  );
end;
$$;
revoke all on function public.admin_begin_account_reactivation(
  uuid, uuid, text, text, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_begin_account_reactivation(
  uuid, uuid, text, text, timestamptz, bigint, uuid
) to service_role;

-- Expand compatibility for the previously deployed route. It did not carry
-- the generation fence, so derive the current value and delegate. A later
-- exact-timestamp lifecycle collision still fails closed because the old
-- deterministic request UUID collides with a receipt whose payload contains a
-- different generation.
create or replace function public.admin_begin_account_reactivation(
  p_user_id uuid,
  p_admin uuid,
  p_reason text,
  p_email_override text,
  p_expected_deleted_at timestamptz,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation bigint;
begin
  select p.withdrawal_generation
    into v_generation
    from public.profiles p
   where p.id = p_user_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  return public.admin_begin_account_reactivation(
    p_user_id,
    p_admin,
    p_reason,
    p_email_override,
    p_expected_deleted_at,
    v_generation,
    p_request_id
  );
end;
$$;
revoke all on function public.admin_begin_account_reactivation(
  uuid, uuid, text, text, timestamptz, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_begin_account_reactivation(
  uuid, uuid, text, text, timestamptz, uuid
) to service_role;

create or replace function
  public.request_account_reactivation_cancellation(
    p_request_id uuid,
    p_user_id uuid,
    p_cancel_admin uuid,
    p_reason text,
    p_expected_deleted_at timestamptz,
    p_expected_withdrawal_generation bigint
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_request public.admin_mutation_requests%rowtype;
  v_deleted_at timestamptz;
  v_generation bigint;
begin
  perform public.bp_assert_active_admin(p_cancel_admin);
  if p_request_id is null
     or p_user_id is null
     or p_expected_deleted_at is null
     or p_expected_withdrawal_generation is null
     or p_expected_withdrawal_generation not between
          1 and 9007199254740991
     or pg_catalog.char_length(coalesce(p_reason, ''))
          not between 5 and 500 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  -- Same canonical order as claim/finish. Clearing a live lease in this
  -- transaction makes every paused activation worker stale before cancel
  -- returns; a GoTrue update that already committed is compensated by the
  -- newly claimable cancel action.
  select *
    into v_job
    from public.account_reactivation_jobs j
   where j.request_id = p_request_id
   for update;
  if not found
     or v_job.user_id is distinct from p_user_id
     or v_job.expected_deleted_at is distinct from
          p_expected_deleted_at
     or v_job.expected_withdrawal_generation is distinct from
          p_expected_withdrawal_generation then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_job.status = 'completed' then
    raise exception 'reactivation_already_completed'
      using errcode = 'P0001';
  elsif v_job.status = 'cancelled' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'status', 'cancelled',
      'request_id', v_job.request_id,
      'admin_user_id', v_job.admin_user_id,
      'user_id', v_job.user_id,
      'idempotent', true
    );
  end if;

  perform public.bp_admin_mutation_request_lock(v_job.request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = v_job.request_id
   for update;
  if not found
     or v_request.state <> 'pending'
     or v_request.operation <> 'account_reactivate'
     or v_request.admin_user_id is distinct from v_job.admin_user_id
     or v_request.target_key is distinct from v_job.user_id::text
     or (v_request.request_payload->>'expected_deleted_at')::timestamptz
          is distinct from v_job.expected_deleted_at
     or (
          v_request.request_payload->>'expected_withdrawal_generation'
        )::bigint is distinct from
          v_job.expected_withdrawal_generation then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
  end if;

  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
  perform public.bp_user_mutation_lock(v_job.user_id);
  select p.deleted_at, p.withdrawal_generation
    into v_deleted_at, v_generation
    from public.profiles p
   where p.id = v_job.user_id
   for update;
  if not found
     or v_deleted_at is distinct from v_job.expected_deleted_at
     or v_generation is distinct from
          v_job.expected_withdrawal_generation then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;

  if v_job.cancel_requested_at is not null then
    -- The cancellation intent is already durable. Any currently active
    -- administrator may resume its compensation after a response loss or a
    -- page reload; the original requester/reason remain immutable and are
    -- the values written to the terminal audit.
    if v_job.lease_version = 2147483647
       or v_job.attempt_count = 2147483647 then
      update public.account_reactivation_jobs
         set status = 'pending',
             lease_token = null,
             leased_until = null,
             lease_version = case
               when lease_version = 2147483647 then 0
               else lease_version
             end,
             attempt_count = case
               when attempt_count = 2147483647 then 0
               else attempt_count
             end,
             next_attempt_at = clock_timestamp(),
             last_error = 'cancellation_requested',
             updated_at = clock_timestamp()
       where request_id = v_job.request_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'status', 'cancel_requested',
      'request_id', v_job.request_id,
      'admin_user_id', v_job.admin_user_id,
      'user_id', v_job.user_id,
      'idempotent', true
    );
  end if;

  update public.account_reactivation_jobs
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         lease_version = case
           when lease_version = 2147483647 then 0
           else lease_version
         end,
         attempt_count = case
           when attempt_count = 2147483647 then 0
           else attempt_count
         end,
         next_attempt_at = clock_timestamp(),
         last_error = 'cancellation_requested',
         cancel_requested_by = p_cancel_admin,
         cancel_reason = p_reason,
         cancel_requested_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where request_id = v_job.request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', 'cancel_requested',
    'request_id', v_job.request_id,
    'admin_user_id', v_job.admin_user_id,
    'user_id', v_job.user_id,
    'idempotent', false
  );
end;
$$;
revoke all on function
  public.request_account_reactivation_cancellation(
    uuid, uuid, uuid, text, timestamptz, bigint
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.request_account_reactivation_cancellation(
    uuid, uuid, uuid, text, timestamptz, bigint
  )
  to service_role;

create or replace function public.bp_complete_account_reactivation_job(
  p_user_id uuid,
  p_admin uuid,
  p_request_id uuid,
  p_lease_token uuid,
  p_lease_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
         reconsent_required = true,
         terms_agreed_at = null,
         privacy_agreed_at = null,
         terms_version = null,
         privacy_version = null,
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
$$;
revoke all on function public.bp_complete_account_reactivation_job(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;

-- Expand compatibility: the previously deployed route can still perform its
-- Auth call then invoke this exact entry point. 0092 revokes it after the
-- durable worker route is deployed and old requests are drained.
create or replace function public.admin_complete_account_reactivation(
  p_user_id uuid,
  p_admin uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bp_assert_active_admin(p_admin);
  return public.bp_complete_account_reactivation_job(
    p_user_id,
    p_admin,
    p_request_id,
    null::uuid,
    null::integer
  );
end;
$$;
revoke all on function public.admin_complete_account_reactivation(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_complete_account_reactivation(
  uuid, uuid, uuid
) to service_role;

create or replace function public.claim_account_reactivation_job(
  p_request_id uuid default null,
  p_admin_id uuid default null,
  p_user_id uuid default null,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_request public.admin_mutation_requests%rowtype;
  v_deleted_at timestamptz;
  v_withdrawal_generation bigint;
  v_current_email text;
  v_auth_email text;
  v_preflight_error text;
  v_preflight_message text;
  v_action text;
  v_token uuid := pg_catalog.gen_random_uuid();
  v_seconds integer :=
    greatest(30, least(coalesce(p_lease_seconds, 120), 600));
begin
  if not (
    (p_request_id is null and p_admin_id is null and p_user_id is null)
    or
    (p_request_id is not null and p_admin_id is not null and p_user_id is not null)
  ) then
    raise exception 'reactivation_correlation_incomplete'
      using errcode = 'P0001';
  end if;

  -- A mathematically exhausted counter must remain visible but can never
  -- overflow at the head of the shared queue. Quarantine every due exhausted
  -- row before selecting a lease; an exact cancellation resets only a maxed
  -- counter under the job lock and can still converge the user to marker.
  with exhausted as materialized (
    select j.request_id
      from public.account_reactivation_jobs j
     where (
         (
           j.status = 'pending'
           and j.next_attempt_at <= clock_timestamp()
         )
         or (
           j.status = 'leased'
           and j.leased_until <= clock_timestamp()
         )
       )
       and (
         j.lease_version = 2147483647
         or j.attempt_count = 2147483647
       )
     for update skip locked
  )
  update public.account_reactivation_jobs j
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         next_attempt_at =
           '9999-12-31 23:59:59+00'::timestamptz,
         last_error = 'lease_counter_exhausted',
         updated_at = clock_timestamp()
   where j.request_id in (
     select e.request_id from exhausted e
   );

  if p_request_id is not null then
    select *
      into v_job
      from public.account_reactivation_jobs j
     where j.request_id = p_request_id;
    if not found then
      return null;
    end if;
    if v_job.admin_user_id is distinct from p_admin_id
       or v_job.user_id is distinct from p_user_id then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
  end if;

  select *
    into v_job
    from public.account_reactivation_jobs j
   where (p_request_id is null or j.request_id = p_request_id)
     and (
       (
         j.status = 'pending'
         and j.next_attempt_at <= clock_timestamp()
       )
       or
       (
         j.status = 'leased'
         and j.leased_until <= clock_timestamp()
       )
     )
   order by j.next_attempt_at, j.created_at, j.request_id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  perform public.bp_admin_mutation_request_lock(v_job.request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = v_job.request_id
   for update;
  if not found
     or v_request.state <> 'pending'
     or v_request.operation <> 'account_reactivate'
     or v_request.admin_user_id is distinct from v_job.admin_user_id
     or v_request.target_key is distinct from v_job.user_id::text
     or (v_request.request_payload->>'expected_deleted_at')::timestamptz
          is distinct from v_job.expected_deleted_at
     or (v_request.request_payload->>'expected_withdrawal_generation')::bigint
          is distinct from v_job.expected_withdrawal_generation
     or pg_catalog.lower(
          pg_catalog.btrim(v_request.request_payload->>'resolved_email')
        ) is distinct from
        pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
  end if;
  v_action := case
    when v_job.cancel_requested_at is null then 'activate'
    else 'cancel'
  end;

  select p.deleted_at, p.withdrawal_generation
    into v_deleted_at, v_withdrawal_generation
    from public.profiles p
   where p.id = v_job.user_id
   for key share;
  if not found then
    v_preflight_error := 'profile_missing';
  elsif v_deleted_at is distinct from v_job.expected_deleted_at
     or v_withdrawal_generation is distinct from
          v_job.expected_withdrawal_generation then
    v_preflight_error := 'state_conflict';
  end if;

  if v_preflight_error is null and v_action = 'activate' then
    perform 1
      from public.member_accounts m
     where m.user_id = v_job.user_id
     for key share;
    if not found then
      v_preflight_error := 'member_not_found';
    end if;
  end if;

  if v_preflight_error is null
     and v_action = 'activate'
     and exists (
    select 1
      from public.account_deletion_cleanup_jobs d
     where d.user_id = v_job.user_id
       and d.status in ('pending', 'leased')
  ) then
    v_preflight_error := 'account_cleanup_pending';
  end if;

  if v_preflight_error is null and v_action = 'activate' then
    begin
      v_current_email := public.bp_prepare_account_reactivation_email(
        v_job.user_id,
        v_request.request_payload->>'email_override'
      );
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_preflight_message = message_text;
        if v_preflight_message in (
          'not_found',
          'identity_email_missing',
          'reactivation_email_invalid',
          'email_conflict'
        ) then
          -- Expected semantic drift must not poison the head of the generic
          -- queue. Claim it and durably record a fenced retry/backoff.
          v_preflight_error := v_preflight_message;
        else
          raise;
        end if;
    end;
    if v_preflight_error is null
       and pg_catalog.lower(pg_catalog.btrim(v_current_email))
            is distinct from
            pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
      v_preflight_error := 'reactivation_email_changed';
    end if;
  end if;

  if v_preflight_error is null and v_action = 'activate' then
    select pg_catalog.lower(pg_catalog.btrim(u.email))
      into v_auth_email
      from auth.users u
     where u.id = v_job.user_id;
    if not found or v_auth_email is null then
      v_preflight_error := 'auth_user_missing';
    elsif v_auth_email is distinct from
            pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email))
       and v_auth_email is distinct from
            pg_catalog.lower(
              'deleted+' || v_job.user_id::text || '@deleted.invalid'
            ) then
      v_preflight_error := 'auth_identity_conflict';
    end if;
  end if;

  update public.account_reactivation_jobs
     set status = 'leased',
         lease_token = v_token,
         leased_until = clock_timestamp() +
           pg_catalog.make_interval(secs => v_seconds),
         lease_version = lease_version + 1,
         attempt_count = attempt_count + 1,
         updated_at = clock_timestamp()
   where request_id = v_job.request_id
  returning * into v_job;

  return pg_catalog.jsonb_build_object(
    'request_id', v_job.request_id,
    'admin_user_id', v_job.admin_user_id,
    'user_id', v_job.user_id,
    'email', v_job.resolved_email,
    'expected_deleted_at', v_job.expected_deleted_at,
    'expected_withdrawal_generation',
      v_job.expected_withdrawal_generation,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count,
    'action', v_action,
    'preflight_error', v_preflight_error
  );
end;
$$;
revoke all on function public.claim_account_reactivation_job(
  uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.claim_account_reactivation_job(
  uuid, uuid, uuid, integer
) to service_role;

create or replace function public.arm_account_reactivation_auth_fence(
  p_request_id uuid,
  p_admin_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_lease_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_request public.admin_mutation_requests%rowtype;
  v_auth_email text;
  v_action text;
begin
  select *
    into v_job
    from public.account_reactivation_jobs j
   where j.request_id = p_request_id
   for update;
  if not found
     or v_job.admin_user_id is distinct from p_admin_id
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version
     or v_job.leased_until <= clock_timestamp() then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;
  v_action := case
    when v_job.cancel_requested_at is null then 'activate'
    else 'cancel'
  end;

  perform public.bp_admin_mutation_request_lock(v_job.request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = v_job.request_id
   for update;
  if not found
     or v_request.state <> 'pending'
     or v_request.operation <> 'account_reactivate'
     or v_request.admin_user_id is distinct from v_job.admin_user_id
     or v_request.target_key is distinct from v_job.user_id::text
     or (v_request.request_payload->>'expected_deleted_at')::timestamptz
          is distinct from v_job.expected_deleted_at
     or (v_request.request_payload->>'expected_withdrawal_generation')::bigint
          is distinct from v_job.expected_withdrawal_generation
     or pg_catalog.lower(
          pg_catalog.btrim(v_request.request_payload->>'resolved_email')
        ) is distinct from
          pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
      from public.profiles p
     where p.id = v_job.user_id
       and p.deleted_at = v_job.expected_deleted_at
       and p.withdrawal_generation =
             v_job.expected_withdrawal_generation
  ) then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;
  if v_action = 'activate'
     and not exists (
       select 1
         from public.member_accounts m
        where m.user_id = v_job.user_id
     ) then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(u.email))
    into v_auth_email
    from auth.users u
   where u.id = v_job.user_id
   for update;
  if not found
     or (
       v_auth_email is distinct from
         pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email))
       and v_auth_email is distinct from
         pg_catalog.lower(
           'deleted+' || v_job.user_id::text || '@deleted.invalid'
         )
     ) then
    raise exception 'auth_identity_conflict' using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_typeof(
       coalesce(
         (
           select u.raw_app_meta_data
             from auth.users u
            where u.id = v_job.user_id
         ),
         '{}'::jsonb
       )
     ) is distinct from 'object' then
    raise exception 'auth_metadata_invalid' using errcode = 'P0001';
  end if;

  update auth.users u
     set raw_app_meta_data =
           coalesce(u.raw_app_meta_data, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
                'bp_reactivation_fence',
                pg_catalog.jsonb_build_object(
                  'request_id', v_job.request_id,
                  'admin_user_id', v_job.admin_user_id,
                  'user_id', v_job.user_id,
                  'lease_token', v_job.lease_token,
                  'lease_version', v_job.lease_version,
                  'action', v_action,
                  'expected_deleted_at', v_job.expected_deleted_at,
                  'expected_withdrawal_generation',
                    v_job.expected_withdrawal_generation
                )
              ),
         updated_at = clock_timestamp()
   where u.id = v_job.user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'request_id', v_job.request_id,
    'user_id', v_job.user_id,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'action', v_action
  );
end;
$$;
revoke all on function public.arm_account_reactivation_auth_fence(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.arm_account_reactivation_auth_fence(
  uuid, uuid, uuid, uuid, integer
) to service_role;

create or replace function
  public.bp_cancel_account_reactivation_job(
    p_user_id uuid,
    p_admin_id uuid,
    p_request_id uuid,
    p_lease_token uuid,
    p_lease_version integer
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_request public.admin_mutation_requests%rowtype;
  v_deleted_at timestamptz;
  v_generation bigint;
  v_auth_email text;
  v_marker text := pg_catalog.lower(
    'deleted+' || p_user_id::text || '@deleted.invalid'
  );
  v_result jsonb;
begin
  select *
    into v_job
    from public.account_reactivation_jobs j
   where j.request_id = p_request_id
   for update;
  if not found
     or v_job.admin_user_id is distinct from p_admin_id
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version
     or v_job.leased_until <= clock_timestamp()
     or v_job.cancel_requested_at is null
     or v_job.cancel_requested_by is null
     or v_job.cancel_reason is null then
    raise exception 'stale_cancel_lease' using errcode = 'P0001';
  end if;

  perform public.bp_admin_mutation_request_lock(v_job.request_id);
  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = v_job.request_id
   for update;
  if not found
     or v_request.state <> 'pending'
     or v_request.operation <> 'account_reactivate'
     or v_request.admin_user_id is distinct from v_job.admin_user_id
     or v_request.target_key is distinct from v_job.user_id::text
     or (v_request.request_payload->>'expected_deleted_at')::timestamptz
          is distinct from v_job.expected_deleted_at
     or (
          v_request.request_payload->>'expected_withdrawal_generation'
        )::bigint is distinct from
          v_job.expected_withdrawal_generation
     or pg_catalog.lower(
          pg_catalog.btrim(v_request.request_payload->>'resolved_email')
        ) is distinct from
          pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
  end if;

  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
  perform public.bp_user_mutation_lock(v_job.user_id);
  select p.deleted_at, p.withdrawal_generation
    into v_deleted_at, v_generation
    from public.profiles p
   where p.id = v_job.user_id
   for update;
  if not found
     or v_deleted_at is distinct from v_job.expected_deleted_at
     or v_generation is distinct from
          v_job.expected_withdrawal_generation then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;
  -- Missing/corrupt member state must not make a safely deleted Auth identity
  -- impossible to release; lock it when present so no concurrent repair can
  -- change the evidence during terminal cancellation.
  perform 1
    from public.member_accounts m
   where m.user_id = v_job.user_id
   for update;

  perform 1
    from auth.identities i
   where i.user_id = v_job.user_id
   order by i.id
   for update;
  select pg_catalog.lower(pg_catalog.btrim(u.email))
    into v_auth_email
    from auth.users u
   where u.id = v_job.user_id
   for update;
  if found and v_auth_email is distinct from v_marker then
    raise exception 'auth_marker_not_synchronized'
      using errcode = 'P0001';
  end if;

  -- The exact cancellation lease is now terminal. Remove only its private
  -- fence key while holding auth.users; concurrent provider/role metadata is
  -- preserved byte-for-byte.
  update auth.users u
     set raw_app_meta_data =
           case
             when pg_catalog.jsonb_typeof(u.raw_app_meta_data) = 'object'
             then u.raw_app_meta_data - 'bp_reactivation_fence'
             else u.raw_app_meta_data
           end,
         updated_at = clock_timestamp()
   where u.id = v_job.user_id;

  update public.account_reactivation_jobs
     set status = 'cancelled',
         lease_token = null,
         leased_until = null,
         last_error = null,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where request_id = v_job.request_id;

  insert into public.account_admin_actions_ledger(
    admin_user_id,
    action_type,
    target_user_id,
    reason,
    metadata
  )
  values (
    v_job.cancel_requested_by,
    'account_reactivate',
    v_job.user_id,
    v_job.cancel_reason,
    pg_catalog.jsonb_build_object(
      'cancelled', true,
      'operation_request_id', v_job.request_id,
      'original_admin_user_id', v_job.admin_user_id,
      'auth_user_missing', v_auth_email is null
    )
  );

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'userId', v_job.user_id,
    'accountReactivated', false,
    'cancelled', true,
    'idempotent', false
  );
  update public.admin_mutation_requests
     set state = 'cancelled',
         result = v_result,
         completed_at = clock_timestamp()
   where request_id = v_job.request_id;
  return v_result;
end;
$$;
revoke all on function
  public.bp_cancel_account_reactivation_job(
    uuid, uuid, uuid, uuid, integer
  )
  from public, anon, authenticated, service_role;

create or replace function public.finish_account_reactivation_job(
  p_request_id uuid,
  p_admin_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_success boolean,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_result jsonb;
  v_backoff integer;
begin
  select *
    into v_job
    from public.account_reactivation_jobs j
   where j.request_id = p_request_id
   for update;
  if not found
     or v_job.admin_user_id is distinct from p_admin_id
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version
     or v_job.leased_until <= clock_timestamp() then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;
  if p_success is null then
    raise exception 'success_required' using errcode = 'P0001';
  end if;

  if not p_success then
    if p_error is null
       or pg_catalog.char_length(p_error) not between 1 and 500 then
      raise exception 'error_required' using errcode = 'P0001';
    end if;
    v_backoff := least(
      3600,
      5 * (1 << least(v_job.attempt_count, 10))
    );
    update public.account_reactivation_jobs
       set status = 'pending',
           lease_token = null,
           leased_until = null,
           next_attempt_at = clock_timestamp() +
             pg_catalog.make_interval(secs => v_backoff),
           last_error = p_error,
           updated_at = clock_timestamp()
     where request_id = v_job.request_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'request_id', v_job.request_id,
      'status', 'pending',
      'result', null
    );
  end if;
  if p_error is not null then
    raise exception 'unexpected_error' using errcode = 'P0001';
  end if;

  if v_job.cancel_requested_at is not null then
    v_result := public.bp_cancel_account_reactivation_job(
      p_user_id,
      p_admin_id,
      p_request_id,
      p_lease_token,
      p_lease_version
    );
  else
    v_result := public.bp_complete_account_reactivation_job(
      p_user_id,
      p_admin_id,
      p_request_id,
      p_lease_token,
      p_lease_version
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'request_id', v_job.request_id,
    'status',
      case
        when v_job.cancel_requested_at is null then 'completed'
        else 'cancelled'
      end,
    'result', v_result
  );
end;
$$;
revoke all on function public.finish_account_reactivation_job(
  uuid, uuid, uuid, uuid, integer, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_account_reactivation_job(
  uuid, uuid, uuid, uuid, integer, boolean, text
) to service_role;

create or replace function public.get_account_reactivation_status(
  p_request_id uuid,
  p_admin_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_jobs%rowtype;
  v_request public.admin_mutation_requests%rowtype;
begin
  select *
    into v_job
    from public.account_reactivation_jobs j
   where j.request_id = p_request_id;
  if not found then
    raise exception 'reactivation_job_not_found' using errcode = 'P0001';
  end if;
  if v_job.admin_user_id is distinct from p_admin_id
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;

  select *
    into v_request
    from public.admin_mutation_requests r
   where r.request_id = p_request_id;
  if not found
     or v_request.operation <> 'account_reactivate'
     or v_request.admin_user_id is distinct from p_admin_id
     or v_request.target_key is distinct from p_user_id::text
     or (v_request.request_payload->>'expected_deleted_at')::timestamptz
          is distinct from v_job.expected_deleted_at
     or (v_request.request_payload->>'expected_withdrawal_generation')::bigint
          is distinct from v_job.expected_withdrawal_generation
     or pg_catalog.lower(
          pg_catalog.btrim(v_request.request_payload->>'resolved_email')
        ) is distinct from
        pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email))
     or (
       v_request.state = 'completed' and v_job.status <> 'completed'
     )
     or (
       v_request.state = 'cancelled' and v_job.status <> 'cancelled'
     )
     or (
       v_request.state = 'pending'
       and v_job.status in ('completed', 'cancelled')
     ) then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'request_id', v_job.request_id,
    'admin_user_id', v_job.admin_user_id,
    'user_id', v_job.user_id,
    'status', v_job.status,
    'attempt_count', v_job.attempt_count,
    'next_attempt_at',
      case
        when v_job.status in ('completed', 'cancelled') then null
        when v_job.status = 'leased' then v_job.leased_until
        else v_job.next_attempt_at
      end,
    'result',
      case
        when v_request.state in ('completed', 'cancelled')
        then v_request.result
        else null
      end
  );
end;
$$;
revoke all on function public.get_account_reactivation_status(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_account_reactivation_status(
  uuid, uuid, uuid
) to service_role;

create or replace function public.get_pending_account_reactivation(
  p_admin_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_admin_user_id uuid;
  v_user_id uuid;
  v_expected_deleted_at timestamptz;
  v_expected_withdrawal_generation bigint;
  v_job_status text;
  v_cancel_requested boolean;
  v_receipt_valid boolean;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_user_id is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  -- Job and receipt are one atomic saga state, so read them in one statement
  -- and one READ COMMITTED snapshot. A concurrent terminal finish is either
  -- wholly visible (found=false) or wholly invisible (exact pending row);
  -- it can never produce a torn pending-job/completed-receipt page failure.
  select
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.expected_deleted_at,
    j.expected_withdrawal_generation,
    j.status,
    j.cancel_requested_at is not null,
    (
      r.request_id is not null
      and r.state = 'pending'
      and r.operation = 'account_reactivate'
      and r.admin_user_id = j.admin_user_id
      and r.target_key = j.user_id::text
      and (r.request_payload->>'expected_deleted_at')::timestamptz
            is not distinct from j.expected_deleted_at
      and (
            r.request_payload->>'expected_withdrawal_generation'
          )::bigint is not distinct from
            j.expected_withdrawal_generation
      and pg_catalog.lower(
            pg_catalog.btrim(r.request_payload->>'resolved_email')
          ) is not distinct from
            pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
    )
    into
      v_request_id,
      v_admin_user_id,
      v_user_id,
      v_expected_deleted_at,
      v_expected_withdrawal_generation,
      v_job_status,
      v_cancel_requested,
      v_receipt_valid
    from public.account_reactivation_jobs j
    left join public.admin_mutation_requests r
      on r.request_id = j.request_id
   where j.user_id = p_user_id
     and j.status in ('pending', 'leased')
   order by j.created_at desc, j.request_id desc
   limit 1;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'found', false
    );
  end if;
  if not coalesce(v_receipt_valid, false) then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'found', true,
    'request_id', v_request_id,
    'admin_user_id', v_admin_user_id,
    'user_id', v_user_id,
    'expected_deleted_at', v_expected_deleted_at,
    'expected_withdrawal_generation',
      v_expected_withdrawal_generation,
    'job_status', v_job_status,
    'cancel_requested', v_cancel_requested
  );
exception
  when invalid_text_representation
    or datetime_field_overflow
    or numeric_value_out_of_range then
    raise exception 'reactivation_job_invalid' using errcode = 'P0001';
end;
$$;
revoke all on function public.get_pending_account_reactivation(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_pending_account_reactivation(
  uuid, uuid
) to service_role;

create or replace function public.get_account_reactivation_queue_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'ok', true,
    'retry_pending',
      pg_catalog.count(*) filter (
        where j.status in ('pending', 'leased')
      ),
    'legacy_repair_pending',
      (
        select pg_catalog.count(*)
          from public.account_reactivation_legacy_repairs l
         where l.status in ('pending', 'leased')
      ),
    'oldest_pending',
      (
        select pg_catalog.jsonb_build_object(
          'request_id', q.request_id,
          'user_id', q.user_id,
          'status', q.status,
          'last_error', q.last_error,
          'retry_at',
            case
              when q.status = 'leased' then q.leased_until
              else q.next_attempt_at
            end
        )
          from public.account_reactivation_jobs q
         where q.status in ('pending', 'leased')
         order by
           case
             when q.status = 'leased' then q.leased_until
             else q.next_attempt_at
           end,
           q.created_at,
           q.request_id
         limit 1
      ),
    'oldest_legacy_repair',
      (
        select pg_catalog.jsonb_build_object(
          'job_id', q.id,
          'user_id', q.user_id,
          'status', q.status,
          'last_error', q.last_error,
          'retry_at',
            case
              when q.status = 'leased' then q.leased_until
              else q.next_attempt_at
            end
        )
          from public.account_reactivation_legacy_repairs q
         where q.status in ('pending', 'leased')
         order by
           case
             when q.status = 'leased' then q.leased_until
             else q.next_attempt_at
           end,
           q.created_at,
           q.id
         limit 1
      )
  )
  from public.account_reactivation_jobs j;
$$;
revoke all on function public.get_account_reactivation_queue_health()
  from public, anon, authenticated, service_role;
grant execute on function public.get_account_reactivation_queue_health()
  to service_role;

-- Rolling-only worker for the old route's DB-first activation outbox. A
-- lifecycle that has since been withdrawn again is terminally superseded
-- without touching Auth. Otherwise only marker -> the exact member email is
-- repaired, and completion rechecks Auth + DB under the canonical user lock.
create or replace function
  public.claim_account_reactivation_legacy_repair(
    p_lease_seconds integer default 120
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_legacy_repairs%rowtype;
  v_deleted_at timestamptz;
  v_generation bigint;
  v_member_email text;
  v_auth_meta jsonb;
  v_preflight_error text;
  v_token uuid := pg_catalog.gen_random_uuid();
  v_seconds integer :=
    greatest(30, least(coalesce(p_lease_seconds, 120), 600));
begin
  with exhausted as materialized (
    select j.id
      from public.account_reactivation_legacy_repairs j
     where (
         (
           j.status = 'pending'
           and j.next_attempt_at <= clock_timestamp()
         )
         or (
           j.status = 'leased'
           and j.leased_until <= clock_timestamp()
         )
       )
       and (
         j.lease_version = 2147483647
         or j.attempt_count = 2147483647
       )
     for update skip locked
  )
  update public.account_reactivation_legacy_repairs j
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         next_attempt_at =
           '9999-12-31 23:59:59+00'::timestamptz,
         last_error = 'lease_counter_exhausted',
         updated_at = clock_timestamp()
   where j.id in (select e.id from exhausted e);

  select *
    into v_job
    from public.account_reactivation_legacy_repairs j
   where (
       j.status = 'pending'
       and j.next_attempt_at <= clock_timestamp()
     )
      or (
       j.status = 'leased'
       and j.leased_until <= clock_timestamp()
     )
   order by j.next_attempt_at, j.created_at, j.id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  perform public.bp_user_mutation_lock(v_job.user_id);
  select
    p.deleted_at,
    p.withdrawal_generation,
    pg_catalog.lower(pg_catalog.btrim(m.email))
    into v_deleted_at, v_generation, v_member_email
    from public.profiles p
    left join public.member_accounts m on m.user_id = p.id
   where p.id = v_job.user_id
   for update of p;

  if not found
     or v_deleted_at is not null
     or v_generation is distinct from
          v_job.expected_withdrawal_generation then
    -- The Auth update may have committed immediately before a new
    -- withdrawal won. Terminal supersession must not strand that lease's
    -- private metadata forever; remove only the exact current fence and
    -- preserve every unrelated provider/role key.
    perform 1
      from auth.identities i
     where i.user_id = v_job.user_id
     order by i.id
     for update;
    select u.raw_app_meta_data
      into v_auth_meta
      from auth.users u
     where u.id = v_job.user_id
     for update;
    if found
       and pg_catalog.jsonb_typeof(
             coalesce(v_auth_meta, '{}'::jsonb)
           ) = 'object'
       and v_auth_meta->'bp_reactivation_fence'->>'action' =
             'legacy_repair'
       and v_auth_meta
             ->'bp_reactivation_fence'
             ->>'legacy_repair_job_id' = v_job.id::text
       and v_auth_meta->'bp_reactivation_fence'->>'user_id' =
             v_job.user_id::text
       and v_auth_meta
             ->'bp_reactivation_fence'
             ->>'expected_withdrawal_generation' =
             v_job.expected_withdrawal_generation::text then
      update auth.users u
         set raw_app_meta_data =
               u.raw_app_meta_data - 'bp_reactivation_fence',
             updated_at = clock_timestamp()
       where u.id = v_job.user_id;
    end if;
    update public.account_reactivation_legacy_repairs
       set status = 'superseded',
           lease_token = null,
           leased_until = null,
           last_error = 'lifecycle_superseded',
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'job_id', v_job.id,
      'user_id', v_job.user_id
    );
  end if;
  if v_member_email is null then
    v_preflight_error := 'member_not_found';
  elsif v_member_email is distinct from
          pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    v_preflight_error := 'member_email_changed';
  end if;

  update public.account_reactivation_legacy_repairs
     set status = 'leased',
         lease_token = v_token,
         leased_until = clock_timestamp() +
           pg_catalog.make_interval(secs => v_seconds),
         lease_version = lease_version + 1,
         attempt_count = attempt_count + 1,
         updated_at = clock_timestamp()
   where id = v_job.id
  returning * into v_job;

  return pg_catalog.jsonb_build_object(
    'status', 'leased',
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'email', v_job.resolved_email,
    'expected_withdrawal_generation',
      v_job.expected_withdrawal_generation,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count,
    'preflight_error', v_preflight_error
  );
end;
$$;
revoke all on function
  public.claim_account_reactivation_legacy_repair(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.claim_account_reactivation_legacy_repair(integer)
  to service_role;

create or replace function
  public.arm_account_reactivation_legacy_repair_auth_fence(
    p_job_id uuid,
    p_user_id uuid,
    p_lease_token uuid,
    p_lease_version integer
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_legacy_repairs%rowtype;
  v_deleted_at timestamptz;
  v_generation bigint;
  v_member_email text;
  v_auth_email text;
  v_auth_meta jsonb;
begin
  select *
    into v_job
    from public.account_reactivation_legacy_repairs j
   where j.id = p_job_id
   for update;
  if not found
     or v_job.user_id is distinct from p_user_id
     or v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version
     or v_job.leased_until <= clock_timestamp() then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;

  perform public.bp_user_mutation_lock(v_job.user_id);
  select
    p.deleted_at,
    p.withdrawal_generation,
    pg_catalog.lower(pg_catalog.btrim(m.email))
    into v_deleted_at, v_generation, v_member_email
    from public.profiles p
    left join public.member_accounts m on m.user_id = p.id
   where p.id = v_job.user_id
   for update of p;
  if not found
     or v_deleted_at is not null
     or v_generation is distinct from
          v_job.expected_withdrawal_generation then
    raise exception 'lifecycle_superseded' using errcode = 'P0001';
  end if;
  if v_member_email is distinct from
       pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    raise exception 'member_email_changed' using errcode = 'P0001';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(u.email)),
    u.raw_app_meta_data
    into v_auth_email, v_auth_meta
    from auth.users u
   where u.id = v_job.user_id
   for update;
  if not found
     or (
       v_auth_email is distinct from
         pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email))
       and v_auth_email is distinct from
         pg_catalog.lower(
           'deleted+' || v_job.user_id::text || '@deleted.invalid'
         )
     ) then
    raise exception 'auth_identity_conflict' using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_typeof(
       coalesce(v_auth_meta, '{}'::jsonb)
     ) is distinct from 'object' then
    raise exception 'auth_metadata_invalid' using errcode = 'P0001';
  end if;

  update auth.users u
     set raw_app_meta_data =
           coalesce(u.raw_app_meta_data, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
                'bp_reactivation_fence',
                pg_catalog.jsonb_build_object(
                  'action', 'legacy_repair',
                  'legacy_repair_job_id', v_job.id,
                  'user_id', v_job.user_id,
                  'lease_token', v_job.lease_token,
                  'lease_version', v_job.lease_version,
                  'expected_withdrawal_generation',
                    v_job.expected_withdrawal_generation
                )
              ),
         updated_at = clock_timestamp()
   where u.id = v_job.user_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'action', 'legacy_repair'
  );
end;
$$;
revoke all on function
  public.arm_account_reactivation_legacy_repair_auth_fence(
    uuid, uuid, uuid, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.arm_account_reactivation_legacy_repair_auth_fence(
    uuid, uuid, uuid, integer
  )
  to service_role;

create or replace function
  public.finish_account_reactivation_legacy_repair(
    p_job_id uuid,
    p_user_id uuid,
    p_lease_token uuid,
    p_lease_version integer,
    p_success boolean,
    p_error text
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_legacy_repairs%rowtype;
  v_deleted_at timestamptz;
  v_generation bigint;
  v_member_email text;
  v_auth_email text;
  v_auth_meta jsonb;
  v_backoff integer;
begin
  select *
    into v_job
    from public.account_reactivation_legacy_repairs j
   where j.id = p_job_id
   for update;
  if not found
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_version <> p_lease_version
     or v_job.leased_until <= clock_timestamp() then
    raise exception 'stale_lease' using errcode = 'P0001';
  end if;
  if p_success is null then
    raise exception 'success_required' using errcode = 'P0001';
  end if;

  if not p_success then
    if p_error is null
       or pg_catalog.char_length(p_error) not between 1 and 500 then
      raise exception 'error_required' using errcode = 'P0001';
    end if;
    v_backoff := least(
      3600,
      5 * (1 << least(v_job.attempt_count, 10))
    );
    update public.account_reactivation_legacy_repairs
       set status = 'pending',
           lease_token = null,
           leased_until = null,
           next_attempt_at = clock_timestamp() +
             pg_catalog.make_interval(secs => v_backoff),
           last_error = p_error,
           updated_at = clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'status', 'pending'
    );
  end if;
  if p_error is not null then
    raise exception 'unexpected_error' using errcode = 'P0001';
  end if;

  perform public.bp_user_mutation_lock(v_job.user_id);
  select
    p.deleted_at,
    p.withdrawal_generation,
    pg_catalog.lower(pg_catalog.btrim(m.email))
    into v_deleted_at, v_generation, v_member_email
    from public.profiles p
    left join public.member_accounts m on m.user_id = p.id
   where p.id = v_job.user_id
   for update of p;
  if not found
     or v_deleted_at is not null
     or v_generation is distinct from
          v_job.expected_withdrawal_generation then
    -- The exact Auth write can commit before a concurrent new withdrawal.
    -- Superseding the leased repair also retires only that lease's private
    -- metadata fence; unrelated app_metadata remains untouched.
    perform 1
      from auth.identities i
     where i.user_id = v_job.user_id
     order by i.id
     for update;
    select u.raw_app_meta_data
      into v_auth_meta
      from auth.users u
     where u.id = v_job.user_id
     for update;
    if found
       and pg_catalog.jsonb_typeof(
             coalesce(v_auth_meta, '{}'::jsonb)
           ) = 'object'
       and v_auth_meta->'bp_reactivation_fence'->>'action' =
             'legacy_repair'
       and v_auth_meta
             ->'bp_reactivation_fence'
             ->>'legacy_repair_job_id' = v_job.id::text
       and v_auth_meta->'bp_reactivation_fence'->>'user_id' =
             v_job.user_id::text
       and v_auth_meta->'bp_reactivation_fence'->>'lease_token' =
             v_job.lease_token::text
       and v_auth_meta->'bp_reactivation_fence'->>'lease_version' =
             v_job.lease_version::text
       and v_auth_meta
             ->'bp_reactivation_fence'
             ->>'expected_withdrawal_generation' =
             v_job.expected_withdrawal_generation::text then
      update auth.users u
         set raw_app_meta_data =
               u.raw_app_meta_data - 'bp_reactivation_fence',
             updated_at = clock_timestamp()
       where u.id = v_job.user_id;
    end if;
    update public.account_reactivation_legacy_repairs
       set status = 'superseded',
           lease_token = null,
           leased_until = null,
           last_error = 'lifecycle_superseded',
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'status', 'superseded'
    );
  end if;
  if v_member_email is distinct from
       pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    raise exception 'member_email_changed' using errcode = 'P0001';
  end if;

  -- Match GoTrue's identity-before-user lock order before accepting the
  -- fresh authoritative email proof.
  perform 1
    from auth.identities i
   where i.user_id = v_job.user_id
   order by i.id
   for update;
  select
    pg_catalog.lower(pg_catalog.btrim(u.email)),
    u.raw_app_meta_data
    into v_auth_email, v_auth_meta
    from auth.users u
   where u.id = v_job.user_id
   for update;
  if not found
     or v_auth_email is distinct from
          pg_catalog.lower(pg_catalog.btrim(v_job.resolved_email)) then
    raise exception 'auth_email_not_synchronized' using errcode = 'P0001';
  end if;

  if pg_catalog.jsonb_typeof(
       coalesce(v_auth_meta, '{}'::jsonb)
     ) is distinct from 'object'
     or v_auth_meta->'bp_reactivation_fence'->>'action' is distinct from
          'legacy_repair'
     or v_auth_meta
          ->'bp_reactivation_fence'
          ->>'legacy_repair_job_id' is distinct from v_job.id::text
     or v_auth_meta->'bp_reactivation_fence'->>'user_id'
          is distinct from v_job.user_id::text
     or v_auth_meta->'bp_reactivation_fence'->>'lease_token'
          is distinct from v_job.lease_token::text
     or v_auth_meta->'bp_reactivation_fence'->>'lease_version'
          is distinct from v_job.lease_version::text
     or v_auth_meta
          ->'bp_reactivation_fence'
          ->>'expected_withdrawal_generation' is distinct from
          v_job.expected_withdrawal_generation::text then
    raise exception 'auth_reactivation_fence_invalid'
      using errcode = 'P0001';
  end if;
  update auth.users u
     set raw_app_meta_data =
           u.raw_app_meta_data - 'bp_reactivation_fence',
         updated_at = clock_timestamp()
   where u.id = v_job.user_id;

  update public.account_reactivation_legacy_repairs
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
revoke all on function
  public.finish_account_reactivation_legacy_repair(
    uuid, uuid, uuid, integer, boolean, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.finish_account_reactivation_legacy_repair(
    uuid, uuid, uuid, integer, boolean, text
  )
  to service_role;

create or replace function
  public.get_account_reactivation_legacy_repair_status(
    p_job_id uuid,
    p_user_id uuid
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_reactivation_legacy_repairs%rowtype;
begin
  select *
    into v_job
    from public.account_reactivation_legacy_repairs j
   where j.id = p_job_id;
  if not found
     or v_job.user_id is distinct from p_user_id then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'status', v_job.status
  );
end;
$$;
revoke all on function
  public.get_account_reactivation_legacy_repair_status(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.get_account_reactivation_legacy_repair_status(uuid, uuid)
  to service_role;

-- Expand-phase Auth fence. The old route activates the profile/member row
-- before its GoTrue call, so that one exact active-profile/member-email case
-- remains compatible. While the profile is deleted, marker -> real always
-- requires the new worker's live exact lease. 0092 removes the active legacy
-- branch after the old route is drained.
create or replace function public.bp_fence_account_reactivation_auth_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_email text := pg_catalog.lower(pg_catalog.btrim(old.email));
  v_new_email text := pg_catalog.lower(pg_catalog.btrim(new.email));
  v_marker text := pg_catalog.lower(
    'deleted+' || old.id::text || '@deleted.invalid'
  );
  v_fence jsonb :=
    coalesce(new.raw_app_meta_data, '{}'::jsonb)
      -> 'bp_reactivation_fence';
  v_has_job boolean;
begin
  if v_old_email is not distinct from v_new_email then
    return new;
  end if;

  if v_old_email = v_marker and v_new_email <> v_marker then
    perform public.bp_account_reactivation_auth_transition_lock(
      old.id
    );
  end if;

  -- A deferred transition trigger also catches an old function body that was
  -- already invoked across the 0085/0092 DDL boundary. Its permanent repair
  -- worker gets a separate exact lease fence, so even after broad rolling
  -- compatibility closes it can repair only marker -> the captured email.
  if v_old_email = v_marker
     and v_new_email <> v_marker
     and v_fence->>'action' = 'legacy_repair' then
    if coalesce(v_fence->>'legacy_repair_job_id', '') = ''
       or coalesce(v_fence->>'user_id', '') <> old.id::text
       or coalesce(v_fence->>'lease_token', '') = ''
       or coalesce(v_fence->>'lease_version', '')
            !~ '^[1-9][0-9]*$'
       or coalesce(v_fence->>'expected_withdrawal_generation', '')
            !~ '^[0-9]+$'
       or not exists (
         select 1
           from public.account_reactivation_legacy_repairs j
           join public.profiles p on p.id = j.user_id
           join public.member_accounts m on m.user_id = j.user_id
          where j.id::text = v_fence->>'legacy_repair_job_id'
            and j.user_id = old.id
            and j.lease_token::text = v_fence->>'lease_token'
            and j.lease_version =
                  (v_fence->>'lease_version')::integer
            and j.status = 'leased'
            and j.leased_until > pg_catalog.clock_timestamp()
            and j.expected_withdrawal_generation =
                  (
                    v_fence->>'expected_withdrawal_generation'
                  )::bigint
            and p.deleted_at is null
            and p.withdrawal_generation =
                  j.expected_withdrawal_generation
            and pg_catalog.lower(pg_catalog.btrim(m.email)) =
                  pg_catalog.lower(
                    pg_catalog.btrim(j.resolved_email)
                  )
            and v_new_email =
                  pg_catalog.lower(
                    pg_catalog.btrim(j.resolved_email)
                  )
       ) then
      raise exception 'stale_reactivation_auth_fence'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Rolling compatibility is safe only after the old route's DB-first
  -- activation and only for the exact restored member email. If a later
  -- withdrawal wins before the old GoTrue call, deleted_at is non-null and
  -- this branch closes before the stale side effect.
  if exists (
    select 1
      from public.profiles p
      join public.member_accounts m on m.user_id = p.id
     where p.id = old.id
       and p.deleted_at is null
       and not exists (
         select 1
           from public.account_reactivation_jobs j
          where j.user_id = old.id
            and j.status in ('pending', 'leased')
       )
       and v_old_email = v_marker
       and m.email is not null
       and v_new_email =
             pg_catalog.lower(pg_catalog.btrim(m.email))
  ) then
    return new;
  end if;

  select exists (
    select 1
      from public.account_reactivation_jobs j
     where j.user_id = old.id
       and j.status in ('pending', 'leased')
  )
  into v_has_job;
  if not v_has_job then
    -- Ordinary active-account email edits and real -> marker withdrawal
    -- scrubs retain their existing behavior. Unfenced marker resurrection is
    -- never an ordinary edit.
    if v_old_email = v_marker and v_new_email <> v_marker then
      raise exception 'stale_reactivation_auth_fence'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if pg_catalog.jsonb_typeof(v_fence) is distinct from 'object'
     or coalesce(v_fence->>'request_id', '') = ''
     or coalesce(v_fence->>'admin_user_id', '') = ''
     or coalesce(v_fence->>'user_id', '') <> old.id::text
     or coalesce(v_fence->>'lease_token', '') = ''
     or coalesce(v_fence->>'lease_version', '')
          !~ '^[1-9][0-9]*$'
     or coalesce(v_fence->>'action', '')
          not in ('activate', 'cancel')
     or coalesce(v_fence->>'expected_deleted_at', '') = ''
     or coalesce(v_fence->>'expected_withdrawal_generation', '')
          !~ '^[1-9][0-9]*$' then
    raise exception 'stale_reactivation_auth_fence'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
      from public.account_reactivation_jobs j
      join public.admin_mutation_requests r
        on r.request_id = j.request_id
      join public.profiles p
        on p.id = j.user_id
      left join public.member_accounts m
        on m.user_id = j.user_id
     where j.request_id::text = v_fence->>'request_id'
       and j.admin_user_id::text = v_fence->>'admin_user_id'
       and j.user_id = old.id
       and j.lease_token::text = v_fence->>'lease_token'
       and j.lease_version =
             (v_fence->>'lease_version')::integer
       and j.status = 'leased'
       and j.leased_until > pg_catalog.clock_timestamp()
       and j.expected_deleted_at =
             (v_fence->>'expected_deleted_at')::timestamptz
       and j.expected_withdrawal_generation =
             (v_fence->>'expected_withdrawal_generation')::bigint
       and p.deleted_at = j.expected_deleted_at
       and p.withdrawal_generation =
             j.expected_withdrawal_generation
       and r.state = 'pending'
       and r.operation = 'account_reactivate'
       and r.admin_user_id = j.admin_user_id
       and r.target_key = j.user_id::text
       and (r.request_payload->>'expected_deleted_at')::timestamptz =
             j.expected_deleted_at
       and (
             r.request_payload->>'expected_withdrawal_generation'
           )::bigint = j.expected_withdrawal_generation
       and pg_catalog.lower(
             pg_catalog.btrim(r.request_payload->>'resolved_email')
           ) = pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
       and (
         (
           v_fence->>'action' = 'activate'
           and j.cancel_requested_at is null
           and v_old_email = v_marker
           and v_new_email =
                 pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
           and m.user_id is not null
           and pg_catalog.lower(
                 pg_catalog.btrim(
                   public.bp_prepare_account_reactivation_email(
                     j.user_id,
                     r.request_payload->>'email_override'
                   )
                 )
               ) = pg_catalog.lower(
                 pg_catalog.btrim(j.resolved_email)
               )
             )
         or
         (
           v_fence->>'action' = 'cancel'
           and j.cancel_requested_at is not null
           and v_old_email =
                 pg_catalog.lower(pg_catalog.btrim(j.resolved_email))
           and v_new_email = v_marker
         )
       )
  ) then
    raise exception 'stale_reactivation_auth_fence'
      using errcode = 'P0001';
  end if;
  return new;
exception
  when invalid_text_representation
    or datetime_field_overflow
    or numeric_value_out_of_range then
    raise exception 'stale_reactivation_auth_fence'
      using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_fence_account_reactivation_auth_email()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_auth_users_fence_account_reactivation
  on auth.users;
create trigger trg_auth_users_fence_account_reactivation
  before update of email on auth.users
  for each row
  execute function public.bp_fence_account_reactivation_auth_email();

revoke all on function public.admin_reactivate_account(
  uuid, uuid, text, text
) from service_role;

-- ── 6. Stuck-order settlement response-loss receipt ────────────────────────

-- Settlement is preceded by an external PortOne verification. A pure,
-- non-tombstoning peek lets a response-loss retry return the durable receipt
-- even when PortOne is temporarily unavailable; a new request still has to
-- perform the external verification before invoking the mutation.
create or replace function public.get_admin_settlement_receipt(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
begin
  perform public.bp_assert_active_admin(p_admin);
  if p_order_uuid is null
     or pg_catalog.char_length(coalesce(p_reason, ''))
          not between 5 and 500 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_payload := pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid,
    'reason', p_reason
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin,
    p_request_id,
    'order_settle',
    p_order_uuid::text,
    v_payload
  );
  if v_replay is null then
    return pg_catalog.jsonb_build_object('ok', true, 'found', false);
  end if;
  if v_replay->>'_state' = 'pending' then
    raise exception 'invalid_request_state' using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'found', true,
    'result', v_replay
  );
end;
$$;
revoke all on function public.get_admin_settlement_receipt(
  uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_admin_settlement_receipt(
  uuid, uuid, text, uuid
) to service_role;

create or replace function public.admin_settle_stuck_order_idempotent(
  p_admin uuid,
  p_order_uuid uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_ledger public.admin_actions_ledger%rowtype;
  v_user_id uuid;
begin
  perform public.bp_assert_active_admin(p_admin);
  if p_order_uuid is null
     or pg_catalog.char_length(coalesce(p_reason, ''))
          not between 5 and 500 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_payload := pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid,
    'reason', p_reason
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin,
    p_request_id,
    'order_settle',
    p_order_uuid::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Serialize distinct request UUIDs on the same financial object before
  -- consulting the unique settlement ledger. Without this lock both requests
  -- could observe "no ledger"; the loser would then get a false
  -- not_settleable instead of the durable no-op receipt.
  perform public.bp_mutation_object_lock('order', p_order_uuid::text);
  select o.user_id
    into v_user_id
    from public.orders o
   where o.order_uuid = p_order_uuid;
  if v_user_id is not null then
    perform public.bp_user_mutation_lock(v_user_id);
  end if;

  -- A distinct stale tab can arrive after the exactly-once financial action.
  -- The append-only unique settlement ledger is sufficient proof that this
  -- order was settled; do not create another audit row or credit lot.
  select *
    into v_ledger
    from public.admin_actions_ledger l
   where l.order_uuid = p_order_uuid
     and l.action_type = 'settle_stuck'
   order by l.created_at, l.id
   limit 1;
  if found then
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'before', v_ledger.before_credits,
      'after', v_ledger.after_credits,
      'credits', v_ledger.credit_delta,
      'noOp', true,
      'idempotent', false
    );
  else
    v_result := public.admin_settle_stuck_order(
      p_admin,
      p_order_uuid,
      p_reason
    ) || pg_catalog.jsonb_build_object(
      'noOp', false,
      'idempotent', false
    );
  end if;

  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin,
    'order_settle',
    p_order_uuid::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$$;
revoke all on function public.admin_settle_stuck_order_idempotent(
  uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.admin_settle_stuck_order_idempotent(
  uuid, uuid, text, uuid
) to service_role;

revoke all on function public.admin_settle_stuck_order(
  uuid, uuid, text
) from service_role;

-- Replace the rolling legacy entry point, preserving its response shape for
-- the old route while atomically recording the GoTrue repair it used to treat
-- as best effort. The old route may still perform the same email update; both
-- paths converge on one exact lifecycle outbox row.
create or replace function public.admin_reactivate_account(
  p_user_id uuid,
  p_admin uuid,
  p_reason text,
  p_email_override text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation bigint;
  v_data jsonb;
  v_email text;
  v_prepared_email text;
begin
  perform public.bp_assert_active_admin(p_admin);
  perform public.bp_mutation_object_lock(
    'reactivation-email-namespace', 'global'
  );
  if not public.bp_rollout_compatibility_enabled(
       'legacy_account_reactivation'
     ) then
    raise exception 'client_refresh_required' using errcode = 'P0001';
  end if;
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  select p.withdrawal_generation
    into v_generation
    from public.profiles p
   where p.id = p_user_id
   for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- The legacy implementation historically accepted any non-empty override
  -- and activated the DB before the route touched Auth. Validate and bind the
  -- same exact email contract before that irreversible state transition.
  v_prepared_email := public.bp_prepare_account_reactivation_email(
    p_user_id,
    nullif(pg_catalog.btrim(p_email_override), '')
  );
  v_data := public.bp_0084_admin_reactivate_account_impl(
    p_user_id, p_admin, p_reason, p_email_override
  );
  v_email := pg_catalog.btrim(v_data->>'email');
  if v_data->>'ok' is distinct from 'true'
     or v_email is null
     or pg_catalog.char_length(v_email) not between 3 and 320
     or pg_catalog.lower(v_email) like '%@deleted.invalid'
     or pg_catalog.lower(v_email) is distinct from
          pg_catalog.lower(pg_catalog.btrim(v_prepared_email)) then
    raise exception 'legacy_reactivation_result_invalid'
      using errcode = 'P0001';
  end if;

  insert into public.account_reactivation_legacy_repairs(
    admin_user_id,
    user_id,
    expected_withdrawal_generation,
    resolved_email
  )
  values (
    p_admin,
    p_user_id,
    v_generation,
    v_email
  )
  on conflict (user_id, expected_withdrawal_generation) do nothing;
  return v_data;
end;
$$;
revoke all on function public.admin_reactivate_account(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;

-- Rolling expand ACL. The new idempotent entry points above are live, while
-- the currently deployed server keeps its exact legacy calls until 0092.
grant execute on function public.admin_update_app_setting(
  text, jsonb, integer, uuid, text
) to service_role;
grant execute on function public.admin_save_event(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, boolean, integer, boolean, boolean, integer, uuid
) to service_role;
grant execute on function public.admin_save_event(
  uuid, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, integer, boolean, boolean, integer, uuid
) to service_role;
grant execute on function public.admin_publish_event(uuid, uuid)
  to service_role;
grant execute on function public.admin_unpublish_event(uuid, uuid)
  to service_role;
grant execute on function public.admin_delete_event(uuid, uuid)
  to service_role;
grant execute on function public.admin_clear_score(uuid, uuid, text)
  to service_role;
grant execute on function public.admin_void_score(uuid, uuid, text)
  to service_role;
grant execute on function public.admin_ban_member(uuid, uuid, text)
  to service_role;
grant execute on function public.admin_unban_member(uuid, uuid, text)
  to service_role;
grant execute on function public.admin_reactivate_account(
  uuid, uuid, text, text
) to service_role;
grant execute on function public.admin_settle_stuck_order(
  uuid, uuid, text
) to service_role;
grant execute on function public.admin_begin_doll_purge(
  uuid, uuid, text
) to service_role;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0085_admin_mutation_idempotency', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
