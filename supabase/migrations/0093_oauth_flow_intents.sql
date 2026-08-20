-- 0093_oauth_flow_intents.sql
--
-- Durable OAuth PKCE hand-off ledger.
--
-- The browser owns every Supabase Auth cookie mutation under its cross-tab
-- locks. The server owns this secret-free state machine so callback retries,
-- response loss, process suspension, remote sign-out, and anonymous-data
-- migration can recover without guessing whether an exchange happened.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- A source receipt already fences one anonymous principal from being replayed
-- into another target. The inverse uniqueness is equally important: without
-- it, two sources can serialize on the target user lock, both observe the
-- member INSERT gap, and merge into the same future member. Production census
-- is required to be duplicate-free; any historical conflict aborts this
-- expand migration instead of choosing a winner.
alter table public.anon_data_reassignments
  add constraint anon_data_reassignments_target_user_id_key
  unique (target_user_id);

alter table public.anon_data_reassignments
  add constraint anon_data_reassignments_result_check
  check (
    pg_catalog.jsonb_typeof(result) = 'object'
    and result ?& array[
      'ok',
      'scores',
      'badges',
      'telemetry'
    ]
    and result - array[
      'ok',
      'scores',
      'badges',
      'telemetry'
    ] = '{}'::jsonb
    and result->'ok' is not distinct from 'true'::jsonb
    and pg_catalog.jsonb_typeof(result->'scores') = 'number'
    and pg_catalog.jsonb_typeof(result->'badges') = 'number'
    and pg_catalog.jsonb_typeof(result->'telemetry') = 'number'
    and result->>'scores' ~ '^(0|[1-9][0-9]{0,9})$'
    and result->>'badges' ~ '^(0|[1-9][0-9]{0,9})$'
    and result->>'telemetry' ~ '^(0|[1-9][0-9]{0,9})$'
    and (
      pg_catalog.length(result->>'scores') < 10
      or result->>'scores' <= '2147483647'
    )
    and (
      pg_catalog.length(result->>'badges') < 10
      or result->>'badges' <= '2147483647'
    )
    and (
      pg_catalog.length(result->>'telemetry') < 10
      or result->>'telemetry' <= '2147483647'
    )
  );

-- A reassignment receipt is a permanent two-sided principal tombstone and the
-- terminal ACK for response-loss replay. No later code path may rewrite or
-- erase it. Table ACLs remain private; the trigger also protects against an
-- accidental owner-level UPDATE/DELETE.
revoke all privileges on table public.anon_data_reassignments
  from public, anon, authenticated, service_role;

create or replace function
  public.guard_anon_data_reassignment_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'anon_data_reassignment_append_only'
    using errcode = 'P0001';
end;
$$;

revoke all on function
  public.guard_anon_data_reassignment_append_only()
  from public, anon, authenticated, service_role;

drop trigger if exists
  trg_anon_data_reassignment_append_only
  on public.anon_data_reassignments;
create trigger trg_anon_data_reassignment_append_only
before update or delete
on public.anon_data_reassignments
for each row
execute function public.guard_anon_data_reassignment_append_only();

create table public.oauth_flow_intents (
  flow_id uuid primary key,
  source_user_id uuid not null,
  source_session_id uuid not null,
  source_access_token_sha256 text not null,
  source_refresh_token_sha256 text not null,
  source_is_anonymous boolean not null,
  provider text not null
    constraint oauth_flow_intents_provider_check
    check (provider in ('google', 'kakao')),
  requested_next text not null,
  state text not null default 'pending'
    constraint oauth_flow_intents_state_check
    check (
      state in (
        'pending',
        'claimed',
        'signout_required',
        'signout_revoked',
        'completed',
        'failed',
        'cancelled',
        'abandoned',
        'expired'
      )
    ),
  active boolean generated always as (
    state in (
      'pending',
      'claimed',
      'signout_required',
      'signout_revoked'
    )
  ) stored,
  session_fenced boolean generated always as (
    state in (
      'pending',
      'claimed',
      'signout_required',
      'signout_revoked'
    )
    or (
      state = 'completed'
      and action = 'continue'
      and released_at is null
    )
  ) stored,
  target_user_id uuid,
  target_session_id uuid,
  target_auth_created_at timestamptz,
  target_auth_instance_id uuid,
  target_session_created_at timestamptz,
  target_access_token_sha256 text,
  target_refresh_token_sha256 text,
  destination text,
  action text
    constraint oauth_flow_intents_action_check
    check (action is null or action in ('continue', 'signout')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  revoke_confirmed_at timestamptz,
  finished_at timestamptz,
  released_at timestamptz,
  migration_consumed_at timestamptz,
  migration_result jsonb,
  constraint oauth_flow_intents_requested_next_check
    check (
      pg_catalog.length(requested_next) between 1 and 2048
      and pg_catalog.left(requested_next, 1) = '/'
      and pg_catalog.left(requested_next, 2) <> '//'
      and pg_catalog.strpos(
        requested_next,
        pg_catalog.chr(92)
      ) = 0
      and requested_next !~ '[[:cntrl:]]'
    ),
  constraint oauth_flow_intents_destination_check
    check (
      destination is null
      or (
        pg_catalog.length(destination) between 1 and 2048
        and pg_catalog.left(destination, 1) = '/'
        and pg_catalog.left(destination, 2) <> '//'
        and pg_catalog.strpos(
          destination,
          pg_catalog.chr(92)
        ) = 0
        and destination !~ '[[:cntrl:]]'
      )
    ),
  constraint oauth_flow_intents_target_identity_check
    check (
      (target_user_id is null) =
      (target_session_id is null)
      and (target_user_id is null) =
        (target_auth_created_at is null)
      and (target_user_id is null) =
        (target_session_created_at is null)
      and (
        target_user_id is not null
        or target_auth_instance_id is null
      )
      and (
        target_session_id is null
        or target_session_id <> source_session_id
      )
      and (
        target_user_id is null
        or not source_is_anonymous
        or target_user_id <> source_user_id
      )
    ),
  constraint oauth_flow_intents_target_evidence_check
    check (
      (target_user_id is null) =
      (target_access_token_sha256 is null)
      and (target_user_id is null) =
      (target_refresh_token_sha256 is null)
      and (
        target_access_token_sha256 is null
        or target_access_token_sha256 ~ '^[0-9a-f]{64}$'
      )
      and (
        target_refresh_token_sha256 is null
        or target_refresh_token_sha256 ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint oauth_flow_intents_source_evidence_check
    check (
      source_access_token_sha256 ~ '^[0-9a-f]{64}$'
      and source_refresh_token_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint oauth_flow_intents_migration_receipt_check
    check (
      (migration_consumed_at is null) =
      (migration_result is null)
      and (
        migration_result is null
        or (
          (
            pg_catalog.jsonb_typeof(migration_result) = 'object'
            and migration_result ?& array[
              'ok',
              'scores',
              'badges',
              'telemetry'
            ]
            and migration_result - array[
              'ok',
              'scores',
              'badges',
              'telemetry'
            ] = '{}'::jsonb
            and migration_result->'ok'
              is not distinct from 'true'::jsonb
            and pg_catalog.jsonb_typeof(
              migration_result->'scores'
            ) = 'number'
            and pg_catalog.jsonb_typeof(
              migration_result->'badges'
            ) = 'number'
            and pg_catalog.jsonb_typeof(
              migration_result->'telemetry'
            ) = 'number'
            and migration_result->>'scores'
              ~ '^(0|[1-9][0-9]{0,9})$'
            and migration_result->>'badges'
              ~ '^(0|[1-9][0-9]{0,9})$'
            and migration_result->>'telemetry'
              ~ '^(0|[1-9][0-9]{0,9})$'
            and (
              pg_catalog.length(migration_result->>'scores') < 10
              or migration_result->>'scores' <= '2147483647'
            )
            and (
              pg_catalog.length(migration_result->>'badges') < 10
              or migration_result->>'badges' <= '2147483647'
            )
            and (
              pg_catalog.length(migration_result->>'telemetry') < 10
              or migration_result->>'telemetry' <= '2147483647'
            )
          )
          or (
            pg_catalog.jsonb_typeof(migration_result) = 'object'
            and migration_result ?& array['ok', 'skipped']
            and migration_result - array['ok', 'skipped'] =
              '{}'::jsonb
            and migration_result->'ok'
              is not distinct from 'true'::jsonb
            and pg_catalog.jsonb_typeof(
              migration_result->'skipped'
            ) = 'string'
            and migration_result->>'skipped' in (
              'target_already_member',
              'target_already_claimed',
              'source_already_claimed',
              'source_not_anonymous',
              'source_is_member',
              'unexpected_source_data',
              'source_generation_changed',
              'source_already_absent',
              'target_withdrawn',
              'recovery_expired'
            )
          )
        )
      )
    ),
  constraint oauth_flow_intents_time_order_check
    check (
      expires_at = created_at + interval '10 minutes'
      and (
        claimed_at is null
        or (
          claimed_at >= created_at
          and claimed_at < expires_at
        )
      )
      and (
        revoke_confirmed_at is null
        or (
          claimed_at is not null
          and revoke_confirmed_at >= claimed_at
        )
      )
      and (
        finished_at is null
        or (
          finished_at >= coalesce(
            claimed_at,
            created_at
          )
          and (
            revoke_confirmed_at is null
            or finished_at >= revoke_confirmed_at
            or (
              state = 'completed'
              and action = 'continue'
              and released_at is not null
              and released_at >= revoke_confirmed_at
            )
          )
        )
      )
      and (
        migration_consumed_at is null
        or (
          finished_at is not null
          and migration_consumed_at >= finished_at
        )
      )
      and (
        released_at is null
        or (
          finished_at is not null
          and released_at >= greatest(
            finished_at,
            coalesce(revoke_confirmed_at, finished_at)
          )
        )
      )
      and (
        state <> 'expired'
        or finished_at >= expires_at
      )
    ),
  constraint oauth_flow_intents_state_shape_check
    check (
      (
        state = 'pending'
        and target_user_id is null
        and target_session_id is null
        and destination is null
        and action is null
        and claimed_at is null
        and revoke_confirmed_at is null
        and finished_at is null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'claimed'
        and destination is null
        and action is null
        and claimed_at is not null
        and revoke_confirmed_at is null
        and finished_at is null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'signout_required'
        and target_user_id is not null
        and target_session_id is not null
        and destination is not null
        and action = 'signout'
        and claimed_at is not null
        and revoke_confirmed_at is null
        and finished_at is null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'signout_revoked'
        and target_user_id is not null
        and target_session_id is not null
        and destination is not null
        and action = 'signout'
        and claimed_at is not null
        and revoke_confirmed_at is not null
        and finished_at is null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'completed'
        and target_user_id is not null
        and target_session_id is not null
        and destination is not null
        and claimed_at is not null
        and finished_at is not null
        and (
          released_at is null
          or action = 'continue'
        )
        and (
          (
            action = 'continue'
            and (
              revoke_confirmed_at is null
              or (
                revoke_confirmed_at is not null
                and released_at is not null
              )
            )
          )
          or (
            action = 'signout'
            and revoke_confirmed_at is not null
          )
        )
        and (
          (
            migration_consumed_at is null
            and migration_result is null
          )
          or (
            action = 'continue'
            and source_is_anonymous
            and revoke_confirmed_at is null
            and migration_consumed_at is not null
            and migration_result is not null
            and (
              released_at is not null
              or migration_result =
                '{"ok":true,"skipped":"target_already_member"}'::jsonb
            )
          )
        )
      )
      or (
        state = 'failed'
        and target_user_id is null
        and target_session_id is null
        and destination is not null
        and action = 'continue'
        and claimed_at is not null
        and revoke_confirmed_at is null
        and finished_at is not null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'cancelled'
        and target_user_id is null
        and target_session_id is null
        and destination is null
        and action is null
        and claimed_at is null
        and revoke_confirmed_at is null
        and finished_at is not null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'abandoned'
        and destination is null
        and action is null
        and claimed_at is not null
        and target_user_id is not null
        and target_session_id is not null
        and revoke_confirmed_at is not null
        and finished_at is not null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
      or (
        state = 'expired'
        and target_user_id is null
        and target_session_id is null
        and destination is null
        and action is null
        and revoke_confirmed_at is null
        and finished_at is not null
        and released_at is null
        and migration_consumed_at is null
        and migration_result is null
      )
    )
);

alter table public.oauth_flow_intents enable row level security;

revoke all on table public.oauth_flow_intents
  from public, anon, authenticated, service_role;

create unique index
  oauth_flow_intents_one_fenced_source_session_uidx
  on public.oauth_flow_intents (source_session_id)
  where session_fenced;

create index oauth_flow_intents_fenced_target_session_idx
  on public.oauth_flow_intents (
    target_session_id,
    target_user_id,
    flow_id
  )
  where session_fenced
    and target_session_id is not null;

create index oauth_flow_intents_revoked_target_session_idx
  on public.oauth_flow_intents (target_session_id, flow_id)
  where target_session_id is not null
    and revoke_confirmed_at is not null;

create index oauth_flow_intents_pending_expiry_idx
  on public.oauth_flow_intents (expires_at, flow_id)
  where state = 'pending';

create index oauth_flow_intents_terminal_retention_idx
  on public.oauth_flow_intents (finished_at, flow_id)
  where state in (
    'completed',
    'failed',
    'cancelled',
    'abandoned',
    'expired'
  );

create table public.oauth_anon_auth_cleanup_jobs (
  cleanup_id uuid primary key default pg_catalog.gen_random_uuid(),
  flow_id uuid unique
    references public.oauth_flow_intents(flow_id)
    on delete cascade,
  legacy_source_user_id uuid unique
    references public.anon_data_reassignments(source_user_id)
    on delete cascade,
  source_user_id uuid not null,
  source_auth_created_at timestamptz not null,
  source_auth_instance_id uuid,
  status text not null default 'dormant'
    constraint oauth_anon_auth_cleanup_jobs_status_check
    check (
      status in (
        'dormant',
        'quarantined',
        'pending',
        'leased',
        'completed',
        'protected',
        'scrubbed',
        'blocked'
      )
    ),
  quarantine_reason text
    constraint oauth_anon_auth_cleanup_jobs_quarantine_reason_check
    check (
      quarantine_reason is null
      or quarantine_reason in (
        'target_session_missing',
        'target_withdrawn',
        'target_already_member',
        'target_already_claimed',
        'migration_blocked'
      )
    ),
  quarantined_at timestamptz,
  recover_until timestamptz,
  scrubbed_at timestamptz,
  access_revoked_at timestamptz,
  consumed_target_session_id uuid,
  consumed_target_session_created_at timestamptz,
  consumed_access_token_sha256 text,
  consumed_refresh_token_sha256 text,
  lease_token uuid,
  lease_version integer not null default 0
    constraint oauth_anon_auth_cleanup_jobs_lease_version_check
    check (lease_version between 0 and 2147483647),
  attempt_count integer not null default 0
    constraint oauth_anon_auth_cleanup_jobs_attempt_count_check
    check (
      attempt_count between 0 and 2147483647
      and attempt_count = lease_version
    ),
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  last_error text
    constraint oauth_anon_auth_cleanup_jobs_last_error_check
    check (
      last_error is null
      or (
        pg_catalog.length(last_error) between 1 and 160
        and last_error !~ '[[:cntrl:]]'
      )
    ),
  created_at timestamptz not null,
  armed_at timestamptz,
  finished_at timestamptz,
  constraint oauth_anon_auth_cleanup_jobs_origin_check
    check (
      (
        flow_id is not null
        and cleanup_id = flow_id
        and legacy_source_user_id is null
      )
      or (
        flow_id is null
        and legacy_source_user_id = source_user_id
      )
    ),
  constraint oauth_anon_auth_cleanup_jobs_time_check
    check (
      source_auth_created_at <= created_at
      and (
        armed_at is null
        or armed_at >= created_at
      )
      and (
        lease_expires_at is null
        or lease_expires_at > armed_at
      )
      and (
        finished_at is null
        or finished_at >= armed_at
      )
      and (
        quarantined_at is null
        or quarantined_at >= created_at
      )
      and (
        recover_until is null
        or recover_until >= created_at
      )
      and (
        scrubbed_at is null
        or (
          quarantined_at is not null
          and scrubbed_at >= quarantined_at
        )
      )
      and (
        access_revoked_at is null
        or access_revoked_at >= created_at
      )
    ),
  constraint oauth_anon_auth_cleanup_jobs_quarantine_check
    check (
      (quarantine_reason is null) =
        (quarantined_at is null)
      and (
        flow_id is not null
        or (
          quarantine_reason is null
          and recover_until is null
          and scrubbed_at is null
        )
      )
      and (
        flow_id is null
        or recover_until is not null
      )
    ),
  constraint oauth_anon_auth_cleanup_jobs_consumed_authority_check
    check (
      (consumed_target_session_id is null) =
        (consumed_target_session_created_at is null)
      and (consumed_target_session_id is null) =
        (consumed_access_token_sha256 is null)
      and (consumed_target_session_id is null) =
        (consumed_refresh_token_sha256 is null)
      and (
        consumed_access_token_sha256 is null
        or consumed_access_token_sha256 ~ '^[0-9a-f]{64}$'
      )
      and (
        consumed_refresh_token_sha256 is null
        or consumed_refresh_token_sha256 ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint oauth_anon_auth_cleanup_jobs_shape_check
    check (
      (
        status = 'dormant'
        and armed_at is null
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is null
        and last_error is null
        and lease_version = 0
        and attempt_count = 0
        and quarantine_reason is null
        and quarantined_at is null
        and scrubbed_at is null
        and access_revoked_at is null
      )
      or (
        status = 'quarantined'
        and quarantine_reason in (
          'target_session_missing',
          'target_already_member',
          'target_already_claimed'
        )
        and quarantined_at is not null
        and recover_until is not null
        and scrubbed_at is null
        and access_revoked_at is not null
        and armed_at is null
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is null
        and last_error is null
      )
      or (
        status = 'pending'
        and armed_at is not null
        and next_attempt_at is not null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is null
      )
      or (
        status = 'leased'
        and armed_at is not null
        and next_attempt_at is not null
        and lease_token is not null
        and lease_expires_at is not null
        and finished_at is null
      )
      or (
        status = 'completed'
        and armed_at is not null
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is not null
        and last_error is null
      )
      or (
        status = 'protected'
        and armed_at is not null
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is not null
        and last_error in (
          'source_not_anonymous',
          'source_generation_changed',
          'migration_not_applicable',
          'legacy_source_not_deletable',
          'cleanup_attempt_limit_exhausted'
        )
      )
      or (
        status = 'scrubbed'
        and quarantine_reason is not null
        and quarantined_at is not null
        and recover_until is not null
        and scrubbed_at is not null
        and access_revoked_at is not null
        and armed_at is not null
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at = scrubbed_at
        and last_error is null
      )
      or (
        status = 'blocked'
        and quarantine_reason is not null
        and quarantined_at is not null
        and recover_until is not null
        and scrubbed_at is null
        and armed_at is null
        and next_attempt_at is null
        and lease_token is null
        and lease_expires_at is null
        and finished_at is null
        and last_error in (
          'source_not_anonymous',
          'source_generation_changed',
          'source_is_member',
          'unexpected_source_data',
          'target_generation_changed',
          'scrub_failed'
        )
      )
    )
);

alter table public.oauth_anon_auth_cleanup_jobs
  enable row level security;

revoke all on table public.oauth_anon_auth_cleanup_jobs
  from public, anon, authenticated, service_role;

create index oauth_anon_auth_cleanup_jobs_claim_idx
  on public.oauth_anon_auth_cleanup_jobs (
    next_attempt_at,
    created_at,
    cleanup_id
  )
  where status in ('pending', 'leased');

create index oauth_anon_auth_cleanup_jobs_source_fence_idx
  on public.oauth_anon_auth_cleanup_jobs (
    source_user_id,
    status,
    cleanup_id
  )
  where status in ('pending', 'leased');

create unique index
  oauth_anon_auth_cleanup_jobs_flow_source_generation_uidx
  on public.oauth_anon_auth_cleanup_jobs (source_user_id)
  where flow_id is not null
    and status <> 'completed';

create index oauth_anon_auth_cleanup_jobs_privacy_due_idx
  on public.oauth_anon_auth_cleanup_jobs (
    recover_until,
    created_at,
    cleanup_id
  )
  where status in ('dormant', 'quarantined', 'blocked');

-- Quarantine may hide only highlights that were live at that transition.
-- A timestamp alone is not an ownership marker: an unrelated deletion can
-- have the same value. Keep the exact flow/row correlation in a default-deny
-- table so public score_highlights SELECT cannot disclose OAuth flow IDs.
create table public.oauth_quarantined_score_highlights (
  score_id uuid primary key
    references public.score_highlights(score_id)
    on delete cascade,
  -- Deliberately no flow FK: a private restore marker must not extend or
  -- otherwise couple OAuth receipt retention.
  flow_id uuid not null,
  quarantined_at timestamptz not null
);

create index oauth_quarantined_score_highlights_flow_idx
  on public.oauth_quarantined_score_highlights(flow_id, score_id);

alter table public.oauth_quarantined_score_highlights
  enable row level security;
revoke all on table public.oauth_quarantined_score_highlights
  from public, anon, authenticated, service_role;

-- Any later independent moderation/deletion-state write relinquishes the
-- OAuth flow's restore authority. The quarantine write happens before its
-- private marker is inserted, so it cannot clear its own marker.
create or replace function
  public.clear_oauth_quarantined_score_highlight_marker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.highlight_deleted_at
       is distinct from old.highlight_deleted_at
     or new.highlight_deleted_by_doll
       is distinct from old.highlight_deleted_by_doll then
    delete from public.oauth_quarantined_score_highlights
     where score_id = old.score_id;
  end if;
  return new;
end;
$$;

revoke all on function
  public.clear_oauth_quarantined_score_highlight_marker()
  from public, anon, authenticated, service_role;

create trigger trg_score_highlights_clear_oauth_quarantine_marker
before update of
  highlight_deleted_at,
  highlight_deleted_by_doll
on public.score_highlights
for each row
execute function
  public.clear_oauth_quarantined_score_highlight_marker();

-- A scrubbed anonymous source keeps deidentified scores under its UUID shell.
-- This target-unlinked tombstone survives flow retention so a later manual
-- Auth hard-delete cannot cascade those scores away.
create table public.oauth_deidentified_score_owner_tombstones (
  source_user_id uuid primary key,
  deidentified_at timestamptz not null,
  reason text not null
    constraint oauth_deidentified_score_owner_tombstones_reason_check
    check (
      reason in (
        'target_withdrawn',
        'recovery_expired',
        'terminal_no_transfer'
      )
    )
);

alter table public.oauth_deidentified_score_owner_tombstones
  enable row level security;
revoke all on table public.oauth_deidentified_score_owner_tombstones
  from public, anon, authenticated, service_role;

-- Flow retention is finite, but an Auth session UUID is a bearer-capability
-- generation identifier. Preserve every source, callback target, and actual
-- consume-session UUID before its parent receipt can be deleted so a later
-- auth.sessions INSERT can never reuse historical OAuth authority.
create table public.oauth_auth_session_id_tombstones (
  session_id uuid primary key,
  tombstoned_at timestamptz not null,
  reason text not null
    constraint oauth_auth_session_id_tombstones_reason_check
    check (
      reason in (
        'flow_source',
        'flow_target',
        'consumed_target'
      )
    )
);

alter table public.oauth_auth_session_id_tombstones
  enable row level security;
revoke all on table public.oauth_auth_session_id_tombstones
  from public, anon, authenticated, service_role;

-- Deleting auth.sessions cannot invalidate an already-issued JWT immediately.
-- Every private client policy must therefore prove that the JWT's session_id
-- still names a live Auth session for auth.uid(). Historical IDs are also
-- permanently rejected, even if an upstream bug attempts to recreate a row.
create or replace function
  public.oauth_current_auth_session_live()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id_text text := auth.jwt()->>'session_id';
  v_session_id uuid;
begin
  if v_user_id is null
     or v_session_id_text is null
     or v_session_id_text !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  begin
    v_session_id := v_session_id_text::uuid;
  exception
    when invalid_text_representation then
      return false;
  end;
  return
    exists (
      select 1
        from auth.sessions as auth_session
       where auth_session.id = v_session_id
         and auth_session.user_id = v_user_id
    )
    and not exists (
      select 1
        from public.oauth_auth_session_id_tombstones
          as tombstone
       where tombstone.session_id = v_session_id
    );
end;
$$;

revoke all on function public.oauth_current_auth_session_live()
  from public, anon, authenticated, service_role;
grant execute on function
  public.oauth_current_auth_session_live()
  to authenticated;

-- Rebuild every current private browser policy around the common live-session
-- proof. Public profile/ranking projections remain public, but a deleted
-- session can no longer read private membership/doll/badge rows or mutate the
-- source profile while its access JWT has not yet expired.
drop policy if exists "dolls: owner read" on public.dolls;
create policy "dolls: owner read"
  on public.dolls
  for select
  to authenticated
  using (
    auth.uid() = owner_id
    and public.oauth_current_auth_session_live()
  );

drop policy if exists "member_accounts: self read"
  on public.member_accounts;
create policy "member_accounts: self read"
  on public.member_accounts
  for select
  to authenticated
  using (
    auth.uid() = user_id
    and public.oauth_current_auth_session_live()
  );

drop policy if exists "profiles: self update" on public.profiles;
create policy "profiles: self update"
  on public.profiles
  for update
  to authenticated
  using (
    auth.uid() = id
    and deleted_at is null
    and public.oauth_current_auth_session_live()
  )
  with check (
    auth.uid() = id
    and deleted_at is null
    and public.oauth_current_auth_session_live()
  );

-- A quarantined or scrubbed anonymous source additionally loses badge access
-- even if an unrelated live session for the same principal still exists.
create or replace function
  public.oauth_current_badge_owner_readable()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.oauth_current_auth_session_live()
    and exists (
      select 1
        from public.profiles as profile
       where profile.id = auth.uid()
         and profile.deleted_at is null
    )
    and not exists (
      select 1
        from public.oauth_anon_auth_cleanup_jobs as cleanup
       where cleanup.source_user_id = auth.uid()
         and cleanup.access_revoked_at is not null
    )
    and not exists (
      select 1
        from public.oauth_deidentified_score_owner_tombstones
          as tombstone
       where tombstone.source_user_id = auth.uid()
    )
$$;

revoke all on function public.oauth_current_badge_owner_readable()
  from public, anon, authenticated, service_role;
grant execute on function
  public.oauth_current_badge_owner_readable()
  to authenticated;

drop policy if exists "user_badges: self read"
  on public.user_badges;
create policy "user_badges: self read"
  on public.user_badges
  for select
  to authenticated
  using (
    auth.uid() = owner_id
    and public.oauth_current_badge_owner_readable()
  );

create or replace function
  public.guard_oauth_auth_session_id_tombstone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'oauth_auth_session_id_tombstone_append_only'
    using errcode = 'P0001';
end;
$$;

revoke all on function
  public.guard_oauth_auth_session_id_tombstone()
  from public, anon, authenticated, service_role;

create trigger trg_oauth_auth_session_id_tombstone_append_only
before update or delete
on public.oauth_auth_session_id_tombstones
for each row
execute function public.guard_oauth_auth_session_id_tombstone();

create or replace function
  public.tombstone_oauth_flow_auth_session_ids()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.oauth_auth_session_id_tombstones(
    session_id,
    tombstoned_at,
    reason
  )
  select candidate.session_id,
         pg_catalog.clock_timestamp(),
         candidate.reason
    from (
      values
        (old.source_session_id, 'flow_source'::text),
        (old.target_session_id, 'flow_target'::text)
    ) as candidate(session_id, reason)
   where candidate.session_id is not null
  on conflict (session_id) do nothing;
  return old;
end;
$$;

revoke all on function
  public.tombstone_oauth_flow_auth_session_ids()
  from public, anon, authenticated, service_role;

create trigger trg_oauth_flow_tombstone_auth_session_ids
before delete on public.oauth_flow_intents
for each row
execute function public.tombstone_oauth_flow_auth_session_ids();

create or replace function
  public.tombstone_oauth_cleanup_consumed_session_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.consumed_target_session_id is not null then
    insert into public.oauth_auth_session_id_tombstones(
      session_id,
      tombstoned_at,
      reason
    )
    values (
      old.consumed_target_session_id,
      pg_catalog.clock_timestamp(),
      'consumed_target'
    )
    on conflict (session_id) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function
  public.tombstone_oauth_cleanup_consumed_session_id()
  from public, anon, authenticated, service_role;

create trigger trg_oauth_cleanup_tombstone_consumed_session_id
before delete on public.oauth_anon_auth_cleanup_jobs
for each row
execute function public.tombstone_oauth_cleanup_consumed_session_id();

create or replace function
  public.guard_oauth_deidentified_score_owner_tombstone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'oauth_deidentified_score_owner_tombstone_append_only'
    using errcode = 'P0001';
end;
$$;

revoke all on function
  public.guard_oauth_deidentified_score_owner_tombstone()
  from public, anon, authenticated, service_role;

create trigger trg_oauth_deidentified_score_owner_tombstone_append_only
before update or delete
on public.oauth_deidentified_score_owner_tombstones
for each row
execute function
  public.guard_oauth_deidentified_score_owner_tombstone();

create or replace function
  public.guard_oauth_deidentified_score_owner_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
      from public.oauth_deidentified_score_owner_tombstones as tombstone
     where tombstone.source_user_id = old.id
  )
  and exists (
    select 1
      from public.scores as score
     where score.owner_id = old.id
  ) then
    raise exception 'oauth_deidentified_score_owner_hard_delete_blocked'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

revoke all on function
  public.guard_oauth_deidentified_score_owner_profile_delete()
  from public, anon, authenticated, service_role;

create trigger trg_profiles_guard_oauth_deidentified_score_owner_delete
before delete on public.profiles
for each row
execute function
  public.guard_oauth_deidentified_score_owner_profile_delete();

-- Recover any pre-0093 raw receipt whose exact original anonymous Auth
-- generation is still present. A recreated/newer, promoted, member-owned, or
-- newly data-bearing source is recorded as protected and is never returned as
-- a successful replay to an old caller. An absent source needs no deletion
-- job; the hardened wrapper proves that absence again under the source fence.
with candidate as (
  select
    receipt.source_user_id,
    source_user.created_at as source_auth_created_at,
    source_user.instance_id as source_auth_instance_id,
    greatest(
      receipt.created_at,
      source_user.created_at
    ) as observed_at,
    (
      source_user.is_anonymous is true
      and source_user.created_at <= receipt.created_at
      and not exists (
        select 1
          from public.member_accounts as source_member
         where source_member.user_id = receipt.source_user_id
      )
      and not exists (
        select 1
          from public.dolls
         where owner_id = receipt.source_user_id
      )
      and not exists (
        select 1
          from public.orders
         where user_id = receipt.source_user_id
      )
      and not exists (
        select 1
          from public.ai_generations
         where owner_id = receipt.source_user_id
      )
    ) as deletable
  from public.anon_data_reassignments as receipt
  join auth.users as source_user
    on source_user.id = receipt.source_user_id
  where source_user.created_at is not null
)
insert into public.oauth_anon_auth_cleanup_jobs (
  legacy_source_user_id,
  source_user_id,
  source_auth_created_at,
  source_auth_instance_id,
  status,
  next_attempt_at,
  last_error,
  created_at,
  armed_at,
  finished_at
)
select
  source_user_id,
  source_user_id,
  source_auth_created_at,
  source_auth_instance_id,
  case when deletable then 'pending' else 'protected' end,
  case when deletable then observed_at else null end,
  case
    when deletable then null
    else 'legacy_source_not_deletable'
  end,
  observed_at,
  observed_at,
  case when deletable then null else observed_at end
from candidate;

create table public.legacy_signup_migration_receipts (
  source_user_id uuid not null,
  expires_at timestamptz not null,
  issued_at timestamptz not null,
  target_user_id uuid not null,
  target_session_id uuid not null,
  consumed_at timestamptz not null,
  migration_result jsonb not null,
  primary key (source_user_id, expires_at),
  constraint legacy_signup_migration_receipts_identity_check
    check (source_user_id <> target_user_id),
  constraint legacy_signup_migration_receipts_time_check
    check (
      expires_at = issued_at + interval '15 minutes'
      and consumed_at >= issued_at
      and consumed_at <= expires_at
    ),
  constraint legacy_signup_migration_receipts_result_check
    check (
      (
        pg_catalog.jsonb_typeof(migration_result) = 'object'
        and migration_result ?& array[
          'ok',
          'scores',
          'badges',
          'telemetry'
        ]
        and migration_result - array[
          'ok',
          'scores',
          'badges',
          'telemetry'
        ] = '{}'::jsonb
        and migration_result->'ok'
          is not distinct from 'true'::jsonb
        and pg_catalog.jsonb_typeof(
          migration_result->'scores'
        ) = 'number'
        and pg_catalog.jsonb_typeof(
          migration_result->'badges'
        ) = 'number'
        and pg_catalog.jsonb_typeof(
          migration_result->'telemetry'
        ) = 'number'
        and migration_result->>'scores'
          ~ '^(0|[1-9][0-9]{0,9})$'
        and migration_result->>'badges'
          ~ '^(0|[1-9][0-9]{0,9})$'
        and migration_result->>'telemetry'
          ~ '^(0|[1-9][0-9]{0,9})$'
        and (
          pg_catalog.length(migration_result->>'scores') < 10
          or migration_result->>'scores' <= '2147483647'
        )
        and (
          pg_catalog.length(migration_result->>'badges') < 10
          or migration_result->>'badges' <= '2147483647'
        )
        and (
          pg_catalog.length(migration_result->>'telemetry') < 10
          or migration_result->>'telemetry' <= '2147483647'
        )
      )
      or (
        pg_catalog.jsonb_typeof(migration_result) = 'object'
        and migration_result ?& array['ok', 'skipped']
        and migration_result - array['ok', 'skipped'] =
          '{}'::jsonb
        and migration_result->'ok'
          is not distinct from 'true'::jsonb
        and migration_result->>'skipped' in (
          'target_already_member',
          'target_already_claimed',
          'source_already_claimed',
          'source_not_anonymous',
          'source_generation_changed',
          'source_is_member',
          'unexpected_source_data',
          'source_already_absent'
        )
      )
    )
);

alter table public.legacy_signup_migration_receipts
  enable row level security;
revoke all on table public.legacy_signup_migration_receipts
  from public, anon, authenticated, service_role;

create or replace function
  public.guard_legacy_signup_migration_receipt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'legacy_signup_migration_receipt_append_only'
    using errcode = 'P0001';
end;
$$;

revoke all on function
  public.guard_legacy_signup_migration_receipt()
  from public, anon, authenticated, service_role;

create trigger trg_legacy_signup_migration_receipt_append_only
before update or delete
on public.legacy_signup_migration_receipts
for each row execute function
  public.guard_legacy_signup_migration_receipt();

create or replace function
  public.fence_oauth_anon_auth_cleanup_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first_id uuid;
  v_old_id uuid;
  v_second_id uuid;
begin
  if new.id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.id is not distinct from old.id
     and new.is_anonymous is not distinct from old.is_anonymous
     and new.created_at is not distinct from old.created_at
     and new.instance_id is not distinct from old.instance_id then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.id is not null
     and old.id is distinct from new.id then
    v_old_id := old.id;
    v_first_id := least(old.id, new.id);
    v_second_id := greatest(old.id, new.id);
  else
    if tg_op = 'UPDATE' then
      v_old_id := old.id;
    end if;
    v_first_id := new.id;
    v_second_id := null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' || v_first_id::text,
      0
    )
  );
  if v_second_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-anon-auth-cleanup:' || v_second_id::text,
        0
      )
    );
  end if;

  if exists (
    select 1
      from public.oauth_anon_auth_cleanup_jobs
     where status in ('pending', 'leased')
       and (
         source_user_id = new.id
         or source_user_id = v_old_id
       )
  ) then
    raise exception 'oauth_anon_auth_cleanup_pending'
      using errcode = '23514';
  end if;
  -- A committed ownership or compatibility receipt is a permanent principal
  -- generation tombstone on both sides. Reusing either UUID, or rewriting its
  -- generation fields in place, could replay a historical migration into a
  -- different Auth principal.
  if exists (
    select 1
      from public.anon_data_reassignments as receipt
     where receipt.source_user_id in (new.id, v_old_id)
        or receipt.target_user_id in (new.id, v_old_id)
  ) then
    raise exception 'anon_reassignment_principal_tombstoned'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.legacy_signup_migration_receipts as receipt
     where receipt.target_user_id in (new.id, v_old_id)
  ) then
    raise exception 'legacy_signup_target_generation_tombstoned'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.oauth_flow_intents as flow
     where flow.source_user_id in (new.id, v_old_id)
        or flow.target_user_id in (new.id, v_old_id)
  ) then
    raise exception 'oauth_flow_target_generation_tombstoned'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.oauth_deidentified_score_owner_tombstones as tombstone
     where tombstone.source_user_id in (new.id, v_old_id)
  ) then
    raise exception 'oauth_deidentified_score_owner_principal_tombstoned'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function
  public.fence_oauth_anon_auth_cleanup_user()
  from public, anon, authenticated, service_role;

drop trigger if exists
  trg_auth_users_fence_oauth_anon_cleanup_insert
  on auth.users;
create trigger trg_auth_users_fence_oauth_anon_cleanup_insert
before insert
on auth.users
for each row
execute function public.fence_oauth_anon_auth_cleanup_user();

drop trigger if exists
  trg_auth_users_fence_oauth_anon_cleanup_update
  on auth.users;
create trigger trg_auth_users_fence_oauth_anon_cleanup_update
before update of
  id,
  is_anonymous,
  created_at,
  instance_id
on auth.users
for each row
execute function public.fence_oauth_anon_auth_cleanup_user();

create or replace function
  public.fence_oauth_retained_anon_auth_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- DELETE already owns the Auth tuple. A non-locking committed-state read is
  -- deliberate: every transition into pending/leased locks the cleanup row
  -- before this tuple, so a concurrent uncommitted transition is observed as
  -- its older retained state and the delete fails closed instead of forming a
  -- job -> Auth / Auth -> job deadlock.
  if exists (
    select 1
      from public.oauth_anon_auth_cleanup_jobs as cleanup
     where cleanup.source_user_id = old.id
       and cleanup.status in (
         'dormant',
         'quarantined',
         'blocked',
         'scrubbed',
         'protected'
       )
  ) then
    raise exception 'oauth_anon_auth_source_retained'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

revoke all on function
  public.fence_oauth_retained_anon_auth_delete()
  from public, anon, authenticated, service_role;

create trigger trg_auth_users_fence_oauth_retained_anon_delete
before delete on auth.users
for each row
execute function public.fence_oauth_retained_anon_auth_delete();

create or replace function public.fence_revoked_oauth_target_session_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then
      -- Session primary keys are capabilities. Renaming one would move a live
      -- capability out from under every durable flow/revocation receipt.
      raise exception 'oauth_auth_session_id_immutable'
        using errcode = '23514';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'oauth_auth_session_user_immutable'
        using errcode = '23514';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'oauth_auth_session_generation_immutable'
        using errcode = '23514';
    end if;
    return new;
  end if;

  -- Serialize source-session creation with quarantine/cleanup by waiting on
  -- the retained Auth principal first. If INSERT wins, the later transition
  -- observes and deletes this session; if transition wins, this post-wait
  -- committed-state read rejects recreation.
  perform 1
    from auth.users as auth_user
   where auth_user.id = new.user_id
   for key share of auth_user;
  if exists (
    select 1
     from public.oauth_anon_auth_cleanup_jobs as cleanup
     where cleanup.source_user_id = new.user_id
       and (
         cleanup.status in ('pending', 'leased')
         or cleanup.access_revoked_at is not null
       )
  )
  or exists (
    select 1
      from public.oauth_deidentified_score_owner_tombstones as tombstone
     where tombstone.source_user_id = new.user_id
  ) then
    raise exception 'oauth_anon_auth_source_session_retained'
      using errcode = '23514';
  end if;

  -- Auth session creation participates in the same association lock as OAuth
  -- cleanup. If creation wins, cleanup observes and deletes that exact row. If
  -- cleanup wins, the committed tombstone rejects UUID reuse after the wait.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' || new.id::text,
      0
    )
  );

  if exists (
    select 1
      from public.oauth_flow_intents as flow
     where flow.source_session_id = new.id
        or flow.target_session_id = new.id
  )
  or exists (
    select 1
      from public.legacy_signup_migration_receipts as receipt
     where receipt.target_session_id = new.id
  )
  or exists (
    select 1
      from public.oauth_anon_auth_cleanup_jobs as cleanup
     where cleanup.consumed_target_session_id = new.id
  )
  or exists (
    select 1
      from public.oauth_auth_session_id_tombstones as tombstone
     where tombstone.session_id = new.id
  ) then
    raise exception 'migration_target_session_id_tombstoned'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.fence_revoked_oauth_target_session_id()
  from public, anon, authenticated, service_role;

drop trigger if exists
  trg_auth_sessions_fence_revoked_oauth_target_id
  on auth.sessions;
create trigger trg_auth_sessions_fence_revoked_oauth_target_id
before insert or update of id, user_id, created_at on auth.sessions
for each row
execute function public.fence_revoked_oauth_target_session_id();

create or replace function
  public.bp_0093_oauth_target_generation_matches(
    p_source_user_id uuid,
    p_target_user_id uuid,
    p_target_session_id uuid,
    p_target_auth_created_at timestamptz,
    p_target_auth_instance_id uuid,
    p_target_session_created_at timestamptz
  )
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_matches boolean;
begin
  if p_source_user_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_target_auth_created_at is null
     or p_target_session_created_at is null then
    return false;
  end if;

  -- Auth deletion starts from auth.users and cascades into auth.sessions.
  -- Lock both principal rows exclusively in UUID order before any caller can
  -- later upgrade the source row. Two swapped A->B / B->A flows would
  -- otherwise each hold SHARE on both rows and deadlock while upgrading a
  -- different source. Re-reading below makes both an existing-row delete and
  -- an initially-absent UUID recreation serialize.
  perform 1
    from auth.users as auth_user
   where auth_user.id in (
     p_source_user_id,
     p_target_user_id
   )
   order by auth_user.id
   for update of auth_user;
  perform 1
    from auth.sessions as target_session
   where target_session.id = p_target_session_id
   for update of target_session;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' ||
      p_target_session_id::text,
      0
    )
  );

  select exists (
    select 1
      from auth.users as target_user
      join auth.sessions as target_session
        on target_session.user_id = target_user.id
     where target_user.id = p_target_user_id
       and target_user.is_anonymous is false
       and target_user.created_at =
         p_target_auth_created_at
       and target_user.instance_id is not distinct from
         p_target_auth_instance_id
       and target_session.id = p_target_session_id
       and target_session.created_at =
         p_target_session_created_at
  ) into v_matches;
  return v_matches;
end;
$$;

revoke all on function
  public.bp_0093_oauth_target_generation_matches(
    uuid, uuid, uuid, timestamptz, uuid, timestamptz
  )
  from public, anon, authenticated, service_role;

-- Expand-only legacy compatibility. Both the old two-argument RPC and the
-- new session/TTL-bound bridge cross this private guard. It captures the
-- exact Auth generation, shares the 0084 source/target claim and user locks,
-- enforces one permanent source and target winner, and arms durable cleanup
-- in the same transaction as the ownership receipt.
create or replace function public.bp_0093_legacy_migration_skip(
  p_reason text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz;
begin
  if p_reason is null
     or p_reason not in (
       'target_already_member',
       'target_already_claimed',
       'source_already_claimed',
       'source_not_anonymous',
       'source_generation_changed',
       'source_is_member',
       'unexpected_source_data',
       'source_already_absent'
     )
     or ((p_issued_at is null) <> (p_expires_at is null)) then
    raise exception 'invalid_legacy_signup_migration_skip'
      using errcode = 'P0001';
  end if;
  if p_issued_at is not null then
    v_now := pg_catalog.clock_timestamp();
    if p_issued_at > v_now + interval '5 seconds'
       or p_expires_at < v_now then
      raise exception 'legacy_signup_migration_expired'
        using errcode = 'P0001';
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'skipped', p_reason
  );
end;
$$;

revoke all on function public.bp_0093_legacy_migration_skip(
  text, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.bp_0093_reassign_legacy_anon_data(
  p_old uuid,
  p_new uuid,
  p_issued_at timestamptz,
  p_expires_at timestamptz,
  p_allow_no_transfer boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_receipt public.anon_data_reassignments%rowtype;
  v_target_receipt public.anon_data_reassignments%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_target_auth_is_anonymous boolean;
  v_source_auth_present boolean;
  v_target_auth_present boolean;
  v_receipt_present boolean;
  v_target_receipt_present boolean;
  v_result jsonb;
begin
  if p_old is null
     or p_new is null
     or p_old = p_new
     or p_allow_no_transfer is null
     or ((p_issued_at is null) <> (p_expires_at is null))
     or (
       p_issued_at is not null
       and p_expires_at <>
         p_issued_at + interval '15 minutes'
     ) then
    raise exception 'invalid_args' using errcode = 'P0001';
  end if;

  -- Cleanup workers lock job -> Auth -> source advisory. Lock every existing
  -- source job first so a legacy replay cannot invert that order.
  perform 1
    from public.oauth_anon_auth_cleanup_jobs as cleanup
   where cleanup.source_user_id = p_old
   order by cleanup.cleanup_id
   for update of cleanup;

  -- Global user lifecycle paths take the 0084 ownership/member advisory
  -- namespaces before Auth rows. Preserve that order after the durable job so
  -- account deletion/reactivation cannot hold the advisory while this path
  -- holds Auth and waits in the opposite direction.
  perform public.bp_0084_anon_reassign_locks(p_old, p_new);
  perform public.bp_user_mutation_lock_many(array[p_old, p_new]);

  perform 1
    from auth.users as auth_user
   where auth_user.id in (p_old, p_new)
   order by auth_user.id
   for update of auth_user;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' || p_old::text,
      0
    )
  );
  perform 1
    from public.profiles as profile
   where profile.id in (p_old, p_new)
   order by profile.id
   for key share of profile;

  select *
    into v_receipt
    from public.anon_data_reassignments as receipt
   where receipt.source_user_id = p_old
   for update;
  v_receipt_present := found;

  select *
    into v_target_receipt
    from public.anon_data_reassignments as receipt
   where receipt.target_user_id = p_new
   for update;
  v_target_receipt_present := found;

  if v_receipt_present
     and v_receipt.target_user_id is distinct from p_new then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'source_already_claimed',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'anon_reassignment_conflict'
      using errcode = 'P0001';
  end if;
  if v_target_receipt_present
     and v_target_receipt.source_user_id is distinct from p_old then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'target_already_claimed',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'anon_reassignment_target_conflict'
      using errcode = 'P0001';
  end if;
  if v_receipt_present is distinct from v_target_receipt_present then
    raise exception 'anon_reassignment_receipt_invariant'
      using errcode = 'P0001';
  end if;

  -- The ownership receipt is the terminal result. Replay it before consulting
  -- any newer live flow authority so ACK loss followed by a fresh login flow
  -- cannot hide a committed transfer. Both receipt sides permanently fence
  -- principal UUID reuse.
  if v_receipt_present then
    return v_receipt.result;
  end if;

  -- A new ledger flow always has stronger authority. Old in-flight callers
  -- fail closed instead of racing or downgrading any source/target flow.
  if exists (
    select 1
      from public.oauth_flow_intents as flow
     where (
         flow.session_fenced
         or (
           flow.state = 'completed'
           and flow.action = 'continue'
           and flow.source_is_anonymous
           and flow.revoke_confirmed_at is null
           and flow.released_at is not null
           and flow.migration_consumed_at is null
         )
       )
       and (
         flow.source_user_id = p_old
         or flow.target_user_id = p_new
       )
  ) then
    raise exception 'legacy_anon_migration_flow_authority_exists'
      using errcode = 'P0001';
  end if;

  select source_user.created_at,
         source_user.instance_id,
         source_user.is_anonymous
    into v_source_auth_created_at,
         v_source_auth_instance_id,
         v_source_auth_is_anonymous
    from auth.users as source_user
   where source_user.id = p_old
   for update of source_user;
  v_source_auth_present := found;

  select target_user.is_anonymous
    into v_target_auth_is_anonymous
    from auth.users as target_user
   where target_user.id = p_new
   for update of target_user;
  v_target_auth_present := found;

  if not v_target_auth_present
     or v_target_auth_is_anonymous is not false then
    raise exception 'legacy_anon_migration_target_authority_unverified'
      using errcode = 'P0001';
  end if;

  if p_issued_at is not null then
    v_now := pg_catalog.clock_timestamp();
    if p_issued_at > v_now + interval '5 seconds'
       or p_expires_at < v_now then
      raise exception 'legacy_signup_migration_expired'
        using errcode = 'P0001';
    end if;
  end if;

  if v_source_auth_present
     and v_source_auth_is_anonymous is not true then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'source_not_anonymous',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'legacy_anon_migration_source_authority_unverified'
      using errcode = 'P0001';
  end if;
  if v_source_auth_present
     and v_source_auth_created_at is null then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'source_generation_changed',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'legacy_anon_migration_source_generation_changed'
      using errcode = 'P0001';
  end if;

  v_now := pg_catalog.clock_timestamp();
  if (
    v_source_auth_present
    and v_source_auth_created_at > v_now
  )
     or (
       v_source_auth_present
       and p_issued_at is not null
       and v_source_auth_created_at >
         p_issued_at + interval '5 seconds'
     ) then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'source_generation_changed',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'legacy_anon_migration_source_generation_changed'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.member_accounts as source_member
     where source_member.user_id = p_old
  ) then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'source_is_member',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'legacy_anon_migration_source_is_member'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.member_accounts as target_member
     where target_member.user_id = p_new
  ) then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'target_already_member',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'legacy_anon_migration_target_is_member'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.dolls where owner_id = p_old
  )
  or exists (
    select 1 from public.orders where user_id = p_old
  )
  or exists (
    select 1
      from public.ai_generations
     where owner_id = p_old
  ) then
    if p_allow_no_transfer then
      return public.bp_0093_legacy_migration_skip(
        'unexpected_source_data',
        p_issued_at,
        p_expires_at
      );
    end if;
    raise exception 'legacy_anon_migration_unexpected_source_data'
      using errcode = 'P0001';
  end if;

  -- The 0084 implementation can otherwise wait inside one of its three data
  -- updates after the final database-clock TTL check. Lock its complete write
  -- set in implementation order first. Supported writers already own the
  -- same member advisory, and these row locks cover an already-started direct
  -- writer.
  perform 1
    from public.scores as score
   where score.owner_id = p_old
   order by score.id
   for update of score;
  perform 1
    from public.user_badges as badge
   where badge.owner_id in (p_old, p_new)
   order by badge.owner_id, badge.badge_id
   for update of badge;
  perform 1
    from public.telemetry_sessions as telemetry
   where telemetry.owner_id = p_old
      or (
        telemetry.owner_id is null
        and telemetry.is_anon = true
        and telemetry.submitter_binding =
          public.bp_telemetry_submitter_binding(
            telemetry.id,
            p_old
          )
      )
   order by telemetry.id
   for update of telemetry;

  if p_issued_at is not null then
    v_now := pg_catalog.clock_timestamp();
    if p_issued_at > v_now + interval '5 seconds'
       or p_expires_at < v_now then
      raise exception 'legacy_signup_migration_expired'
        using errcode = 'P0001';
    end if;
  end if;

  v_result := public.bp_0084_reassign_anon_data_impl(p_old, p_new);
  if v_result is null
     or pg_catalog.jsonb_typeof(v_result) <> 'object'
     or v_result ?& array[
       'ok',
       'scores',
       'badges',
       'telemetry'
     ] is not true
     or v_result - array[
       'ok',
       'scores',
       'badges',
       'telemetry'
     ] <> '{}'::jsonb
     or v_result->'ok' is distinct from 'true'::jsonb
     or pg_catalog.jsonb_typeof(v_result->'scores') <> 'number'
     or pg_catalog.jsonb_typeof(v_result->'badges') <> 'number'
     or pg_catalog.jsonb_typeof(v_result->'telemetry') <> 'number'
     or v_result->>'scores' !~ '^(0|[1-9][0-9]{0,9})$'
     or v_result->>'badges' !~ '^(0|[1-9][0-9]{0,9})$'
     or v_result->>'telemetry' !~ '^(0|[1-9][0-9]{0,9})$'
     or (
       pg_catalog.length(v_result->>'scores') = 10
       and v_result->>'scores' > '2147483647'
     )
     or (
       pg_catalog.length(v_result->>'badges') = 10
       and v_result->>'badges' > '2147483647'
     )
     or (
       pg_catalog.length(v_result->>'telemetry') = 10
       and v_result->>'telemetry' > '2147483647'
     ) then
    raise exception 'legacy_anon_migration_result_invalid'
      using errcode = 'P0001';
  end if;

  if v_source_auth_present then
    v_now := pg_catalog.clock_timestamp();
    insert into public.oauth_anon_auth_cleanup_jobs (
      legacy_source_user_id,
      source_user_id,
      source_auth_created_at,
      source_auth_instance_id,
      status,
      next_attempt_at,
      created_at,
      armed_at
    )
    values (
      p_old,
      p_old,
      v_source_auth_created_at,
      v_source_auth_instance_id,
      'pending',
      v_now,
      greatest(v_now, v_source_auth_created_at),
      greatest(v_now, v_source_auth_created_at)
    );
    return v_result;
  end if;

  return v_result;
end;
$$;

revoke all on function public.bp_0093_reassign_legacy_anon_data(
  uuid, uuid, timestamptz, timestamptz, boolean
) from public, anon, authenticated, service_role;

create or replace function public.reassign_anon_data(
  p_old uuid,
  p_new uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.bp_0093_reassign_legacy_anon_data(
    p_old,
    p_new,
    null,
    null,
    false
  );
end;
$$;

revoke all on function public.reassign_anon_data(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reassign_anon_data(uuid, uuid)
  to service_role;

create or replace function public.consume_legacy_signup_migration(
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_receipt public.legacy_signup_migration_receipts%rowtype;
  v_result jsonb;
begin
  if p_source_user_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_source_user_id = p_target_user_id
     or p_issued_at is null
     or p_expires_at is null
     or p_expires_at <>
       p_issued_at + interval '15 minutes' then
    raise exception 'invalid_legacy_signup_migration'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legacy-signup-migration:' ||
      p_source_user_id::text || ':' ||
      p_expires_at::text,
      0
    )
  );

  -- A committed receipt is the terminal authority. Return it before any live
  -- Auth/session check: the transfer may have committed, its HTTP ACK may have
  -- been lost, and the target session may then have been remotely revoked.
  -- Both principals and the target session ID are permanent tombstones, so
  -- replaying this exact tuple cannot acknowledge a later generation.
  select *
    into v_receipt
    from public.legacy_signup_migration_receipts as receipt
   where receipt.source_user_id = p_source_user_id
     and receipt.expires_at = p_expires_at
   for update;
  if found then
    if v_receipt.issued_at is distinct from p_issued_at
       or v_receipt.target_user_id
         is distinct from p_target_user_id
       or v_receipt.target_session_id
         is distinct from p_target_session_id then
      raise exception 'legacy_signup_migration_receipt_conflict'
        using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'sourceUserId', v_receipt.source_user_id,
      'targetUserId', v_receipt.target_user_id,
      'targetSessionId', v_receipt.target_session_id,
      'alreadyConsumed', true,
      'consumedAt', v_receipt.consumed_at,
      'migrationResult', v_receipt.migration_result
    );
  end if;

  -- Cleanup workers use job -> Auth -> source-advisory. Pre-lock every
  -- existing source job before the complete sorted Auth user set so a legacy
  -- first-consume cannot hold Auth while a worker holds the job.
  perform 1
    from public.oauth_anon_auth_cleanup_jobs as cleanup
   where cleanup.source_user_id = p_source_user_id
   order by cleanup.cleanup_id
   for update of cleanup;

  perform public.bp_0084_anon_reassign_locks(
    p_source_user_id,
    p_target_user_id
  );
  perform public.bp_user_mutation_lock_many(
    array[p_source_user_id, p_target_user_id]
  );

  -- Auth deletion locks auth.users before its session cascade. After the job
  -- and canonical user-advisory prefixes, take the complete sorted user set,
  -- then the target session and its observed-session fence.
  perform 1
    from auth.users as auth_user
   where auth_user.id in (
     p_source_user_id,
     p_target_user_id
   )
   order by auth_user.id
   for update of auth_user;
  perform 1
    from auth.sessions as target_session
   where target_session.id = p_target_session_id
   for update of target_session;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' ||
      p_target_session_id::text,
      0
    )
  );

  perform 1
    from auth.sessions as target_session
   where target_session.id = p_target_session_id
     and target_session.user_id = p_target_user_id
   for update of target_session;
  if not found then
    raise exception 'legacy_signup_migration_target_session_unverified'
      using errcode = 'P0001';
  end if;

  -- This is the exact candidate predicate used by observed-session recovery.
  -- Holding the observed-session lock makes absence stable through transfer.
  if exists (
    select 1
      from public.oauth_flow_intents as flow
     where (
         flow.session_fenced
         or (
           flow.state = 'completed'
           and flow.action = 'continue'
           and flow.source_is_anonymous
           and flow.revoke_confirmed_at is null
           and flow.released_at is not null
           and flow.migration_consumed_at is null
         )
       )
       and (
         (
           flow.source_user_id = p_target_user_id
           and flow.source_session_id = p_target_session_id
         )
         or (
           flow.target_user_id = p_target_user_id
           and flow.target_session_id = p_target_session_id
         )
       )
  ) then
    raise exception 'legacy_signup_migration_flow_authority_exists'
      using errcode = 'P0001';
  end if;

  -- The private guard repeats the database-clock check after every cleanup,
  -- Auth, ownership, user, and profile lock. This early check only avoids work
  -- for a capability already expired before the guarded phase.
  v_now := pg_catalog.clock_timestamp();
  if p_issued_at > v_now + interval '5 seconds'
     or p_expires_at < v_now then
    raise exception 'legacy_signup_migration_expired'
      using errcode = 'P0001';
  end if;

  v_result := public.bp_0093_reassign_legacy_anon_data(
    p_source_user_id,
    p_target_user_id,
    p_issued_at,
    p_expires_at,
    true
  );

  insert into public.legacy_signup_migration_receipts (
    source_user_id,
    expires_at,
    issued_at,
    target_user_id,
    target_session_id,
    consumed_at,
    migration_result
  )
  values (
    p_source_user_id,
    p_expires_at,
    p_issued_at,
    p_target_user_id,
    p_target_session_id,
    least(
      p_expires_at,
      greatest(
        pg_catalog.clock_timestamp(),
        p_issued_at
      )
    ),
    v_result
  )
  returning * into v_receipt;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'sourceUserId', v_receipt.source_user_id,
    'targetUserId', v_receipt.target_user_id,
    'targetSessionId', v_receipt.target_session_id,
    'alreadyConsumed', false,
    'consumedAt', v_receipt.consumed_at,
    'migrationResult', v_receipt.migration_result
  );
end;
$$;

revoke all on function public.consume_legacy_signup_migration(
  uuid, uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.consume_legacy_signup_migration(
  uuid, uuid, uuid, timestamptz, timestamptz
) to service_role;

create or replace function public.begin_oauth_flow_intent(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_source_is_anonymous boolean,
  p_provider text,
  p_requested_next text,
  p_source_access_token_sha256 text,
  p_source_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_expires_at timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_source_is_anonymous is null
     or p_source_access_token_sha256 is null
     or p_source_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_source_refresh_token_sha256 is null
     or p_source_refresh_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_provider is null
     or p_provider not in ('google', 'kakao')
     or p_requested_next is null
     or pg_catalog.length(p_requested_next) not between 1 and 2048
     or pg_catalog.left(p_requested_next, 1) <> '/'
     or pg_catalog.left(p_requested_next, 2) = '//'
     or pg_catalog.strpos(
       p_requested_next,
       pg_catalog.chr(92)
     ) <> 0
     or p_requested_next ~ '[[:cntrl:]]' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' ||
      p_source_session_id::text,
      0
    )
  );

  if p_source_is_anonymous then
    -- UPDATE row triggers already own the Auth tuple before they take the
    -- source advisory lock. Lock an existing tuple first so begin follows the
    -- same order and cannot deadlock with a concurrent promotion/rewrite.
    perform 1
      from auth.users as source_user
     where source_user.id = p_source_user_id
     for share of source_user;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-anon-auth-cleanup:' ||
        p_source_user_id::text,
        0
      )
    );

    if exists (
      select 1
        from public.oauth_anon_auth_cleanup_jobs as cleanup
       where cleanup.source_user_id = p_source_user_id
         and cleanup.status <> 'completed'
         and cleanup.flow_id is distinct from p_flow_id
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_source_authority_unverified'
      );
    end if;

    -- The first read cannot lock an absent UUID. Re-read while holding the
    -- advisory fence so an INSERT either committed before us and is observed,
    -- or waits until the dormant generation receipt has committed.
    select source_user.created_at,
           source_user.instance_id
      into v_source_auth_created_at,
           v_source_auth_instance_id
      from auth.users as source_user
     where source_user.id = p_source_user_id
       and source_user.is_anonymous is true
     for share of source_user;

    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_source_authority_unverified'
      );
    end if;
  end if;

  -- Take the lease timestamp only after every potentially blocking lock.
  v_now := pg_catalog.clock_timestamp();
  v_expires_at := v_now + interval '10 minutes';

  if p_source_is_anonymous
     and (
       v_source_auth_created_at is null
       or v_source_auth_created_at > v_now
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_source_authority_unverified'
    );
  end if;

  update public.oauth_flow_intents
     set state = 'expired',
         finished_at = v_now
   where source_session_id = p_source_session_id
     and state = 'pending'
     and expires_at <= v_now;
  update public.oauth_anon_auth_cleanup_jobs as cleanup
     set status = 'completed',
         armed_at = greatest(v_now, cleanup.created_at),
         finished_at = greatest(v_now, cleanup.created_at),
         next_attempt_at = null,
         last_error = null
   where cleanup.status = 'dormant'
     and cleanup.flow_id in (
       select flow.flow_id
         from public.oauth_flow_intents as flow
        where flow.source_session_id = p_source_session_id
          and flow.state = 'expired'
          and flow.target_user_id is null
          and flow.migration_consumed_at is null
     );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if found then
    if v_row.source_user_id = p_source_user_id
       and v_row.source_session_id = p_source_session_id
       and v_row.source_access_token_sha256 =
         p_source_access_token_sha256
       and v_row.source_refresh_token_sha256 =
         p_source_refresh_token_sha256
       and v_row.source_is_anonymous = p_source_is_anonymous
       and v_row.provider = p_provider
       and v_row.requested_next = p_requested_next
       and v_row.state = 'pending'
       and v_row.expires_at > v_now
       and (
         not p_source_is_anonymous
         or exists (
           select 1
             from public.oauth_anon_auth_cleanup_jobs as cleanup
            where cleanup.flow_id = p_flow_id
              and cleanup.source_user_id = p_source_user_id
              and cleanup.source_auth_created_at =
                v_source_auth_created_at
              and cleanup.source_auth_instance_id
                is not distinct from
                  v_source_auth_instance_id
              and cleanup.status = 'dormant'
         )
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'flowId', v_row.flow_id,
        'expiresAt', v_row.expires_at
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_conflict'
    );
  end if;

  if exists (
    select 1
      from public.oauth_flow_intents
     where flow_id <> p_flow_id
       and (
         (
           session_fenced
           and (
             source_session_id = p_source_session_id
             or target_session_id = p_source_session_id
           )
         )
         or (
           target_session_id = p_source_session_id
           and revoke_confirmed_at is not null
         )
       )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_already_active'
    );
  end if;

  begin
    insert into public.oauth_flow_intents (
      flow_id,
      source_user_id,
      source_session_id,
      source_access_token_sha256,
      source_refresh_token_sha256,
      source_is_anonymous,
      provider,
      requested_next,
      state,
      created_at,
      expires_at
    )
    values (
      p_flow_id,
      p_source_user_id,
      p_source_session_id,
      p_source_access_token_sha256,
      p_source_refresh_token_sha256,
      p_source_is_anonymous,
      p_provider,
      p_requested_next,
      'pending',
      v_now,
      v_expires_at
    );
  exception
    when unique_violation then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_conflict'
      );
  end;

  if p_source_is_anonymous then
    insert into public.oauth_anon_auth_cleanup_jobs (
      cleanup_id,
      flow_id,
      source_user_id,
      source_auth_created_at,
      source_auth_instance_id,
      status,
      created_at,
      recover_until
    )
    values (
      p_flow_id,
      p_flow_id,
      p_source_user_id,
      v_source_auth_created_at,
      v_source_auth_instance_id,
      'dormant',
      v_now,
      v_expires_at + interval '30 days 5 seconds'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', p_flow_id,
    'expiresAt', v_expires_at
  );
end;
$$;

create or replace function public.claim_oauth_flow_intent(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text,
  p_source_access_token_sha256 text,
  p_source_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao')
     or p_source_access_token_sha256 is null
     or p_source_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_source_refresh_token_sha256 is null
     or p_source_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
     and source_access_token_sha256 =
       p_source_access_token_sha256
     and source_refresh_token_sha256 =
       p_source_refresh_token_sha256
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_claimable'
    );
  end if;

  -- Do not let lock wait time extend the ten-minute pending lease.
  v_now := pg_catalog.clock_timestamp();

  if v_row.state = 'claimed'
     and v_row.target_session_id is null
     and v_row.expires_at <= v_now then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    v_now := pg_catalog.clock_timestamp();
    if v_row.expires_at <= v_now then
      update public.oauth_flow_intents
         set state = 'expired',
             finished_at = greatest(v_now, v_row.expires_at)
       where flow_id = p_flow_id
         and state = 'claimed'
         and target_session_id is null;
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_not_claimable'
      );
    end if;
  end if;

  if v_row.state = 'claimed' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id
    );
  end if;

  if v_row.state = 'pending'
     and v_row.expires_at <= v_now then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    update public.oauth_flow_intents
       set state = 'expired',
           finished_at = greatest(v_now, v_row.expires_at)
     where flow_id = p_flow_id;
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           next_attempt_at = null,
           last_error = null
     where flow_id = p_flow_id
       and status = 'dormant';
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_claimable'
    );
  end if;

  if v_row.state <> 'pending'
     or v_row.expires_at <= v_now then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_claimable'
    );
  end if;

  update public.oauth_flow_intents
     set state = 'claimed',
         claimed_at = greatest(
           v_now,
           v_row.created_at
         )
   where flow_id = p_flow_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', p_flow_id
  );
end;
$$;

create or replace function public.bind_oauth_flow_intent_target(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_access_token_sha256 text,
  p_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_target_auth_created_at timestamptz;
  v_target_auth_instance_id uuid;
  v_target_auth_is_anonymous boolean;
  v_target_session_created_at timestamptz;
  v_target_generation_present boolean;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao')
     or p_target_user_id is null
     or p_target_session_id is null
     or p_access_token_sha256 is null
     or p_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_refresh_token_sha256 is null
     or p_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_target_binding'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found or v_row.state <> 'claimed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_not_bindable'
    );
  end if;

  -- A preflight claim has the same ten-minute lease as its pending parent.
  -- If the browser process dies before the PKCE response can be durably bound,
  -- the unknown remote Auth session cannot be identified safely; expire only
  -- the unbound ledger/source fence at the exact deadline.
  v_now := pg_catalog.clock_timestamp();
  if v_row.target_session_id is null
     and v_row.expires_at <= v_now then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    v_now := pg_catalog.clock_timestamp();
    if v_row.expires_at <= v_now then
      update public.oauth_flow_intents
         set state = 'expired',
             finished_at = greatest(v_now, v_row.expires_at)
       where flow_id = p_flow_id
         and state = 'claimed'
         and target_session_id is null;
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_target_not_bindable'
      );
    end if;
  end if;

  -- Match Auth deletion's user -> session cascade order. UUID-sorted user
  -- locks also serialize this bind with source generation fencing.
  perform 1
    from auth.users as auth_user
   where auth_user.id in (
     v_row.source_user_id,
     p_target_user_id
   )
   order by auth_user.id
   for share of auth_user;
  perform 1
    from auth.sessions as target_session
   where target_session.id = p_target_session_id
   for update of target_session;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' ||
      p_target_session_id::text,
      0
    )
  );

  if p_target_session_id = v_row.source_session_id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_source_session_unchanged'
    );
  end if;

  if v_row.source_is_anonymous
     and p_target_user_id = v_row.source_user_id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_anonymous_user_unchanged'
    );
  end if;

  if exists (
    select 1
      from public.oauth_flow_intents
     where flow_id <> p_flow_id
       and (
         (
           session_fenced
           and (
             source_session_id = p_target_session_id
             or target_session_id = p_target_session_id
           )
         )
         or (
           target_session_id = p_target_session_id
           and revoke_confirmed_at is not null
         )
       )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_session_already_active'
    );
  end if;

  -- Re-read the exact Auth user and session generation after every lock. The
  -- callback transport already verified the raw token; this durable tuple
  -- evidence prevents a later same-UUID generation from inheriting it.
  select target_user.created_at,
         target_user.instance_id,
         target_user.is_anonymous,
         target_session.created_at
    into v_target_auth_created_at,
         v_target_auth_instance_id,
         v_target_auth_is_anonymous,
         v_target_session_created_at
    from auth.users as target_user
    join auth.sessions as target_session
      on target_session.user_id = target_user.id
   where target_user.id = p_target_user_id
     and target_session.id = p_target_session_id
   for share of target_user, target_session;
  v_target_generation_present := found;

  if not v_target_generation_present
     or v_target_auth_is_anonymous is not false
     or v_target_auth_created_at is null
     or v_target_session_created_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_authority_unverified'
    );
  end if;

  if v_row.target_user_id is not null then
    if v_row.target_user_id is distinct from p_target_user_id
       or v_row.target_session_id is distinct from p_target_session_id
       or v_row.target_auth_created_at is distinct from
         v_target_auth_created_at
       or v_row.target_auth_instance_id is distinct from
         v_target_auth_instance_id
       or v_row.target_session_created_at is distinct from
         v_target_session_created_at
       or v_row.target_access_token_sha256
         is distinct from p_access_token_sha256
       or v_row.target_refresh_token_sha256
         is distinct from p_refresh_token_sha256 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_target_binding_conflict'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'targetUserId', v_row.target_user_id,
      'targetSessionId', v_row.target_session_id
    );
  end if;

  update public.oauth_flow_intents
     set target_user_id = p_target_user_id,
         target_session_id = p_target_session_id,
         target_auth_created_at = v_target_auth_created_at,
         target_auth_instance_id = v_target_auth_instance_id,
         target_session_created_at =
           v_target_session_created_at,
         target_access_token_sha256 = p_access_token_sha256,
         target_refresh_token_sha256 = p_refresh_token_sha256
   where flow_id = p_flow_id
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', v_row.target_session_id
  );
end;
$$;

create or replace function public.read_oauth_flow_intent_status(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_found'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'provider', v_row.provider,
    'sourceIsAnonymous', v_row.source_is_anonymous,
    'requestedNext', v_row.requested_next,
    'state', v_row.state,
    'active', v_row.active,
    'outcome', case
      when v_row.state in (
        'completed',
        'failed',
        'cancelled',
        'abandoned',
        'expired'
      ) then v_row.state
      else null
    end,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', v_row.target_session_id,
    'destination', v_row.destination,
    'action', v_row.action,
    'createdAt', v_row.created_at,
    'expiresAt', v_row.expires_at,
    'claimedAt', v_row.claimed_at,
    'revokeConfirmedAt', v_row.revoke_confirmed_at,
    'finishedAt', v_row.finished_at,
    'releasedAt', v_row.released_at,
    'migrationConsumedAt', v_row.migration_consumed_at
  );
end;
$$;

create or replace function public.recover_oauth_flow_intent_authority(
  p_flow_id uuid,
  p_observed_user_id uuid,
  p_observed_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_observed_absent boolean;
  v_terminal_receipt_recovery boolean := false;
  v_current_target_recovery boolean := false;
  v_observed_session_created_at timestamptz;
  v_target_profile_deleted boolean;
  v_target_profile_present boolean := false;
begin
  if p_flow_id is null
     or (
       (p_observed_user_id is null) <>
       (p_observed_session_id is null)
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_authority_recovery'
    );
  end if;

  v_observed_absent :=
    p_observed_user_id is null
    and p_observed_session_id is null;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', p_flow_id,
      'state', 'absent',
      'active', false
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_authority_not_recoverable'
    );
  end if;

  if v_row.state = 'pending'
     or (
       v_row.state = 'claimed'
       and v_row.target_session_id is null
     ) then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    -- Recompute after every blocking lock so lock wait never extends a lease.
    v_now := pg_catalog.clock_timestamp();
    if v_row.expires_at <= v_now then
      update public.oauth_flow_intents
         set state = 'expired',
             finished_at = greatest(
               v_now,
               v_row.expires_at
             )
       where flow_id = p_flow_id
         and (
           state = 'pending'
           or (
             state = 'claimed'
             and target_session_id is null
           )
         )
      returning * into v_row;
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
  end if;

  if v_observed_absent then
    if not (
      v_row.state = 'signout_revoked'
      or (
        not v_row.session_fenced
        and v_row.state in (
          'completed',
          'failed',
          'cancelled',
          'abandoned',
          'expired'
        )
      )
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_authority_not_recoverable'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'state', v_row.state,
      'active', v_row.active
    );
  end if;

  -- A current session for the same immutable target principal generation may
  -- recover a released flow even after normal refresh-token rotation. A
  -- committed receipt remains terminal authority, but the caller still has
  -- to prove a live current session rather than merely knowing the user UUID.
  if v_row.state = 'completed'
     and v_row.action = 'continue'
     and v_row.source_is_anonymous
     and v_row.revoke_confirmed_at is null
     and v_row.released_at is not null
     and v_row.target_user_id = p_observed_user_id then
    if v_row.migration_consumed_at is null then
      select *
        into v_cleanup
        from public.oauth_anon_auth_cleanup_jobs
       where flow_id = v_row.flow_id
         and source_user_id = v_row.source_user_id
       for update;
    end if;
    if v_row.migration_consumed_at is not null
       or (
         found
         and v_cleanup.status in ('dormant', 'quarantined')
         and (
           v_cleanup.status = 'dormant'
           or v_cleanup.quarantine_reason =
             'target_session_missing'
         )
       ) then
      perform public.bp_0084_anon_reassign_locks(
        v_row.source_user_id,
        v_row.target_user_id
      );
      perform public.bp_user_mutation_lock_many(
        array[v_row.source_user_id, v_row.target_user_id]
      );
      select target_session.created_at
        into v_observed_session_created_at
        from auth.sessions as target_session
       where target_session.id = p_observed_session_id
         and target_session.user_id = p_observed_user_id;
      if found
         and public.bp_0093_oauth_target_generation_matches(
           v_row.source_user_id,
           v_row.target_user_id,
           p_observed_session_id,
           v_row.target_auth_created_at,
           v_row.target_auth_instance_id,
           v_observed_session_created_at
         ) then
        select target_profile.deleted_at is not null
          into v_target_profile_deleted
          from public.profiles as target_profile
         where target_profile.id = v_row.target_user_id
         for update of target_profile;
        v_target_profile_present := found;
        v_now := pg_catalog.clock_timestamp();
        if v_target_profile_present
           and not coalesce(v_target_profile_deleted, true)
           and (
             v_row.migration_consumed_at is not null
             or (
               v_cleanup.recover_until is not null
               and v_now <= v_cleanup.recover_until
             )
           ) then
          if v_row.migration_consumed_at is not null then
            v_terminal_receipt_recovery := true;
          else
            v_current_target_recovery := true;
          end if;
        end if;
      end if;
    end if;
  end if;

  if not (
    v_terminal_receipt_recovery
    or v_current_target_recovery
    or
    (
      v_row.source_user_id = p_observed_user_id
      and v_row.source_session_id = p_observed_session_id
    )
    or (
      v_row.target_user_id is not null
      and v_row.target_session_id is not null
      and v_row.target_user_id = p_observed_user_id
      and v_row.target_session_id = p_observed_session_id
    )
  ) then
    if not v_row.session_fenced
       and v_row.state in (
         'completed',
         'failed',
         'cancelled',
         'abandoned',
         'expired'
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'flowId', v_row.flow_id,
        'state', v_row.state,
        'active', false
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_authority_not_recoverable'
    );
  end if;

  if v_row.target_user_id = p_observed_user_id
     and v_row.target_session_id = p_observed_session_id
     and not v_terminal_receipt_recovery
     and not v_current_target_recovery
     and not public.bp_0093_oauth_target_generation_matches(
       v_row.source_user_id,
       v_row.target_user_id,
       v_row.target_session_id,
       v_row.target_auth_created_at,
       v_row.target_auth_instance_id,
       v_row.target_session_created_at
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'provider', v_row.provider,
    'sourceUserId', v_row.source_user_id,
    'sourceSessionId', v_row.source_session_id,
    'sourceIsAnonymous', v_row.source_is_anonymous,
    'requestedNext', v_row.requested_next,
    'state', v_row.state,
    'active', v_row.active,
    'outcome', case
      when v_row.state in (
        'completed',
        'failed',
        'cancelled',
        'abandoned',
        'expired'
      ) then v_row.state
      else null
    end,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', case
      when v_current_target_recovery
        then p_observed_session_id
      else v_row.target_session_id
    end,
    'destination', v_row.destination,
    'action', v_row.action,
    'createdAt', v_row.created_at,
    'expiresAt', v_row.expires_at,
    'claimedAt', v_row.claimed_at,
    'revokeConfirmedAt', v_row.revoke_confirmed_at,
    'finishedAt', v_row.finished_at,
    'releasedAt', v_row.released_at,
    'migrationConsumedAt', v_row.migration_consumed_at
  );
end;
$$;

create or replace function public.recover_active_oauth_flow_by_observed_session(
  p_observed_user_id uuid,
  p_observed_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exact_flow_ids uuid[];
  v_principal_flow_ids uuid[];
  v_final_exact_flow_ids uuid[];
  v_final_principal_flow_ids uuid[];
  v_flow_id uuid;
  v_mode text;
  v_result jsonb;
begin
  if p_observed_user_id is null
     or p_observed_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_observed_session_recovery'
    );
  end if;

  -- Exact source/target session tuples are the strongest authority and always
  -- win over the weaker same-principal rotation fallback.
  select pg_catalog.array_agg(flow_id order by flow_id)
    into v_exact_flow_ids
    from (
      select flow_id
        from public.oauth_flow_intents
       where (
           session_fenced
           or (
             state = 'completed'
             and action = 'continue'
             and source_is_anonymous
             and revoke_confirmed_at is null
             and released_at is not null
             and migration_consumed_at is null
           )
         )
         and (
           (
             source_user_id = p_observed_user_id
             and source_session_id = p_observed_session_id
           )
           or (
             target_user_id = p_observed_user_id
             and target_session_id = p_observed_session_id
           )
         )
       order by flow_id
       limit 2
    ) candidates;

  if coalesce(
       pg_catalog.array_length(v_exact_flow_ids, 1),
       0
     ) > 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_observed_session_ambiguous'
    );
  end if;

  if pg_catalog.array_length(v_exact_flow_ids, 1) = 1 then
    v_mode := 'exact';
    v_flow_id := v_exact_flow_ids[1];
  else
    -- A rotated current target session may discover one released/unconsumed
    -- flow for the same immutable non-anonymous Auth principal generation.
    -- This fallback is intentionally unavailable for target-member/claimed
    -- quarantines and after the signed recovery deadline.
    select pg_catalog.array_agg(flow_id order by flow_id)
      into v_principal_flow_ids
      from (
        select flow.flow_id
          from public.oauth_flow_intents as flow
          join public.oauth_anon_auth_cleanup_jobs as cleanup
            on cleanup.flow_id = flow.flow_id
           and cleanup.source_user_id = flow.source_user_id
          join public.profiles as target_profile
            on target_profile.id = flow.target_user_id
           and target_profile.deleted_at is null
          join auth.users as target_user
            on target_user.id = flow.target_user_id
           and target_user.is_anonymous is false
           and target_user.created_at =
             flow.target_auth_created_at
           and target_user.instance_id is not distinct from
             flow.target_auth_instance_id
          join auth.sessions as observed_session
            on observed_session.id = p_observed_session_id
           and observed_session.user_id = p_observed_user_id
         where flow.state = 'completed'
           and flow.action = 'continue'
           and flow.source_is_anonymous
           and flow.revoke_confirmed_at is null
           and flow.released_at is not null
           and flow.migration_consumed_at is null
           and flow.target_user_id = p_observed_user_id
           and cleanup.status in ('dormant', 'quarantined')
           and (
             cleanup.status = 'dormant'
             or cleanup.quarantine_reason =
               'target_session_missing'
           )
           and cleanup.recover_until is not null
           and pg_catalog.clock_timestamp() <=
             cleanup.recover_until
         order by flow.flow_id
         limit 2
      ) candidates;

    if v_principal_flow_ids is null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'state', 'absent',
        'active', false
      );
    end if;
    if pg_catalog.array_length(v_principal_flow_ids, 1) > 1 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_observed_session_ambiguous'
      );
    end if;
    v_mode := 'principal';
    v_flow_id := v_principal_flow_ids[1];
  end if;

  -- The authority helper owns the canonical flow -> source -> cleanup/users/
  -- session -> observed-session lock order and repeats all generation,
  -- profile, status, and exact-deadline checks after the locks.
  v_result := public.recover_oauth_flow_intent_authority(
    v_flow_id,
    p_observed_user_id,
    p_observed_session_id
  );
  if v_result is null
     or pg_catalog.jsonb_typeof(v_result) <> 'object'
     or v_result->'ok' is null then
    raise exception 'oauth_flow_authority_recovery_result_invalid'
      using errcode = 'P0001';
  end if;
  if v_result->'ok' is distinct from 'true'::jsonb then
    return v_result;
  end if;

  -- Re-evaluate exact candidates first while the helper's locks are held.
  select pg_catalog.array_agg(flow_id order by flow_id)
    into v_final_exact_flow_ids
    from (
      select flow_id
        from public.oauth_flow_intents
       where (
           session_fenced
           or (
             state = 'completed'
             and action = 'continue'
             and source_is_anonymous
             and revoke_confirmed_at is null
             and released_at is not null
             and migration_consumed_at is null
           )
         )
         and (
           (
             source_user_id = p_observed_user_id
             and source_session_id = p_observed_session_id
           )
           or (
             target_user_id = p_observed_user_id
             and target_session_id = p_observed_session_id
           )
         )
       order by flow_id
       limit 2
    ) candidates;

  if coalesce(
       pg_catalog.array_length(v_final_exact_flow_ids, 1),
       0
     ) > 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_observed_session_ambiguous'
    );
  end if;

  if v_mode = 'exact' then
    if pg_catalog.array_length(v_final_exact_flow_ids, 1) = 1
       and v_final_exact_flow_ids[1] = v_flow_id then
      return v_result;
    end if;
    -- The helper may atomically expire the chosen pending flow, making it no
    -- longer active/discoverable. Return that stable terminal result.
    if v_final_exact_flow_ids is null
       and v_result->'active'
         is not distinct from 'false'::jsonb then
      return v_result;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_observed_session_changed'
    );
  end if;

  -- If a stronger exact tuple appeared before the canonical observed-session
  -- lock, fail closed and let the caller retry so that exact authority wins.
  if v_final_exact_flow_ids is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_observed_session_changed'
    );
  end if;

  select pg_catalog.array_agg(flow_id order by flow_id)
    into v_final_principal_flow_ids
    from (
      select flow.flow_id
        from public.oauth_flow_intents as flow
        join public.oauth_anon_auth_cleanup_jobs as cleanup
          on cleanup.flow_id = flow.flow_id
         and cleanup.source_user_id = flow.source_user_id
        join public.profiles as target_profile
          on target_profile.id = flow.target_user_id
         and target_profile.deleted_at is null
        join auth.users as target_user
          on target_user.id = flow.target_user_id
         and target_user.is_anonymous is false
         and target_user.created_at =
           flow.target_auth_created_at
         and target_user.instance_id is not distinct from
           flow.target_auth_instance_id
        join auth.sessions as observed_session
          on observed_session.id = p_observed_session_id
         and observed_session.user_id = p_observed_user_id
       where flow.state = 'completed'
         and flow.action = 'continue'
         and flow.source_is_anonymous
         and flow.revoke_confirmed_at is null
         and flow.released_at is not null
         and flow.migration_consumed_at is null
         and flow.target_user_id = p_observed_user_id
         and cleanup.status in ('dormant', 'quarantined')
         and (
           cleanup.status = 'dormant'
           or cleanup.quarantine_reason =
             'target_session_missing'
         )
         and cleanup.recover_until is not null
         and pg_catalog.clock_timestamp() <=
           cleanup.recover_until
       order by flow.flow_id
       limit 2
    ) candidates;

  if v_final_principal_flow_ids is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_observed_session_changed'
    );
  end if;
  if pg_catalog.array_length(v_final_principal_flow_ids, 1) <> 1
     or v_final_principal_flow_ids[1] <> v_flow_id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_observed_session_ambiguous'
    );
  end if;
  return v_result;
end;
$$;

create or replace function public.verify_oauth_flow_source_session_evidence(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_access_token_sha256 text,
  p_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_access_token_sha256 is null
     or p_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_refresh_token_sha256 is null
     or p_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_source_session_evidence'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_source_session_evidence_mismatch'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for share;

  if not found
     or v_row.source_user_id is distinct from p_source_user_id
     or v_row.source_session_id is distinct from p_source_session_id
     or v_row.source_access_token_sha256
        is distinct from p_access_token_sha256
     or v_row.source_refresh_token_sha256
        is distinct from p_refresh_token_sha256 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_source_session_evidence_mismatch'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'matched', true
  );
end;
$$;

create or replace function public.verify_oauth_flow_target_session_evidence(
  p_flow_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_access_token_sha256 text,
  p_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_access_token_sha256 is null
     or p_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_refresh_token_sha256 is null
     or p_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_session_evidence'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_mismatch'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for share;

  if not found
     or v_row.target_user_id is distinct from p_target_user_id
     or v_row.target_session_id is distinct from p_target_session_id
     or v_row.target_access_token_sha256
        is distinct from p_access_token_sha256
     or v_row.target_refresh_token_sha256
        is distinct from p_refresh_token_sha256 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_mismatch'
    );
  end if;

  if not public.bp_0093_oauth_target_generation_matches(
    v_row.source_user_id,
    v_row.target_user_id,
    v_row.target_session_id,
    v_row.target_auth_created_at,
    v_row.target_auth_instance_id,
    v_row.target_session_created_at
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'matched', true,
    'releasedAt', v_row.released_at
  );
end;
$$;

create or replace function public.read_oauth_flow_target_session_evidence(
  p_flow_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_target_user_id is null
     or p_target_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_session_evidence_read'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_not_readable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for share;

  if not found
     or v_row.target_user_id is distinct from p_target_user_id
     or v_row.target_session_id is distinct from p_target_session_id
     or v_row.released_at is not null
     or not (
       v_row.state = 'claimed'
       or v_row.state = 'signout_required'
       or (
         v_row.state = 'completed'
         and v_row.action = 'continue'
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_not_readable'
    );
  end if;

  if not public.bp_0093_oauth_target_generation_matches(
    v_row.source_user_id,
    v_row.target_user_id,
    v_row.target_session_id,
    v_row.target_auth_created_at,
    v_row.target_auth_instance_id,
    v_row.target_session_created_at
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', v_row.target_session_id,
    'accessTokenSha256', v_row.target_access_token_sha256,
    'refreshTokenSha256', v_row.target_refresh_token_sha256,
    'releasedAt', v_row.released_at
  );
end;
$$;

create or replace function public.rotate_oauth_flow_target_session_evidence(
  p_flow_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_old_access_token_sha256 text,
  p_old_refresh_token_sha256 text,
  p_new_access_token_sha256 text,
  p_new_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_old_access_token_sha256 is null
     or p_old_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_old_refresh_token_sha256 is null
     or p_old_refresh_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_new_access_token_sha256 is null
     or p_new_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_new_refresh_token_sha256 is null
     or p_new_refresh_token_sha256 !~ '^[0-9a-f]{64}$'
     or (
       p_old_access_token_sha256 =
         p_new_access_token_sha256
       and p_old_refresh_token_sha256 =
         p_new_refresh_token_sha256
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_session_evidence_rotation'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_not_rotatable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found
     or v_row.target_user_id is distinct from p_target_user_id
     or v_row.target_session_id is distinct from p_target_session_id
     or v_row.released_at is not null
     or not (
       v_row.state = 'claimed'
       or v_row.state = 'signout_required'
       or (
         v_row.state = 'completed'
         and v_row.action = 'continue'
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_not_rotatable'
    );
  end if;

  if not public.bp_0093_oauth_target_generation_matches(
    v_row.source_user_id,
    v_row.target_user_id,
    v_row.target_session_id,
    v_row.target_auth_created_at,
    v_row.target_auth_instance_id,
    v_row.target_session_created_at
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;

  if v_row.target_access_token_sha256
       is distinct from p_old_access_token_sha256
     or v_row.target_refresh_token_sha256
       is distinct from p_old_refresh_token_sha256 then
    if v_row.target_access_token_sha256 =
         p_new_access_token_sha256
       and v_row.target_refresh_token_sha256 =
         p_new_refresh_token_sha256 then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'flowId', v_row.flow_id,
        'state', v_row.state,
        'targetUserId', v_row.target_user_id,
        'targetSessionId', v_row.target_session_id
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_session_evidence_rotation_conflict'
    );
  end if;

  update public.oauth_flow_intents
     set target_access_token_sha256 =
           p_new_access_token_sha256,
         target_refresh_token_sha256 =
           p_new_refresh_token_sha256
   where flow_id = p_flow_id
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', v_row.target_session_id
  );
end;
$$;

create or replace function public.release_oauth_flow_intent(
  p_flow_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_access_token_sha256 text,
  p_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_target_is_member boolean;
  v_no_transfer jsonb;
begin
  if p_flow_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_access_token_sha256 is null
     or p_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_refresh_token_sha256 is null
     or p_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_release'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_releasable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found
     or v_row.state <> 'completed'
     or v_row.action <> 'continue'
     or v_row.revoke_confirmed_at is not null
     or v_row.target_user_id is distinct from p_target_user_id
     or v_row.target_session_id is distinct from p_target_session_id
     or v_row.target_access_token_sha256
       is distinct from p_access_token_sha256
     or v_row.target_refresh_token_sha256
       is distinct from p_refresh_token_sha256 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_releasable'
    );
  end if;

  -- Once release committed, its exact tuple is a durable receipt and remains
  -- replayable after remote target-session revocation. Before that terminal
  -- point, require the exact bound Auth/session generation.
  if v_row.released_at is null
     and not public.bp_0093_oauth_target_generation_matches(
       v_row.source_user_id,
       v_row.target_user_id,
       v_row.target_session_id,
       v_row.target_auth_created_at,
       v_row.target_auth_instance_id,
       v_row.target_session_created_at
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;

  if v_row.released_at is null then
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_flow_intents
       set released_at = greatest(
         v_now,
         v_row.finished_at
       )
     where flow_id = p_flow_id
    returning * into v_row;
  end if;

  if v_row.source_is_anonymous
     and v_row.migration_consumed_at is null then
    select exists (
      select 1
        from public.member_accounts as target_member
       where target_member.user_id = v_row.target_user_id
    ) into v_target_is_member;
    if v_target_is_member then
      v_no_transfer :=
        public.complete_oauth_flow_intent_migration_without_transfer(
          v_row.flow_id,
          v_row.target_user_id,
          v_row.target_session_id,
          v_row.source_user_id,
          'target_already_member'
        );
      if v_no_transfer->'ok'
           is distinct from 'true'::jsonb
         and v_no_transfer->>'error' is distinct from
           'oauth_flow_migration_skip_reason_not_proven' then
        raise exception 'oauth_flow_release_no_transfer_failed: %',
          coalesce(
            v_no_transfer->>'error',
            'invalid_result'
          )
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'releasedAt', v_row.released_at
  );
end;
$$;

create or replace function public.finalize_oauth_flow_intent(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text,
  p_requested_next text,
  p_outcome text,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_target_access_token_sha256 text,
  p_target_refresh_token_sha256 text,
  p_destination text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_stored_outcome text;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao')
     or p_requested_next is null
     or pg_catalog.length(p_requested_next) not between 1 and 2048
     or pg_catalog.left(p_requested_next, 1) <> '/'
     or pg_catalog.left(p_requested_next, 2) = '//'
     or pg_catalog.strpos(
       p_requested_next,
       pg_catalog.chr(92)
     ) <> 0
     or p_requested_next ~ '[[:cntrl:]]'
     or p_outcome is null
     or p_outcome not in ('completed', 'failed')
     or (
       (p_target_user_id is null) <>
       (p_target_session_id is null)
     )
     or (
       (p_target_user_id is null) <>
       (p_target_access_token_sha256 is null)
     )
     or (
       (p_target_user_id is null) <>
       (p_target_refresh_token_sha256 is null)
     )
     or (
       p_target_access_token_sha256 is not null
       and p_target_access_token_sha256 !~ '^[0-9a-f]{64}$'
     )
     or (
       p_target_refresh_token_sha256 is not null
       and p_target_refresh_token_sha256 !~ '^[0-9a-f]{64}$'
     )
     or p_destination is null
     or pg_catalog.length(p_destination) not between 1 and 2048
     or pg_catalog.left(p_destination, 1) <> '/'
     or pg_catalog.left(p_destination, 2) = '//'
     or pg_catalog.strpos(
       p_destination,
       pg_catalog.chr(92)
     ) <> 0
     or p_destination ~ '[[:cntrl:]]'
     or p_action is null
     or p_action not in ('continue', 'signout')
     or (
       p_outcome = 'completed'
       and p_target_user_id is null
     )
     or (
       p_outcome = 'failed'
       and (
         p_target_user_id is not null
         or p_action <> 'continue'
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_finalize'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_finalizable'
    );
  end if;

  if v_row.requested_next <> p_requested_next then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_finalize_conflict'
    );
  end if;

  if v_row.state in (
    'completed',
    'failed',
    'signout_required',
    'signout_revoked'
  ) then
    v_stored_outcome := case
      when v_row.state = 'failed' then 'failed'
      else 'completed'
    end;
    if v_stored_outcome <> p_outcome
       or v_row.target_user_id is distinct from p_target_user_id
       or v_row.target_session_id
          is distinct from p_target_session_id
       or v_row.target_access_token_sha256
          is distinct from p_target_access_token_sha256
       or v_row.target_refresh_token_sha256
          is distinct from p_target_refresh_token_sha256
       or v_row.destination <> p_destination
       or v_row.action <> p_action then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_finalize_conflict'
      );
    end if;
    if v_row.source_is_anonymous
       and (
         v_row.state = 'failed'
         or (
           v_row.state = 'completed'
           and v_row.action = 'signout'
         )
       ) then
      v_now := pg_catalog.clock_timestamp();
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'outcome', v_stored_outcome,
      'targetUserId', v_row.target_user_id,
      'targetSessionId', v_row.target_session_id,
      'destination', v_row.destination,
      'action', v_row.action
    );
  end if;

  if v_row.state <> 'claimed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_finalizable'
    );
  end if;

  if p_outcome = 'completed' then
    if v_row.target_user_id is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_target_not_bound'
      );
    end if;
    if v_row.target_user_id is distinct from p_target_user_id
       or v_row.target_session_id is distinct from p_target_session_id
       or v_row.target_access_token_sha256
         is distinct from p_target_access_token_sha256
       or v_row.target_refresh_token_sha256
         is distinct from p_target_refresh_token_sha256 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_finalize_conflict'
      );
    end if;
  elsif v_row.target_user_id is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_finalize_conflict'
    );
  end if;

  if p_outcome = 'completed'
     and p_action = 'continue'
     and v_row.source_is_anonymous then
    -- Consume/no-transfer and cleanup workers lock the durable cleanup row
    -- before any user advisory or Auth tuple. Take the same row now so a
    -- different flow sharing the source cannot form job -> advisory/Auth vs
    -- advisory/Auth -> job cycles while finalize decides membership.
    perform 1
      from public.oauth_anon_auth_cleanup_jobs as cleanup
     where cleanup.flow_id = v_row.flow_id
       and cleanup.source_user_id = v_row.source_user_id
       and cleanup.status = 'dormant'
     for update of cleanup;
    if not found then
      raise exception 'oauth_anon_auth_cleanup_receipt_invalid'
        using errcode = 'P0001';
    end if;

    -- Account lifecycle paths own the user-mutation advisory before Auth.
    -- Acquire both affected users in canonical order before generation
    -- verification takes Auth row locks.
    perform public.bp_user_mutation_lock_many(
      array[v_row.source_user_id, v_row.target_user_id]
    );
  end if;

  if p_outcome = 'completed'
     and not public.bp_0093_oauth_target_generation_matches(
       v_row.source_user_id,
       v_row.target_user_id,
       v_row.target_session_id,
       v_row.target_auth_created_at,
       v_row.target_auth_instance_id,
       v_row.target_session_created_at
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;

  if v_row.target_session_id is null
     or v_row.source_session_id::text <
        v_row.target_session_id::text then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    if v_row.target_session_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.target_session_id::text,
          0
        )
      );
    end if;
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.target_session_id::text,
        0
      )
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.oauth_flow_intents
     set state = case
           when p_outcome = 'failed' then 'failed'
           when p_action = 'signout' then 'signout_required'
           else 'completed'
         end,
         destination = p_destination,
         action = p_action,
         finished_at = case
           when p_outcome = 'failed'
             or p_action = 'continue'
             then greatest(
               v_now,
               v_row.claimed_at
             )
           else null
         end,
         migration_consumed_at = null,
         migration_result = null
   where flow_id = p_flow_id
  returning * into v_row;

  if p_outcome = 'failed'
     and v_row.source_is_anonymous then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           next_attempt_at = null,
           last_error = null
     where flow_id = p_flow_id
       and status = 'dormant';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'outcome', p_outcome,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', v_row.target_session_id,
    'destination', v_row.destination,
    'action', v_row.action
  );
end;
$$;

create or replace function public.confirm_oauth_flow_signout_revoke(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text,
  p_target_user_id uuid,
  p_target_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao')
     or p_target_user_id is null
     or p_target_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_signout_revoke'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_signout_not_confirmable'
    );
  end if;

  if v_row.state in (
    'signout_required',
    'signout_revoked'
  )
  or (
    v_row.state = 'completed'
    and v_row.action = 'signout'
  ) then
    if v_row.target_user_id <> p_target_user_id
       or v_row.target_session_id <> p_target_session_id then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_signout_revoke_conflict'
      );
    end if;
  else
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_signout_not_confirmable'
    );
  end if;

  if v_row.state = 'signout_required' then
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_flow_intents
       set state = 'signout_revoked',
           revoke_confirmed_at = greatest(
             v_now,
             v_row.claimed_at
           )
     where flow_id = p_flow_id
    returning * into v_row;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'targetUserId', v_row.target_user_id,
    'targetSessionId', v_row.target_session_id,
    'revokeConfirmedAt', v_row.revoke_confirmed_at
  );
end;
$$;

create or replace function public.complete_oauth_flow_signout(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text,
  p_target_user_id uuid,
  p_target_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao')
     or p_target_user_id is null
     or p_target_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_signout'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_signout_not_completable'
    );
  end if;

  if v_row.state in ('signout_revoked', 'completed')
     and v_row.action = 'signout' then
    if v_row.target_user_id <> p_target_user_id
       or v_row.target_session_id <> p_target_session_id then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_signout_complete_conflict'
      );
    end if;
  else
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_signout_not_completable'
    );
  end if;

  if v_row.state = 'signout_revoked' then
    if v_row.source_session_id::text <
       v_row.target_session_id::text then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.source_session_id::text,
          0
        )
      );
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.target_session_id::text,
          0
        )
      );
    else
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.target_session_id::text,
          0
        )
      );
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.source_session_id::text,
          0
        )
      );
    end if;
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_flow_intents
       set state = 'completed',
           finished_at = greatest(
             v_now,
             v_row.revoke_confirmed_at
           )
     where flow_id = p_flow_id
    returning * into v_row;
  end if;

  if v_row.source_is_anonymous then
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           next_attempt_at = null,
           last_error = null
     where flow_id = p_flow_id
       and status = 'dormant';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'destination', v_row.destination
  );
end;
$$;

create or replace function public.complete_recovered_oauth_flow_signout(
  p_flow_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_recovered_signout'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_recovered_signout_not_completable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found
     or v_row.action <> 'signout'
     or v_row.state not in ('signout_revoked', 'completed') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_recovered_signout_not_completable'
    );
  end if;

  if v_row.state = 'signout_revoked' then
    if v_row.source_session_id::text <
       v_row.target_session_id::text then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.source_session_id::text,
          0
        )
      );
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.target_session_id::text,
          0
        )
      );
    else
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.target_session_id::text,
          0
        )
      );
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_row.source_session_id::text,
          0
        )
      );
    end if;
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_flow_intents
       set state = 'completed',
           finished_at = greatest(
             v_now,
             v_row.revoke_confirmed_at
           )
     where flow_id = p_flow_id
    returning * into v_row;
  end if;

  if v_row.source_is_anonymous then
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           next_attempt_at = null,
           last_error = null
     where flow_id = p_flow_id
       and status = 'dormant';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'destination', v_row.destination
  );
end;
$$;

create or replace function public.cancel_oauth_flow_intent(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_cancel'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_cancellable'
    );
  end if;

  if v_row.state = 'cancelled' then
    if v_row.source_is_anonymous then
      v_now := pg_catalog.clock_timestamp();
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'outcome', 'cancelled'
    );
  end if;

  if v_row.state = 'expired' then
    if v_row.source_is_anonymous then
      v_now := pg_catalog.clock_timestamp();
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'outcome', 'expired'
    );
  end if;

  if v_row.state <> 'pending' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_cancellable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  -- Evaluate expiry after lock acquisition, not at RPC entry.
  v_now := pg_catalog.clock_timestamp();
  if v_row.expires_at <= v_now then
    update public.oauth_flow_intents
       set state = 'expired',
           finished_at = greatest(
             v_now,
             v_row.expires_at
         )
     where flow_id = p_flow_id;
    if v_row.source_is_anonymous then
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', p_flow_id,
      'outcome', 'expired'
    );
  end if;

  update public.oauth_flow_intents
     set state = 'cancelled',
         finished_at = greatest(
           v_now,
           v_row.created_at
         )
   where flow_id = p_flow_id;

  if v_row.source_is_anonymous then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           next_attempt_at = null,
           last_error = null
     where flow_id = p_flow_id
       and status = 'dormant';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', p_flow_id,
    'outcome', 'cancelled'
  );
end;
$$;

create or replace function public.revoke_bound_oauth_flow_target_session(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth_session_found boolean;
  v_auth_session_user_id uuid;
  v_now timestamptz;
  v_outcome text;
  v_revoke_at timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_terminal_replay boolean := false;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_target_revoke'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found
     or v_row.target_user_id is null
     or v_row.target_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_bound_target_not_revocable'
    );
  end if;

  -- A committed cleanup is its own durable replay receipt. A normally
  -- released continue flow (released_at set, revoke_confirmed_at null) is
  -- deliberately excluded: that session already belongs to the application.
  if (
    v_row.state = 'abandoned'
    and v_row.revoke_confirmed_at is not null
  )
  or (
    v_row.state = 'completed'
    and v_row.action = 'signout'
    and v_row.revoke_confirmed_at is not null
  )
  or (
    v_row.state = 'completed'
    and v_row.action = 'continue'
    and v_row.revoke_confirmed_at is not null
    and v_row.released_at is not null
  ) then
    v_terminal_replay := true;
  elsif not (
    v_row.state = 'claimed'
    or v_row.state = 'signout_required'
    or v_row.state = 'signout_revoked'
    or (
      v_row.state = 'completed'
      and v_row.action = 'continue'
      and v_row.released_at is null
      and v_row.revoke_confirmed_at is null
    )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_bound_target_not_revocable'
    );
  end if;

  -- The session ID trigger starts with this existing tuple. Take it before
  -- either observed-session advisory, then re-read after both locks below.
  perform 1
    from auth.sessions as target_session
   where target_session.id = v_row.target_session_id
   for update of target_session;

  -- Keep the same flow -> source -> sorted observed-session lock order as
  -- every other association writer. This makes cleanup race safely with a
  -- new begin/bind and with ordinary finalize/sign-out transitions.
  if v_row.source_session_id::text <
     v_row.target_session_id::text then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.target_session_id::text,
        0
      )
    );
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.target_session_id::text,
        0
      )
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
  end if;

  if exists (
    select 1
      from public.oauth_flow_intents
     where flow_id <> p_flow_id
       and session_fenced
       and (
         source_session_id = v_row.target_session_id
         or target_session_id = v_row.target_session_id
       )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_bound_target_session_in_use'
    );
  end if;

  select sessions.user_id
    into v_auth_session_user_id
    from auth.sessions
   where sessions.id = v_row.target_session_id
   for update;
  v_auth_session_found := found;

  if v_terminal_replay then
    -- A deleted Auth session ID must remain absent. UUID reuse is improbable
    -- but cannot be treated as an idempotent cleanup success: deleting a new
    -- row would be unsafe, while silently accepting it would leave a live
    -- session behind a revoked ledger receipt.
    if v_auth_session_found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_flow_bound_target_session_reappeared'
      );
    end if;
    if v_row.source_is_anonymous then
      v_now := pg_catalog.clock_timestamp();
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'state', v_row.state,
      'outcome', case
        when v_row.state = 'abandoned' then 'abandoned'
        else 'completed'
      end,
      'destination', '/',
      'revokeConfirmedAt', v_row.revoke_confirmed_at
    );
  end if;

  if v_auth_session_found
     and v_auth_session_user_id is distinct from
       v_row.target_user_id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_bound_target_session_identity_conflict'
    );
  end if;

  if v_auth_session_found then
    delete from auth.sessions
     where sessions.id = v_row.target_session_id
       and sessions.user_id = v_row.target_user_id;
  end if;

  -- The exact auth.sessions delete and every dependent refresh-token/MFA
  -- cascade commit in the same transaction as this durable state receipt.
  v_now := pg_catalog.clock_timestamp();
  if v_row.state = 'claimed' then
    v_revoke_at := greatest(v_now, v_row.claimed_at);
    update public.oauth_flow_intents
       set state = 'abandoned',
           revoke_confirmed_at = v_revoke_at,
           finished_at = v_revoke_at
     where flow_id = p_flow_id
    returning * into v_row;
  elsif v_row.state = 'signout_required' then
    v_revoke_at := greatest(v_now, v_row.claimed_at);
    update public.oauth_flow_intents
       set state = 'completed',
           revoke_confirmed_at = v_revoke_at,
           finished_at = v_revoke_at
     where flow_id = p_flow_id
    returning * into v_row;
  elsif v_row.state = 'signout_revoked' then
    update public.oauth_flow_intents
       set state = 'completed',
           finished_at = greatest(
             v_now,
             v_row.revoke_confirmed_at
           )
     where flow_id = p_flow_id
    returning * into v_row;
  else
    -- Finalize may have committed while its ACK or target cookies were lost.
    -- Preserve its original finish/migration receipt, record the exact session
    -- revocation, and durably close the browser release barrier.
    v_revoke_at := greatest(v_now, v_row.claimed_at);
    update public.oauth_flow_intents
       set revoke_confirmed_at = v_revoke_at,
           released_at = greatest(
             v_now,
             v_row.finished_at,
             v_revoke_at
           )
     where flow_id = p_flow_id
    returning * into v_row;
  end if;

  v_outcome := case
    when v_row.state = 'abandoned' then 'abandoned'
    else 'completed'
  end;

  if v_row.source_is_anonymous then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           next_attempt_at = null,
           last_error = null
     where flow_id = p_flow_id
       and status = 'dormant';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'state', v_row.state,
    'outcome', v_outcome,
    'destination', '/',
    'revokeConfirmedAt', v_row.revoke_confirmed_at
  );
end;
$$;

create or replace function public.abandon_oauth_flow_intent(
  p_flow_id uuid,
  p_source_user_id uuid,
  p_source_session_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cleanup jsonb;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null
     or p_source_user_id is null
     or p_source_session_id is null
     or p_provider is null
     or p_provider not in ('google', 'kakao') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_abandon'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      p_source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and source_session_id = p_source_session_id
     and provider = p_provider
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_abandonable'
    );
  end if;

  if v_row.state = 'abandoned' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'outcome', 'abandoned'
    );
  end if;

  if v_row.state <> 'claimed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_abandonable'
    );
  end if;

  if v_row.target_session_id is null then
    -- An Auth exchange may have committed while its response disappeared
    -- before target binding. With no exact session ID deletion is impossible,
    -- so this source fence must remain for explicit manual review.
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_abandonable'
    );
  end if;

  v_cleanup :=
    public.revoke_bound_oauth_flow_target_session(
      p_flow_id,
      p_source_user_id,
      p_source_session_id,
      p_provider
    );
  if v_cleanup->'ok' is distinct from 'true'::jsonb
     or v_cleanup->>'state' <> 'abandoned'
     or v_cleanup->>'outcome' <> 'abandoned' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_not_abandonable'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', p_flow_id,
    'outcome', 'abandoned'
  );
end;
$$;

create or replace function public.expire_oauth_flow_intent(
  p_flow_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
begin
  if p_flow_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_expire'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', p_flow_id,
      'outcome', 'absent'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', p_flow_id,
      'outcome', 'absent'
    );
  end if;

  if v_row.state = 'expired' then
    if v_row.source_is_anonymous then
      v_now := pg_catalog.clock_timestamp();
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', p_flow_id,
      'outcome', 'expired'
    );
  end if;

  -- Evaluate expiry only after the flow and source locks are held.
  v_now := pg_catalog.clock_timestamp();
  if (
       v_row.state = 'pending'
       or (
         v_row.state = 'claimed'
         and v_row.target_session_id is null
       )
     )
     and v_row.expires_at <= v_now then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_row.source_session_id::text,
        0
      )
    );
    update public.oauth_flow_intents
       set state = 'expired',
           finished_at = greatest(v_now, v_row.expires_at)
     where flow_id = p_flow_id
       and (
         state = 'pending'
         or (
           state = 'claimed'
           and target_session_id is null
         )
       );
    if v_row.source_is_anonymous then
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = p_flow_id
         and status = 'dormant';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', p_flow_id,
      'outcome', 'expired'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', false,
    'error', 'oauth_flow_not_expirable'
  );
end;
$$;

create or replace function
  public.bp_0093_quarantine_oauth_anon_source(
    p_flow_id uuid
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_flow public.oauth_flow_intents%rowtype;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_source_is_member boolean;
  v_has_unsupported_data boolean;
  v_target_profile_deleted boolean;
  v_target_principal_live boolean;
  v_target_session_live boolean;
  v_block_error text;
begin
  if p_flow_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_quarantine'
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  select *
    into v_flow
    from public.oauth_flow_intents
   where flow_id = p_flow_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_quarantine_not_applicable'
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_flow.source_session_id::text,
      0
    )
  );
  select *
    into v_flow
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;
  if not found
     or v_flow.state <> 'completed'
     or v_flow.action <> 'continue'
     or not v_flow.source_is_anonymous
     or v_flow.revoke_confirmed_at is not null
     or v_flow.released_at is null
     or v_flow.migration_consumed_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_quarantine_not_applicable'
    );
  end if;

  select *
    into v_cleanup
    from public.oauth_anon_auth_cleanup_jobs
   where flow_id = v_flow.flow_id
     and source_user_id = v_flow.source_user_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_quarantine_job_missing'
    );
  end if;
  if v_cleanup.status = 'quarantined' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'quarantined'
    );
  end if;
  if v_cleanup.status = 'blocked' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'blocked'
    );
  end if;
  if v_cleanup.status <> 'dormant' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_quarantine_not_applicable'
    );
  end if;

  perform public.bp_0084_anon_reassign_locks(
    v_flow.source_user_id,
    v_flow.target_user_id
  );
  perform public.bp_user_mutation_lock_many(
    array[v_flow.source_user_id, v_flow.target_user_id]
  );
  perform 1
    from auth.users as auth_user
   where auth_user.id in (
     v_flow.source_user_id,
     v_flow.target_user_id
   )
   order by auth_user.id
   for update of auth_user;
  perform 1
    from auth.sessions as target_session
   where target_session.id = v_flow.target_session_id
   for update of target_session;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-observed-session:' ||
      v_flow.target_session_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' ||
      v_flow.source_user_id::text,
      0
    )
  );
  perform 1
    from public.profiles as profile
   where profile.id in (
     v_flow.source_user_id,
     v_flow.target_user_id
   )
   order by profile.id
   for update of profile;

  -- Recompute the wall clock only after every blocking lock. Lock waits never
  -- extend the 24-hour visibility grace or the signed recovery deadline.
  v_now := pg_catalog.clock_timestamp();
  if v_flow.released_at >
       v_now - interval '24 hours' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_quarantine_grace_open'
    );
  end if;

  select source_user.created_at,
         source_user.instance_id,
         source_user.is_anonymous
    into v_source_auth_created_at,
         v_source_auth_instance_id,
         v_source_auth_is_anonymous
    from auth.users as source_user
   where source_user.id = v_flow.source_user_id;
  if not found
     or v_source_auth_is_anonymous is not true
     or v_source_auth_created_at is distinct from
       v_cleanup.source_auth_created_at
     or v_source_auth_instance_id is distinct from
       v_cleanup.source_auth_instance_id then
    v_block_error := 'source_generation_changed';
  end if;
  select exists (
    select 1
      from public.member_accounts
     where user_id = v_flow.source_user_id
  ) into v_source_is_member;
  if v_block_error is null and v_source_is_member then
    v_block_error := 'source_is_member';
  end if;
  select exists (
           select 1 from public.dolls
            where owner_id = v_flow.source_user_id
         )
         or exists (
           select 1 from public.orders
            where user_id = v_flow.source_user_id
         )
         or exists (
           select 1 from public.ai_generations
            where owner_id = v_flow.source_user_id
         )
    into v_has_unsupported_data;
  if v_block_error is null and v_has_unsupported_data then
    v_block_error := 'unexpected_source_data';
  end if;
  if v_block_error is not null then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'blocked',
           quarantine_reason = 'migration_blocked',
           quarantined_at = v_now,
           last_error = v_block_error
     where cleanup_id = v_cleanup.cleanup_id
       and status = 'dormant';
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'blocked'
    );
  end if;

  select exists (
    select 1
      from auth.users as target_user
     where target_user.id = v_flow.target_user_id
       and target_user.is_anonymous is false
       and target_user.created_at =
         v_flow.target_auth_created_at
       and target_user.instance_id is not distinct from
         v_flow.target_auth_instance_id
  ) into v_target_principal_live;
  select exists (
    select 1
      from auth.sessions as target_session
     where target_session.id = v_flow.target_session_id
       and target_session.user_id = v_flow.target_user_id
       and target_session.created_at =
         v_flow.target_session_created_at
  ) into v_target_session_live;
  select profile.deleted_at is not null
    into v_target_profile_deleted
    from public.profiles as profile
   where profile.id = v_flow.target_user_id;
  v_target_profile_deleted :=
    not found or coalesce(v_target_profile_deleted, true);

  if v_target_profile_deleted then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_withdrawn'
    );
  end if;
  if v_target_principal_live and v_target_session_live then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'authority_live'
    );
  end if;

  -- 익명 소스 프로필은 서비스 생성 랜덤 닉네임뿐(PII 없음) — 재사용 차단(deleted_at)만
  -- 하고 표기·아바타는 보존한다(2026-08-21 — 랭킹 '탈퇴한 사용자' 오표기 방지).
  update public.profiles
     set deleted_at = v_now
   where id = v_flow.source_user_id
     and deleted_at is null;
  if not exists (
    select 1
      from public.profiles as source_profile
     where source_profile.id = v_flow.source_user_id
       and source_profile.deleted_at is not null
  ) then
    raise exception 'oauth_flow_quarantine_profile_failed'
      using errcode = 'P0001';
  end if;
  with quarantined_highlight as (
    update public.score_highlights as highlight
       set highlight_deleted_at = v_now
      from public.scores as score
     where highlight.score_id = score.id
       and score.owner_id = v_flow.source_user_id
       and highlight.highlight_deleted_at is null
    returning highlight.score_id, highlight.highlight_deleted_at
  )
  insert into public.oauth_quarantined_score_highlights(
    score_id,
    flow_id,
    quarantined_at
  )
  select quarantined_highlight.score_id,
         v_flow.flow_id,
         quarantined_highlight.highlight_deleted_at
    from quarantined_highlight;
  delete from auth.sessions
   where user_id = v_flow.source_user_id;

  update public.oauth_anon_auth_cleanup_jobs
     set status = 'quarantined',
         quarantine_reason = 'target_session_missing',
         quarantined_at = v_now,
         access_revoked_at = v_now
   where cleanup_id = v_cleanup.cleanup_id
     and status = 'dormant';
  if not found then
    raise exception 'oauth_flow_quarantine_job_failed'
      using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_flow.flow_id,
    'outcome', 'quarantined'
  );
end;
$$;

revoke all on function
  public.bp_0093_quarantine_oauth_anon_source(uuid)
  from public, anon, authenticated, service_role;

create or replace function
  public.bp_0093_scrub_oauth_quarantined_source(
    p_flow_id uuid,
    p_scrub_reason text
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_flow public.oauth_flow_intents%rowtype;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_source_is_member boolean;
  v_has_unsupported_data boolean;
  v_target_profile_deleted boolean;
  v_block_error text;
  v_tombstone_reason text;
begin
  if p_flow_id is null
     or p_scrub_reason not in (
       'target_withdrawn',
       'recovery_expired'
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_privacy_scrub'
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  select *
    into v_flow
    from public.oauth_flow_intents
   where flow_id = p_flow_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_privacy_scrub_not_applicable'
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_flow.source_session_id::text,
      0
    )
  );
  select *
    into v_flow
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;
  if not found
     or v_flow.state <> 'completed'
     or v_flow.action <> 'continue'
     or not v_flow.source_is_anonymous
     or v_flow.revoke_confirmed_at is not null
     or v_flow.released_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_privacy_scrub_not_applicable'
    );
  end if;
  select *
    into v_cleanup
    from public.oauth_anon_auth_cleanup_jobs
   where flow_id = v_flow.flow_id
     and source_user_id = v_flow.source_user_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_privacy_scrub_job_missing'
    );
  end if;
  if v_cleanup.status = 'scrubbed' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'scrubbed'
    );
  end if;
  if v_cleanup.status = 'blocked' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'blocked'
    );
  end if;
  if v_cleanup.status not in ('dormant', 'quarantined') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_privacy_scrub_not_applicable'
    );
  end if;

  perform public.bp_0084_anon_reassign_locks(
    v_flow.source_user_id,
    v_flow.target_user_id
  );
  perform public.bp_user_mutation_lock_many(
    array[v_flow.source_user_id, v_flow.target_user_id]
  );
  perform 1
    from auth.users as auth_user
   where auth_user.id in (
     v_flow.source_user_id,
     v_flow.target_user_id
   )
   order by auth_user.id
   for update of auth_user;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' ||
      v_flow.source_user_id::text,
      0
    )
  );
  perform 1
    from public.profiles as profile
   where profile.id in (
     v_flow.source_user_id,
     v_flow.target_user_id
   )
   order by profile.id
   for update of profile;

  v_now := pg_catalog.clock_timestamp();
  select profile.deleted_at is not null
    into v_target_profile_deleted
    from public.profiles as profile
   where profile.id = v_flow.target_user_id;
  v_target_profile_deleted :=
    not found or coalesce(v_target_profile_deleted, true);
  if (
    p_scrub_reason = 'target_withdrawn'
    and not v_target_profile_deleted
  )
  or (
    p_scrub_reason = 'recovery_expired'
    and (
      v_cleanup.status not in ('dormant', 'quarantined')
      or v_cleanup.recover_until is null
      or v_now <= v_cleanup.recover_until
    )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_privacy_scrub_not_due'
    );
  end if;

  select source_user.created_at,
         source_user.instance_id,
         source_user.is_anonymous
    into v_source_auth_created_at,
         v_source_auth_instance_id,
         v_source_auth_is_anonymous
    from auth.users as source_user
   where source_user.id = v_flow.source_user_id;
  if not found
     or v_source_auth_is_anonymous is not true
     or v_source_auth_created_at is distinct from
       v_cleanup.source_auth_created_at
     or v_source_auth_instance_id is distinct from
       v_cleanup.source_auth_instance_id then
    v_block_error := 'source_generation_changed';
  end if;
  select exists (
    select 1
      from public.member_accounts
     where user_id = v_flow.source_user_id
  ) into v_source_is_member;
  if v_block_error is null and v_source_is_member then
    v_block_error := 'source_is_member';
  end if;
  select exists (
           select 1 from public.dolls
            where owner_id = v_flow.source_user_id
         )
         or exists (
           select 1 from public.orders
            where user_id = v_flow.source_user_id
         )
         or exists (
           select 1 from public.ai_generations
            where owner_id = v_flow.source_user_id
         )
    into v_has_unsupported_data;
  if v_block_error is null and v_has_unsupported_data then
    v_block_error := 'unexpected_source_data';
  end if;
  if v_block_error is not null then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'blocked',
           quarantine_reason = coalesce(
             quarantine_reason,
             'migration_blocked'
           ),
           quarantined_at = coalesce(quarantined_at, v_now),
           last_error = v_block_error
     where cleanup_id = v_cleanup.cleanup_id
       and status in ('dormant', 'quarantined');
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'blocked'
    );
  end if;

  -- 익명 소스 프로필은 서비스 생성 랜덤 닉네임뿐(PII 없음) — 재사용 차단(deleted_at)만
  -- 하고 표기·아바타는 보존한다(2026-08-21 — 랭킹 '탈퇴한 사용자' 오표기 방지).
  update public.profiles
     set deleted_at = v_now
   where id = v_flow.source_user_id
     and deleted_at is null;
  if not exists (
    select 1
      from public.profiles as source_profile
     where source_profile.id = v_flow.source_user_id
       and source_profile.deleted_at is not null
  ) then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'blocked',
           quarantine_reason = coalesce(
             quarantine_reason,
             'migration_blocked'
           ),
           quarantined_at = coalesce(quarantined_at, v_now),
           last_error = 'scrub_failed'
     where cleanup_id = v_cleanup.cleanup_id
       and status in ('dormant', 'quarantined');
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_flow.flow_id,
      'outcome', 'blocked'
    );
  end if;

  update public.score_highlights as highlight
     set highlight_deleted_at =
       coalesce(
         highlight.highlight_deleted_at,
         v_now
       )
    from public.scores as score
   where highlight.score_id = score.id
     and score.owner_id = v_flow.source_user_id;
  delete from public.oauth_quarantined_score_highlights
   where flow_id = v_flow.flow_id;
  delete from public.user_badges
   where owner_id = v_flow.source_user_id;
  update public.telemetry_sessions as telemetry
     set owner_id = null,
         is_anon = true,
         submitter_binding = null
   where telemetry.owner_id = v_flow.source_user_id
      or (
        telemetry.owner_id is null
        and telemetry.is_anon is true
        and telemetry.submitter_binding =
          public.bp_telemetry_submitter_binding(
            telemetry.id,
            v_flow.source_user_id
          )
      );
  delete from auth.sessions
   where user_id = v_flow.source_user_id;

  if v_flow.migration_consumed_at is null then
    update public.oauth_flow_intents
       set migration_consumed_at = greatest(
             v_now,
             v_flow.finished_at
           ),
           migration_result = pg_catalog.jsonb_build_object(
             'ok', true,
             'skipped', p_scrub_reason
           )
     where flow_id = v_flow.flow_id
    returning * into v_flow;
  end if;
  v_tombstone_reason := case
    when v_flow.migration_result->>'skipped' in (
      'target_already_member',
      'target_already_claimed'
    ) then 'terminal_no_transfer'
    else p_scrub_reason
  end;
  insert into public.oauth_deidentified_score_owner_tombstones(
    source_user_id,
    deidentified_at,
    reason
  )
  values (
    v_flow.source_user_id,
    v_now,
    v_tombstone_reason
  )
  on conflict (source_user_id) do nothing;

  update public.oauth_anon_auth_cleanup_jobs
     set status = 'scrubbed',
         quarantine_reason = coalesce(
           quarantine_reason,
           case
             when p_scrub_reason = 'target_withdrawn'
               then 'target_withdrawn'
             else 'target_session_missing'
           end
         ),
         quarantined_at = coalesce(quarantined_at, v_now),
         access_revoked_at = coalesce(access_revoked_at, v_now),
         scrubbed_at = v_now,
         armed_at = greatest(v_now, created_at),
         next_attempt_at = null,
         lease_token = null,
         lease_expires_at = null,
         finished_at = v_now,
         last_error = null
   where cleanup_id = v_cleanup.cleanup_id
     and status in ('dormant', 'quarantined');
  if not found then
    raise exception 'oauth_flow_privacy_scrub_job_failed'
      using errcode = 'P0001';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_flow.flow_id,
    'outcome', 'scrubbed'
  );
end;
$$;

revoke all on function
  public.bp_0093_scrub_oauth_quarantined_source(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function
  public.bp_0093_reassign_quarantined_anon_data(
    p_flow_id uuid,
    p_old uuid,
    p_new uuid
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_flow public.oauth_flow_intents%rowtype;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_source_receipt public.anon_data_reassignments%rowtype;
  v_target_receipt public.anon_data_reassignments%rowtype;
  v_source_profile public.profiles%rowtype;
  v_target_profile public.profiles%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_scores integer := 0;
  v_badges integer := 0;
  v_telemetry integer := 0;
  v_result jsonb;
begin
  if p_flow_id is null
     or p_old is null
     or p_new is null
     or p_old = p_new then
    raise exception 'invalid_quarantined_anon_reassignment'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );
  select *
    into v_flow
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;
  if not found
     or v_flow.source_user_id <> p_old
     or v_flow.target_user_id <> p_new
     or v_flow.state <> 'completed'
     or v_flow.action <> 'continue'
     or not v_flow.source_is_anonymous
     or v_flow.revoke_confirmed_at is not null
     or v_flow.released_at is null
     or v_flow.migration_consumed_at is not null then
    raise exception 'quarantined_anon_reassignment_flow_invalid'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_flow.source_session_id::text,
      0
    )
  );
  select *
    into v_cleanup
    from public.oauth_anon_auth_cleanup_jobs
   where flow_id = p_flow_id
     and source_user_id = p_old
   for update;
  v_now := pg_catalog.clock_timestamp();
  if not found
     or v_cleanup.status <> 'quarantined'
     or v_cleanup.quarantine_reason <>
       'target_session_missing'
     or v_cleanup.recover_until is null
     or v_now > v_cleanup.recover_until then
    raise exception 'quarantined_anon_reassignment_not_recoverable'
      using errcode = 'P0001';
  end if;

  perform public.bp_0084_anon_reassign_locks(p_old, p_new);
  perform public.bp_user_mutation_lock_many(array[p_old, p_new]);
  perform 1
    from auth.users as auth_user
   where auth_user.id in (p_old, p_new)
   order by auth_user.id
   for update of auth_user;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' || p_old::text,
      0
    )
  );

  select source_user.created_at,
         source_user.instance_id,
         source_user.is_anonymous
    into v_source_auth_created_at,
         v_source_auth_instance_id,
         v_source_auth_is_anonymous
    from auth.users as source_user
   where source_user.id = p_old
   for update of source_user;
  if not found
     or v_source_auth_is_anonymous is not true
     or v_source_auth_created_at is distinct from
       v_cleanup.source_auth_created_at
     or v_source_auth_instance_id is distinct from
       v_cleanup.source_auth_instance_id then
    raise exception 'quarantined_anon_reassignment_source_generation_changed'
      using errcode = 'P0001';
  end if;

  select *
    into v_source_profile
    from public.profiles
   where id = p_old
   for update;
  select *
    into v_target_profile
    from public.profiles
   where id = p_new
   for update;
  if v_source_profile.id is null
     or v_source_profile.deleted_at is null then
    raise exception 'quarantined_anon_reassignment_source_profile_invalid'
      using errcode = 'P0001';
  end if;
  if v_target_profile.id is null
     or v_target_profile.deleted_at is not null then
    raise exception 'quarantined_anon_reassignment_target_profile_invalid'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.member_accounts
     where user_id = p_old
  )
  or exists (
    select 1 from public.dolls where owner_id = p_old
  )
  or exists (
    select 1 from public.orders where user_id = p_old
  )
  or exists (
    select 1
      from public.ai_generations
     where owner_id = p_old
  ) then
    raise exception 'quarantined_anon_reassignment_source_data_changed'
      using errcode = 'P0001';
  end if;

  select *
    into v_source_receipt
    from public.anon_data_reassignments
   where source_user_id = p_old
   for update;
  if found then
    if v_source_receipt.target_user_id <> p_new then
      raise exception 'anon_reassignment_conflict'
        using errcode = 'P0001';
    end if;
    return v_source_receipt.result;
  end if;
  select *
    into v_target_receipt
    from public.anon_data_reassignments
   where target_user_id = p_new
   for update;
  if found then
    raise exception 'anon_reassignment_target_conflict'
      using errcode = 'P0001';
  end if;

  update public.scores
     set owner_id = p_new
   where owner_id = p_old;
  get diagnostics v_scores = row_count;

  -- Restore only rows carrying this flow's private marker. The trigger removes
  -- that marker on every later independent moderation/deletion-state write,
  -- including a write that happens to reuse the same timestamp.
  update public.score_highlights as highlight
     set highlight_deleted_at = null
    from public.scores as score,
         public.oauth_quarantined_score_highlights as marker
   where highlight.score_id = score.id
     and marker.score_id = highlight.score_id
     and marker.flow_id = v_flow.flow_id
     and score.owner_id = p_new
     and highlight.highlight_deleted_at =
       marker.quarantined_at
     and marker.quarantined_at =
       v_cleanup.quarantined_at
     and highlight.highlight_deleted_by_doll is null;
  delete from public.oauth_quarantined_score_highlights
   where flow_id = v_flow.flow_id;

  update public.user_badges as source_badge
     set owner_id = p_new
   where source_badge.owner_id = p_old
     and not exists (
       select 1
         from public.user_badges as target_badge
        where target_badge.owner_id = p_new
          and target_badge.badge_id =
            source_badge.badge_id
     );
  get diagnostics v_badges = row_count;
  delete from public.user_badges where owner_id = p_old;

  update public.telemetry_sessions as telemetry
     set owner_id = p_new,
         is_anon = false,
         submitter_binding =
           public.bp_telemetry_submitter_binding(
             telemetry.id,
             p_new
           )
   where telemetry.owner_id = p_old
      or (
        telemetry.owner_id is null
        and telemetry.is_anon is true
        and telemetry.submitter_binding =
          public.bp_telemetry_submitter_binding(
            telemetry.id,
            p_old
          )
      );
  get diagnostics v_telemetry = row_count;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'scores', v_scores,
    'badges', v_badges,
    'telemetry', v_telemetry
  );
  insert into public.anon_data_reassignments(
    source_user_id,
    target_user_id,
    result
  )
  values (p_old, p_new, v_result);
  return v_result;
end;
$$;

revoke all on function
  public.bp_0093_reassign_quarantined_anon_data(
    uuid, uuid, uuid
  )
  from public, anon, authenticated, service_role;

create or replace function
  public.complete_oauth_flow_intent_migration_without_transfer(
    p_flow_id uuid,
    p_target_user_id uuid,
    p_target_session_id uuid,
    p_source_user_id uuid,
    p_reason text
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_source_auth_present boolean;
  v_source_is_member boolean;
  v_target_is_member boolean;
  v_has_unsupported_data boolean;
begin
  if p_flow_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_source_user_id is null
     or p_reason is null
     or p_reason not in (
       'target_already_member',
       'target_already_claimed',
       'source_already_claimed',
       'source_not_anonymous',
       'source_is_member',
       'unexpected_source_data',
       'source_generation_changed',
       'source_already_absent'
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_migration_without_transfer'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_not_completable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found
     or v_row.state <> 'completed'
     or v_row.action <> 'continue'
     or v_row.released_at is null
     or v_row.revoke_confirmed_at is not null
     or not v_row.source_is_anonymous
     or v_row.source_user_id <> p_source_user_id
     or v_row.target_user_id <> p_target_user_id
     or v_row.target_session_id <> p_target_session_id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_not_completable'
    );
  end if;

  select *
    into v_cleanup
    from public.oauth_anon_auth_cleanup_jobs
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_not_completable'
    );
  end if;

  -- The committed receipt is the terminal authority. An ACK-loss retry must
  -- not be made dependent on the continued existence of the target session.
  -- The exact flow/user/session tuple above plus permanent principal/session
  -- tombstones makes this replay generation-safe.
  if v_row.migration_consumed_at is not null then
    if pg_catalog.jsonb_typeof(v_row.migration_result) = 'object'
       and v_row.migration_result ?& array['ok', 'skipped']
       and v_row.migration_result - array['ok', 'skipped'] =
         '{}'::jsonb
       and v_row.migration_result->'ok'
         is not distinct from 'true'::jsonb
       and v_row.migration_result->>'skipped' = p_reason
       and (
         (
           p_reason in (
             'target_already_member',
             'target_already_claimed'
           )
           and v_cleanup.status in ('quarantined', 'scrubbed')
         )
         or (
           p_reason in (
             'source_not_anonymous',
             'source_is_member',
             'unexpected_source_data',
             'source_generation_changed'
           )
           and v_cleanup.status = 'blocked'
           and v_cleanup.last_error = p_reason
         )
         or (
           p_reason in (
             'source_already_claimed',
             'source_already_absent'
           )
           and v_cleanup.status = 'completed'
         )
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'flowId', v_row.flow_id,
        'alreadyConsumed', true,
        'migrationConsumedAt', v_row.migration_consumed_at,
        'migrationResult', v_row.migration_result
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_already_transferred'
    );
  end if;

  -- Ownership/member advisory locks precede every Auth tuple lock throughout
  -- account lifecycle code. The durable cleanup job was locked above.
  perform public.bp_0084_anon_reassign_locks(
    v_row.source_user_id,
    v_row.target_user_id
  );
  perform public.bp_user_mutation_lock_many(
    array[v_row.source_user_id, v_row.target_user_id]
  );

  -- Match the Auth fence's inherent tuple-lock order, then take the source
  -- advisory fence. An absent UUID is re-read after the advisory lock.
  perform 1
    from auth.users as auth_user
   where auth_user.id in (
     v_row.source_user_id,
     v_row.target_user_id
   )
   order by auth_user.id
   for update of auth_user;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' ||
      v_row.source_user_id::text,
      0
    )
  );

  if (
    p_reason in (
      'target_already_member',
      'target_already_claimed',
      'source_already_claimed',
      'source_already_absent'
    )
    and v_cleanup.status not in ('dormant', 'quarantined')
  )
  or (
    p_reason not in (
      'target_already_member',
      'target_already_claimed',
      'source_already_claimed',
      'source_already_absent'
    )
    and v_cleanup.status <> 'dormant'
  ) then
    raise exception 'oauth_anon_auth_cleanup_receipt_invalid'
      using errcode = 'P0001';
  end if;

  select source_user.created_at,
         source_user.instance_id,
         source_user.is_anonymous
    into v_source_auth_created_at,
         v_source_auth_instance_id,
         v_source_auth_is_anonymous
    from auth.users as source_user
   where source_user.id = v_row.source_user_id
   for update of source_user;
  v_source_auth_present := found;

  select exists(
           select 1
             from public.member_accounts as source_member
            where source_member.user_id = v_row.source_user_id
         )
    into v_source_is_member;
  select exists(
           select 1
             from public.member_accounts as target_member
            where target_member.user_id = v_row.target_user_id
         )
    into v_target_is_member;
  select exists(
           select 1
             from public.dolls
            where owner_id = v_row.source_user_id
         )
         or exists(
           select 1
             from public.orders
            where user_id = v_row.source_user_id
         )
         or exists(
           select 1
             from public.ai_generations
            where owner_id = v_row.source_user_id
         )
    into v_has_unsupported_data;

  v_now := pg_catalog.clock_timestamp();

  if not (
    (
      p_reason = 'target_already_member'
      and v_target_is_member
      and not v_source_is_member
      and not v_has_unsupported_data
      and v_source_auth_present
      and v_source_auth_is_anonymous is true
      and v_source_auth_created_at =
        v_cleanup.source_auth_created_at
      and v_source_auth_instance_id is not distinct from
        v_cleanup.source_auth_instance_id
    )
    or (
      p_reason = 'target_already_claimed'
      and exists (
        select 1
          from public.anon_data_reassignments as receipt
         where receipt.target_user_id = v_row.target_user_id
           and receipt.source_user_id <>
             v_row.source_user_id
      )
      and not v_source_is_member
      and not v_has_unsupported_data
      and v_source_auth_present
      and v_source_auth_is_anonymous is true
      and v_source_auth_created_at =
        v_cleanup.source_auth_created_at
      and v_source_auth_instance_id is not distinct from
        v_cleanup.source_auth_instance_id
    )
    or (
      p_reason = 'source_already_claimed'
      and exists (
        select 1
          from public.anon_data_reassignments as receipt
         where receipt.source_user_id = v_row.source_user_id
           and receipt.target_user_id <>
             v_row.target_user_id
      )
    )
    or (
      p_reason = 'source_not_anonymous'
      and v_source_auth_present
      and v_source_auth_is_anonymous is distinct from true
    )
    or (
      p_reason = 'source_is_member'
      and v_source_is_member
    )
    or (
      p_reason = 'unexpected_source_data'
      and v_has_unsupported_data
    )
    or (
      p_reason = 'source_generation_changed'
      and v_source_auth_present
      and (
        v_source_auth_created_at
          is distinct from v_cleanup.source_auth_created_at
        or v_source_auth_instance_id
          is distinct from v_cleanup.source_auth_instance_id
      )
    )
    or (
      p_reason = 'source_already_absent'
      and not v_source_auth_present
      and not exists (
        select 1
          from public.anon_data_reassignments as receipt
          where receipt.source_user_id = v_row.source_user_id
      )
    )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_skip_reason_not_proven'
    );
  end if;

  update public.oauth_flow_intents
     set migration_consumed_at = greatest(
           v_now,
           v_row.finished_at
         ),
         migration_result = pg_catalog.jsonb_build_object(
           'ok', true,
           'skipped', p_reason
         )
   where flow_id = p_flow_id
  returning * into v_row;

  if p_reason in (
    'target_already_member',
    'target_already_claimed'
  ) then
    -- Transfer is terminally inapplicable. Hide the anonymous source now and
    -- keep the correlation through the same recovery/scrub deadline. The
    -- profile only carries a service-generated random nickname (no PII), so
    -- keep the display fields (2026-08-21 — 랭킹 '탈퇴한 사용자' 오표기 방지).
    update public.profiles
       set deleted_at = v_now
     where id = v_row.source_user_id
       and deleted_at is null;
    if not exists (
      select 1
        from public.profiles as source_profile
       where source_profile.id = v_row.source_user_id
         and source_profile.deleted_at is not null
    ) then
      raise exception 'oauth_flow_quarantine_profile_failed'
        using errcode = 'P0001';
    end if;
    with quarantined_highlight as (
      update public.score_highlights as highlight
         set highlight_deleted_at = v_now
        from public.scores as score
       where highlight.score_id = score.id
         and score.owner_id = v_row.source_user_id
         and highlight.highlight_deleted_at is null
      returning highlight.score_id, highlight.highlight_deleted_at
    )
    insert into public.oauth_quarantined_score_highlights(
      score_id,
      flow_id,
      quarantined_at
    )
    select quarantined_highlight.score_id,
           v_row.flow_id,
           quarantined_highlight.highlight_deleted_at
      from quarantined_highlight;
    delete from auth.sessions
     where user_id = v_row.source_user_id;
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'quarantined',
           quarantine_reason = p_reason,
           quarantined_at = coalesce(quarantined_at, v_now),
           access_revoked_at =
             coalesce(access_revoked_at, v_now)
     where flow_id = p_flow_id
       and source_user_id = p_source_user_id
       and status in ('dormant', 'quarantined')
    returning * into v_cleanup;
  elsif p_reason in (
    'source_not_anonymous',
    'source_is_member',
    'unexpected_source_data',
    'source_generation_changed'
  ) then
    -- These facts may describe an independently valuable source principal.
    -- Preserve it and make the unresolved privacy work operationally visible.
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'blocked',
           quarantine_reason = 'migration_blocked',
           quarantined_at = v_now,
           last_error = p_reason
     where flow_id = p_flow_id
       and source_user_id = p_source_user_id
       and status = 'dormant'
    returning * into v_cleanup;
  elsif p_reason in (
    'source_already_claimed',
    'source_already_absent'
  ) then
    -- A quarantined source stays hidden and access-revoked, but its terminal
    -- no-transfer flow no longer owns a recoverable highlight transition.
    delete from public.oauth_quarantined_score_highlights
     where flow_id = p_flow_id;
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'completed',
           armed_at = greatest(v_now, created_at),
           next_attempt_at = null,
           lease_token = null,
           lease_expires_at = null,
           finished_at = greatest(v_now, created_at),
           last_error = null
     where flow_id = p_flow_id
       and source_user_id = p_source_user_id
       and status in ('dormant', 'quarantined')
    returning * into v_cleanup;
  else
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'protected',
           armed_at = greatest(v_now, created_at),
           finished_at = greatest(v_now, created_at),
           last_error = 'migration_not_applicable'
     where flow_id = p_flow_id
       and source_user_id = p_source_user_id
       and status = 'dormant'
    returning * into v_cleanup;
  end if;
  if not found then
    raise exception 'oauth_anon_auth_cleanup_skip_failed'
      using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'alreadyConsumed', false,
    'migrationConsumedAt', v_row.migration_consumed_at,
    'migrationResult', v_row.migration_result
  );
end;
$$;

create or replace function
  public.bp_0093_consume_oauth_flow_intent_migration_impl(
  p_flow_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_source_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_row public.oauth_flow_intents%rowtype;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_result jsonb;
  v_already_consumed boolean;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_source_auth_present boolean;
  v_skip_reason text;
  v_observed_target_session_created_at timestamptz;
  v_target_profile_deleted boolean;
begin
  if p_flow_id is null
     or p_target_user_id is null
     or p_target_session_id is null
     or p_source_user_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_migration'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow:' || p_flow_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_not_consumable'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-flow-source-session:' ||
      v_row.source_session_id::text,
      0
    )
  );

  select *
    into v_row
    from public.oauth_flow_intents
   where flow_id = p_flow_id
   for update;

  if not found
     or v_row.state <> 'completed'
     or v_row.action <> 'continue'
     or v_row.released_at is null
     or v_row.revoke_confirmed_at is not null
     or not v_row.source_is_anonymous
     or v_row.source_user_id <> p_source_user_id
     or v_row.target_user_id <> p_target_user_id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_not_consumable'
    );
  end if;

  select *
    into v_cleanup
    from public.oauth_anon_auth_cleanup_jobs
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_migration_not_consumable'
    );
  end if;

  -- A durable receipt is returned before consulting live target authority.
  -- This is the response-loss convergence path: target revocation after the
  -- commit cannot hide an already completed transfer/no-transfer decision.
  v_already_consumed := v_row.migration_consumed_at is not null;
  if v_already_consumed then
    if pg_catalog.jsonb_typeof(v_row.migration_result) <> 'object' then
      raise exception 'oauth_flow_migration_receipt_invalid'
        using errcode = 'P0001';
    end if;
    if v_row.migration_result ?& array['ok', 'skipped']
       and v_row.migration_result - array['ok', 'skipped'] =
         '{}'::jsonb then
      if not (
        (
          v_row.migration_result->>'skipped' in (
            'target_already_member',
            'target_already_claimed'
          )
          and v_cleanup.status in ('quarantined', 'scrubbed')
        )
        or (
          v_row.migration_result->>'skipped' in (
            'source_not_anonymous',
            'source_is_member',
            'unexpected_source_data',
            'source_generation_changed'
          )
          and v_cleanup.status = 'blocked'
          and v_cleanup.last_error =
            v_row.migration_result->>'skipped'
        )
        or (
          v_row.migration_result->>'skipped' in (
            'target_withdrawn',
            'recovery_expired'
          )
          and v_cleanup.status = 'scrubbed'
        )
        or (
          v_row.migration_result->>'skipped' in (
            'source_already_claimed',
            'source_already_absent'
          )
          and v_cleanup.status = 'completed'
        )
      ) then
        raise exception 'oauth_anon_auth_cleanup_receipt_invalid'
          using errcode = 'P0001';
      end if;
    elsif v_row.migration_result ?& array[
      'ok',
      'scores',
      'badges',
      'telemetry'
    ] then
      if v_cleanup.status = 'dormant'
         or (
           v_cleanup.status = 'protected'
           and v_cleanup.last_error = 'migration_not_applicable'
         ) then
        raise exception 'oauth_anon_auth_cleanup_receipt_invalid'
          using errcode = 'P0001';
      end if;
    else
      raise exception 'oauth_flow_migration_receipt_invalid'
        using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'flowId', v_row.flow_id,
      'alreadyConsumed', true,
      'migrationConsumedAt', v_row.migration_consumed_at,
      'migrationResult', v_row.migration_result
    );
  end if;

  perform public.bp_0084_anon_reassign_locks(
    v_row.source_user_id,
    v_row.target_user_id
  );
  perform public.bp_user_mutation_lock_many(
    array[v_row.source_user_id, v_row.target_user_id]
  );

  select target_session.created_at
    into v_observed_target_session_created_at
    from auth.sessions as target_session
   where target_session.id = p_target_session_id
     and target_session.user_id = v_row.target_user_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_session_unverified'
    );
  end if;
  if not public.bp_0093_oauth_target_generation_matches(
    v_row.source_user_id,
    v_row.target_user_id,
    p_target_session_id,
    v_row.target_auth_created_at,
    v_row.target_auth_instance_id,
    v_observed_target_session_created_at
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_generation_changed'
    );
  end if;
  select target_profile.deleted_at is not null
    into v_target_profile_deleted
    from public.profiles as target_profile
   where target_profile.id = v_row.target_user_id
   for update of target_profile;
  if not found or coalesce(v_target_profile_deleted, true) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_flow_target_withdrawn'
    );
  end if;

  -- Auth UPDATE triggers own an existing tuple before entering the advisory
  -- fence. Keep the global order job row -> Auth row -> source advisory.
  -- An absent UUID is covered by the second read under the advisory fence.
  perform 1
    from auth.users as source_user
   where source_user.id = v_row.source_user_id
   for update of source_user;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' ||
      v_row.source_user_id::text,
      0
    )
  );

  if not v_already_consumed then
    v_now := pg_catalog.clock_timestamp();
    if v_cleanup.status not in ('dormant', 'quarantined')
       or v_cleanup.recover_until is null
       or v_now > v_cleanup.recover_until
       or (
         v_cleanup.status = 'quarantined'
         and (
           v_cleanup.quarantine_reason <>
             'target_session_missing'
         )
       ) then
      raise exception 'oauth_anon_auth_cleanup_receipt_invalid'
        using errcode = 'P0001';
    end if;

    select source_user.created_at,
           source_user.instance_id,
           source_user.is_anonymous
      into v_source_auth_created_at,
           v_source_auth_instance_id,
           v_source_auth_is_anonymous
      from auth.users as source_user
     where source_user.id = v_row.source_user_id
     for update of source_user;
    v_source_auth_present := found;

    if v_source_auth_present
       and v_source_auth_is_anonymous is distinct from true then
      v_skip_reason := 'source_not_anonymous';
    elsif v_source_auth_present
       and (
         v_source_auth_created_at
           is distinct from v_cleanup.source_auth_created_at
         or v_source_auth_instance_id
           is distinct from v_cleanup.source_auth_instance_id
       ) then
      v_skip_reason := 'source_generation_changed';
    elsif exists (
      select 1
        from public.anon_data_reassignments as receipt
       where receipt.source_user_id = v_row.source_user_id
         and receipt.target_user_id <> v_row.target_user_id
    ) then
      v_skip_reason := 'source_already_claimed';
    elsif not v_source_auth_present
       and not exists (
         select 1
           from public.anon_data_reassignments as receipt
          where receipt.source_user_id = v_row.source_user_id
       ) then
      v_skip_reason := 'source_already_absent';
    elsif exists (
      select 1
        from public.member_accounts as source_member
       where source_member.user_id = v_row.source_user_id
    ) then
      v_skip_reason := 'source_is_member';
    elsif exists (
      select 1
        from public.dolls
       where owner_id = v_row.source_user_id
    )
    or exists (
      select 1
        from public.orders
       where user_id = v_row.source_user_id
    )
    or exists (
      select 1
        from public.ai_generations
       where owner_id = v_row.source_user_id
    ) then
      v_skip_reason := 'unexpected_source_data';
    elsif exists (
      select 1
        from public.anon_data_reassignments as receipt
       where receipt.target_user_id = v_row.target_user_id
         and receipt.source_user_id <> v_row.source_user_id
    ) then
      v_skip_reason := 'target_already_claimed';
    elsif exists (
      select 1
        from public.member_accounts as target_member
       where target_member.user_id = v_row.target_user_id
    ) then
      v_skip_reason := 'target_already_member';
    end if;

    if v_skip_reason is not null then
      if v_cleanup.status = 'quarantined'
         and v_skip_reason in (
           'source_not_anonymous',
           'source_generation_changed',
           'source_is_member',
           'unexpected_source_data'
         ) then
        update public.oauth_anon_auth_cleanup_jobs
           set status = 'blocked',
               quarantine_reason = 'migration_blocked',
               last_error = v_skip_reason
         where cleanup_id = v_cleanup.cleanup_id
           and status = 'quarantined';
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'error', 'oauth_flow_migration_blocked'
        );
      end if;
      return
        public.complete_oauth_flow_intent_migration_without_transfer(
          p_flow_id,
          p_target_user_id,
          v_row.target_session_id,
          p_source_user_id,
          v_skip_reason
        );
    end if;

    if v_cleanup.status = 'quarantined' then
      v_result :=
        public.bp_0093_reassign_quarantined_anon_data(
          v_row.flow_id,
          v_row.source_user_id,
          v_row.target_user_id
        );
    else
      v_result := public.bp_0084_reassign_anon_data_impl(
        v_row.source_user_id,
        v_row.target_user_id
      );
    end if;
    if v_result is null
       or pg_catalog.jsonb_typeof(v_result) <> 'object'
       or v_result ?& array[
         'ok',
         'scores',
         'badges',
         'telemetry'
       ] is not true
       or v_result - array[
         'ok',
         'scores',
         'badges',
         'telemetry'
       ] <> '{}'::jsonb
       or v_result->'ok' is distinct from 'true'::jsonb
       or pg_catalog.jsonb_typeof(v_result->'scores') <> 'number'
       or pg_catalog.jsonb_typeof(v_result->'badges') <> 'number'
       or pg_catalog.jsonb_typeof(v_result->'telemetry') <> 'number'
       or v_result->>'scores' !~ '^(0|[1-9][0-9]{0,9})$'
       or v_result->>'badges' !~ '^(0|[1-9][0-9]{0,9})$'
       or v_result->>'telemetry' !~ '^(0|[1-9][0-9]{0,9})$'
       or (
         pg_catalog.length(v_result->>'scores') = 10
         and v_result->>'scores' > '2147483647'
       )
       or (
         pg_catalog.length(v_result->>'badges') = 10
         and v_result->>'badges' > '2147483647'
       )
       or (
         pg_catalog.length(v_result->>'telemetry') = 10
         and v_result->>'telemetry' > '2147483647'
       ) then
      raise exception 'oauth_flow_migration_result_invalid'
        using errcode = 'P0001';
    end if;
    v_now := pg_catalog.clock_timestamp();
    update public.oauth_flow_intents
       set migration_consumed_at = greatest(
             v_now,
             v_row.finished_at
           ),
           migration_result = v_result
     where flow_id = p_flow_id
    returning * into v_row;

    update public.oauth_anon_auth_cleanup_jobs
       set status = 'pending',
           armed_at = greatest(
             v_now,
             created_at
           ),
           next_attempt_at = greatest(
             v_now,
             created_at
           )
     where flow_id = p_flow_id
       and status in ('dormant', 'quarantined')
    returning * into v_cleanup;
    if not found then
      raise exception 'oauth_anon_auth_cleanup_arm_failed'
        using errcode = 'P0001';
    end if;
  else
    if v_cleanup.status = 'dormant' then
      raise exception 'oauth_anon_auth_cleanup_receipt_invalid'
        using errcode = 'P0001';
    end if;
    v_result := v_row.migration_result;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'flowId', v_row.flow_id,
    'alreadyConsumed', v_already_consumed,
    'migrationConsumedAt', v_row.migration_consumed_at,
    'migrationResult', v_result
  );
end;
$$;

revoke all on function
  public.bp_0093_consume_oauth_flow_intent_migration_impl(
    uuid, uuid, uuid, uuid
  )
  from public, anon, authenticated, service_role;

create or replace function public.consume_oauth_flow_intent_migration(
  p_flow_id uuid,
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_source_user_id uuid,
  p_access_token_sha256 text,
  p_refresh_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_target_session_created_at timestamptz;
  v_cleanup public.oauth_anon_auth_cleanup_jobs%rowtype;
begin
  if p_access_token_sha256 is null
     or p_access_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_refresh_token_sha256 is null
     or p_refresh_token_sha256 !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_flow_migration'
    );
  end if;

  v_result :=
    public.bp_0093_consume_oauth_flow_intent_migration_impl(
      p_flow_id,
      p_target_user_id,
      p_target_session_id,
      p_source_user_id
    );
  if v_result is null
     or pg_catalog.jsonb_typeof(v_result) <> 'object'
     or v_result->'ok' is null then
    raise exception 'oauth_flow_migration_result_invalid'
      using errcode = 'P0001';
  end if;
  if v_result->'ok' is distinct from 'true'::jsonb
     or v_result->'alreadyConsumed'
       is not distinct from 'true'::jsonb then
    return v_result;
  end if;
  if v_result->'alreadyConsumed'
       is distinct from 'false'::jsonb then
    raise exception 'oauth_flow_migration_result_invalid'
      using errcode = 'P0001';
  end if;

  select target_session.created_at
    into v_target_session_created_at
    from auth.sessions as target_session
   where target_session.id = p_target_session_id
     and target_session.user_id = p_target_user_id
   for update of target_session;
  if not found then
    raise exception 'oauth_flow_consumed_target_session_missing'
      using errcode = 'P0001';
  end if;

  update public.oauth_anon_auth_cleanup_jobs
     set consumed_target_session_id = p_target_session_id,
         consumed_target_session_created_at =
           v_target_session_created_at,
         consumed_access_token_sha256 =
           p_access_token_sha256,
         consumed_refresh_token_sha256 =
           p_refresh_token_sha256
   where flow_id = p_flow_id
     and source_user_id = p_source_user_id
     and consumed_target_session_id is null
  returning * into v_cleanup;
  if not found then
    select *
      into v_cleanup
      from public.oauth_anon_auth_cleanup_jobs
     where flow_id = p_flow_id
       and source_user_id = p_source_user_id
     for update;
    if not found
       or v_cleanup.consumed_target_session_id <>
         p_target_session_id
       or v_cleanup.consumed_target_session_created_at <>
         v_target_session_created_at
       or v_cleanup.consumed_access_token_sha256 <>
         p_access_token_sha256
       or v_cleanup.consumed_refresh_token_sha256 <>
         p_refresh_token_sha256 then
      raise exception 'oauth_flow_consumed_authority_conflict'
        using errcode = 'P0001';
    end if;
  end if;
  return v_result;
end;
$$;

create or replace function public.claim_oauth_anon_auth_cleanup(
  p_lease_token uuid,
  p_lease_seconds integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_job public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_pending_backlog integer;
begin
  if p_lease_token is null
     or p_lease_seconds is null
     or p_lease_seconds < 5
     or p_lease_seconds > 60 then
    raise exception 'invalid_oauth_anon_auth_cleanup_claim'
      using errcode = 'P0001';
  end if;

  -- Integer counters are deliberately bounded. A worker that loses its
  -- process after claiming the final representable lease must not leave an
  -- unclaimable leased row forever, and an older pending row already at the
  -- bound must be made explicit as well. This is a terminal, monitored safety
  -- stop: the source Auth principal is retained rather than deleted without a
  -- valid lease.
  update public.oauth_anon_auth_cleanup_jobs
     set status = 'protected',
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = null,
         last_error = 'cleanup_attempt_limit_exhausted',
         finished_at = greatest(v_now, armed_at)
   where lease_version = 2147483647
     and (
       status = 'pending'
       or (
         status = 'leased'
         and lease_expires_at <= v_now
       )
     );

  select *
    into v_job
    from public.oauth_anon_auth_cleanup_jobs
   where (
       (
         status = 'pending'
         and next_attempt_at <= v_now
       )
       or (
         status = 'leased'
         and lease_expires_at <= v_now
       )
     )
     and lease_version < 2147483647
   order by next_attempt_at, created_at, cleanup_id
   for update skip locked
   limit 1;

  if not found then
    select least(
             pg_catalog.count(*),
             2147483647::bigint
           )::integer
      into v_pending_backlog
      from public.oauth_anon_auth_cleanup_jobs
     where status in ('pending', 'leased');
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idle', true,
      'pendingBacklog', v_pending_backlog
    );
  end if;

  update public.oauth_anon_auth_cleanup_jobs
     set status = 'leased',
         lease_token = p_lease_token,
         lease_version = lease_version + 1,
         attempt_count = attempt_count + 1,
         lease_expires_at =
           v_now + p_lease_seconds * interval '1 second'
   where cleanup_id = v_job.cleanup_id
  returning * into v_job;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'cleanupId', v_job.cleanup_id,
    'sourceUserId', v_job.source_user_id,
    'sourceAuthCreatedAt', v_job.source_auth_created_at,
    'leaseToken', v_job.lease_token,
    'leaseVersion', v_job.lease_version,
    'attemptCount', v_job.attempt_count
  );
end;
$$;

create or replace function
  public.verify_oauth_anon_auth_cleanup_source(
    p_cleanup_id uuid,
    p_lease_token uuid,
    p_lease_version integer
  )
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
begin
  if p_cleanup_id is null
     or p_lease_token is null
     or p_lease_version is null
     or p_lease_version < 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_anon_auth_cleanup_verify'
    );
  end if;

  -- Claim/finish serialize on the job row. Take that row first, then any
  -- existing Auth tuple, matching consume and avoiding Auth-row/advisory
  -- inversion with BEFORE UPDATE triggers.
  select *
    into v_job
    from public.oauth_anon_auth_cleanup_jobs
   where cleanup_id = p_cleanup_id
     and status = 'leased'
     and lease_token = p_lease_token
     and lease_version = p_lease_version
   for share;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_anon_auth_cleanup_lease_conflict'
    );
  end if;

  perform 1
    from auth.users as source_user
   where source_user.id = v_job.source_user_id
   for share of source_user;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' ||
      v_job.source_user_id::text,
      0
    )
  );

  -- Re-read under the advisory fence because the UUID may have been absent
  -- during the first row-locking read and concurrently inserted.
  select source_user.created_at,
         source_user.instance_id,
         source_user.is_anonymous
    into v_source_auth_created_at,
         v_source_auth_instance_id,
         v_source_auth_is_anonymous
    from auth.users as source_user
   where source_user.id = v_job.source_user_id
   for share of source_user;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'cleanupId', v_job.cleanup_id,
      'state', 'absent'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'cleanupId', v_job.cleanup_id,
    'state', case
      when v_source_auth_is_anonymous is true
       and v_source_auth_created_at =
         v_job.source_auth_created_at
       and v_source_auth_instance_id
         is not distinct from
           v_job.source_auth_instance_id
      then 'deletable'
      else 'protected'
    end
  );
end;
$$;

create or replace function public.finish_oauth_anon_auth_cleanup(
  p_cleanup_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_outcome text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_job public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_source_auth_created_at timestamptz;
  v_source_auth_instance_id uuid;
  v_source_auth_is_anonymous boolean;
  v_source_auth_present boolean;
  v_delay_seconds integer;
begin
  if p_cleanup_id is null
     or p_lease_token is null
     or p_lease_version is null
     or p_lease_version < 1
     or p_outcome is null
     or p_outcome not in (
       'completed',
       'protected',
       'pending'
     )
     or (
       p_outcome = 'completed'
       and p_error is not null
     )
     or (
       p_outcome = 'protected'
       and p_error is distinct from
         'source_generation_changed'
     )
     or (
       p_outcome = 'pending'
       and (
         p_error is null
         or pg_catalog.length(p_error) not between 1 and 160
         or p_error ~ '[[:cntrl:]]'
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'invalid_oauth_anon_auth_cleanup_finish'
    );
  end if;

  select *
    into v_job
    from public.oauth_anon_auth_cleanup_jobs
   where cleanup_id = p_cleanup_id
     and status = 'leased'
     and lease_token = p_lease_token
     and lease_version = p_lease_version
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'oauth_anon_auth_cleanup_lease_conflict'
    );
  end if;

  if p_outcome in ('completed', 'protected') then
    perform 1
      from auth.users as source_user
     where source_user.id = v_job.source_user_id
     for share of source_user;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'oauth-anon-auth-cleanup:' ||
      v_job.source_user_id::text,
      0
    )
  );

  if p_outcome in ('completed', 'protected') then
    select source_user.created_at,
           source_user.instance_id,
           source_user.is_anonymous
      into v_source_auth_created_at,
           v_source_auth_instance_id,
           v_source_auth_is_anonymous
      from auth.users as source_user
     where source_user.id = v_job.source_user_id
     for share of source_user;
    v_source_auth_present := found;

    if p_outcome = 'completed'
       and v_source_auth_present then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_anon_auth_cleanup_outcome_mismatch'
      );
    end if;
    if p_outcome = 'protected'
       and (
         not v_source_auth_present
         or (
           v_source_auth_is_anonymous is true
           and v_source_auth_created_at =
             v_job.source_auth_created_at
           and v_source_auth_instance_id
             is not distinct from
               v_job.source_auth_instance_id
         )
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'oauth_anon_auth_cleanup_outcome_mismatch'
      );
    end if;
  end if;

  v_now := pg_catalog.clock_timestamp();
  if p_outcome = 'pending'
     and v_job.attempt_count = 2147483647 then
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'protected',
           lease_token = null,
           lease_expires_at = null,
           next_attempt_at = null,
           last_error = 'cleanup_attempt_limit_exhausted',
           finished_at = greatest(
             v_now,
             armed_at
           )
     where cleanup_id = p_cleanup_id
    returning * into v_job;
  elsif p_outcome = 'pending' then
    v_delay_seconds := least(
      3600,
      (
        5 * pg_catalog.power(
          2::numeric,
          least(
            greatest(
              v_job.attempt_count - 1,
              0
            ),
            9
          )
        )
      )::integer
    );
    update public.oauth_anon_auth_cleanup_jobs
       set status = 'pending',
           lease_token = null,
           lease_expires_at = null,
           next_attempt_at =
             v_now + v_delay_seconds * interval '1 second',
           last_error = p_error
     where cleanup_id = p_cleanup_id
    returning * into v_job;
  else
    update public.oauth_anon_auth_cleanup_jobs
       set status = p_outcome,
           lease_token = null,
           lease_expires_at = null,
           next_attempt_at = null,
           last_error = case
             when p_outcome = 'protected'
             then 'source_generation_changed'
             else null
           end,
           finished_at = greatest(
             v_now,
             armed_at
           )
     where cleanup_id = p_cleanup_id
    returning * into v_job;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'cleanupId', v_job.cleanup_id,
    'status', v_job.status,
    'leaseVersion', v_job.lease_version,
    'nextAttemptAt', v_job.next_attempt_at
  );
end;
$$;

create or replace function public.prune_oauth_flow_intents(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_candidate record;
  v_bound_recovery_result jsonb;
  v_target_loss_result jsonb;
  v_privacy_job public.oauth_anon_auth_cleanup_jobs%rowtype;
  v_target_profile_deleted boolean;
  v_target_loss_flow_ids uuid[] := array[]::uuid[];
  v_target_loss_source_user_ids uuid[] := array[]::uuid[];
  v_target_loss_target_user_ids uuid[] := array[]::uuid[];
  v_target_loss_target_session_ids uuid[] := array[]::uuid[];
  v_lock_user_id uuid;
  v_lock_session_id uuid;
  v_changed integer;
  v_expired integer := 0;
  v_bound_recovery_converged integer := 0;
  v_pruned integer := 0;
  v_target_loss_converged integer := 0;
  v_target_loss_backlog integer := 0;
  v_backlog integer := 0;
  v_terminal_retention_backlog integer := 0;
  v_migration_backlog integer := 0;
  v_unreleased_backlog integer := 0;
  v_unbound_claim_backlog integer := 0;
  v_bound_recovery_backlog integer := 0;
  v_expiry_admitted integer := 0;
  v_bound_recovery_admitted integer := 0;
  v_target_loss_admitted integer := 0;
  v_terminal_prune_admitted integer := 0;
begin
  if p_limit is null
     or p_limit < 1
     or p_limit > 500 then
    raise exception 'invalid_oauth_flow_prune_limit';
  end if;

  -- A single prune call can retain many per-flow locks. Serialize prune
  -- invocations, then pre-acquire the complete candidate lock set below
  -- before touching any downstream user/Auth lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('oauth-flow-prune', 0)
  );

  for v_candidate in
    select flow_id, source_session_id
      from public.oauth_flow_intents
     where (
         state = 'pending'
         or (
           state = 'claimed'
           and target_session_id is null
         )
       )
       and expires_at <= v_now
     order by expires_at, flow_id
  loop
    exit when v_expiry_admitted >= p_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow:' || v_candidate.flow_id::text,
        0
      )
    ) then
      continue;
    end if;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-source-session:' ||
        v_candidate.source_session_id::text,
        0
      )
    ) then
      continue;
    end if;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-observed-session:' ||
        v_candidate.source_session_id::text,
        0
      )
    ) then
      continue;
    end if;
    v_expiry_admitted := v_expiry_admitted + 1;
    update public.oauth_flow_intents
       set state = 'expired',
           finished_at = greatest(v_now, expires_at)
     where flow_id = v_candidate.flow_id
       and (
         state = 'pending'
         or (
           state = 'claimed'
           and target_session_id is null
         )
       )
       and expires_at <= v_now;
    get diagnostics v_changed = row_count;
    v_expired := v_expired + v_changed;
    if v_changed = 1 then
      update public.oauth_anon_auth_cleanup_jobs
         set status = 'completed',
             armed_at = greatest(v_now, created_at),
             finished_at = greatest(v_now, created_at),
             next_attempt_at = null,
             last_error = null
       where flow_id = v_candidate.flow_id
         and status = 'dormant';
    end if;
  end loop;

  -- Binding/finalization and sign-out completion are separate durable HTTP
  -- commits. A process can disappear between them. After a five-minute grace
  -- beyond both the original lease and captured target-session creation,
  -- revoke the exact bound session (or prove it absent) and terminalize the
  -- ledger. Identity conflicts remain visible instead of becoming success.
  for v_candidate in
    select flow_id,
           source_user_id,
           source_session_id,
           provider
      from public.oauth_flow_intents
     where (
         (
           state = 'claimed'
           and target_session_id is not null
         )
         or state in ('signout_required', 'signout_revoked')
       )
       and greatest(
         expires_at + interval '5 minutes',
         target_session_created_at + interval '5 minutes'
       ) <= v_now
     order by greatest(
                expires_at + interval '5 minutes',
                target_session_created_at + interval '5 minutes'
              ),
              flow_id
  loop
    exit when v_bound_recovery_admitted >= p_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow:' || v_candidate.flow_id::text,
        0
      )
    ) then
      continue;
    end if;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-source-session:' ||
        v_candidate.source_session_id::text,
        0
      )
    ) then
      continue;
    end if;
    v_bound_recovery_admitted :=
      v_bound_recovery_admitted + 1;
    v_bound_recovery_result :=
      public.revoke_bound_oauth_flow_target_session(
        v_candidate.flow_id,
        v_candidate.source_user_id,
        v_candidate.source_session_id,
        v_candidate.provider
      );
    if v_bound_recovery_result is null
       or pg_catalog.jsonb_typeof(v_bound_recovery_result) <>
         'object'
       or v_bound_recovery_result->'ok' is null then
      raise exception 'oauth_flow_bound_recovery_invalid'
        using errcode = 'P0001';
    end if;
    if v_bound_recovery_result->'ok'
         is not distinct from 'true'::jsonb
       and v_bound_recovery_result->>'state' in (
         'abandoned',
         'completed'
       ) then
      v_bound_recovery_converged :=
        v_bound_recovery_converged + 1;
    end if;
  end loop;

  -- Collect every due OAuth privacy transition: immediate target-profile
  -- withdrawal, strict post-proof scrub, or a missing callback-bound session
  -- after the 24-hour visibility grace. Session loss itself is recoverable and
  -- enters quarantine; it never terminalizes or deletes retained data.
  for v_candidate in
    select flow.flow_id,
           flow.source_user_id,
           flow.source_session_id,
           flow.target_user_id,
           flow.target_session_id
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        on cleanup.flow_id = flow.flow_id
       and cleanup.source_user_id = flow.source_user_id
     where flow.state = 'completed'
       and flow.action = 'continue'
       and flow.source_is_anonymous
       and flow.revoke_confirmed_at is null
       and flow.released_at is not null
       and cleanup.status in ('dormant', 'quarantined')
       and (
         not exists (
           select 1
             from public.profiles as target_profile
            where target_profile.id = flow.target_user_id
              and target_profile.deleted_at is null
         )
         or (
           cleanup.recover_until is not null
           and cleanup.recover_until < v_now
         )
         or (
           cleanup.status = 'dormant'
           and flow.migration_consumed_at is null
           and flow.released_at <=
             v_now - interval '24 hours'
           and not exists (
             select 1
               from auth.sessions as target_session
              where target_session.id =
                flow.target_session_id
                and target_session.user_id =
                  flow.target_user_id
                and target_session.created_at =
                  flow.target_session_created_at
           )
         )
       )
     order by coalesce(
                cleanup.recover_until,
                flow.released_at
              ),
              flow.flow_id
  loop
    exit when v_target_loss_admitted >= p_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow:' || v_candidate.flow_id::text,
        0
      )
    ) then
      continue;
    end if;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-source-session:' ||
        v_candidate.source_session_id::text,
        0
      )
    ) then
      continue;
    end if;
    v_target_loss_admitted := v_target_loss_admitted + 1;
    v_target_loss_flow_ids :=
      pg_catalog.array_append(
        v_target_loss_flow_ids,
        v_candidate.flow_id
      );
    v_target_loss_source_user_ids :=
      pg_catalog.array_append(
        v_target_loss_source_user_ids,
        v_candidate.source_user_id
      );
    v_target_loss_target_user_ids :=
      pg_catalog.array_append(
        v_target_loss_target_user_ids,
        v_candidate.target_user_id
      );
    v_target_loss_target_session_ids :=
      pg_catalog.array_append(
        v_target_loss_target_session_ids,
        v_candidate.target_session_id
      );
  end loop;

  if pg_catalog.cardinality(v_target_loss_flow_ids) > 0 then
    -- Pre-acquire the complete durable-job and advisory sets. 0084 defines
    -- source namespace 7401 before target namespace 7402; sort within each
    -- namespace, then take the global member locks for the union.
    perform 1
      from public.oauth_anon_auth_cleanup_jobs as cleanup
     where cleanup.flow_id =
       any(v_target_loss_flow_ids)
     order by cleanup.cleanup_id
     for update of cleanup;

    for v_lock_user_id in
      select distinct source_user_id
        from pg_catalog.unnest(
          v_target_loss_source_user_ids
        ) as source_ids(source_user_id)
       order by source_user_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        7401,
        pg_catalog.hashtext(v_lock_user_id::text)
      );
    end loop;
    for v_lock_user_id in
      select distinct target_user_id
        from pg_catalog.unnest(
          v_target_loss_target_user_ids
        ) as target_ids(target_user_id)
       order by target_user_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        7402,
        pg_catalog.hashtext(v_lock_user_id::text)
      );
    end loop;
    perform public.bp_user_mutation_lock_many(
      v_target_loss_source_user_ids ||
      v_target_loss_target_user_ids
    );

    -- Match the generation matcher globally: sorted Auth users, sorted target
    -- sessions, then sorted observed-session fences. Finally acquire every
    -- source cleanup fence, which Auth triggers also take only after owning
    -- their Auth tuple.
    perform 1
      from auth.users as auth_user
     where auth_user.id = any(
       v_target_loss_source_user_ids ||
       v_target_loss_target_user_ids
     )
     order by auth_user.id
     for update of auth_user;
    perform 1
      from auth.sessions as target_session
     where target_session.id =
       any(v_target_loss_target_session_ids)
     order by target_session.id
     for update of target_session;
    for v_lock_session_id in
      select distinct target_session_id
        from pg_catalog.unnest(
          v_target_loss_target_session_ids
        ) as target_sessions(target_session_id)
       order by target_session_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-flow-observed-session:' ||
          v_lock_session_id::text,
          0
        )
      );
    end loop;
    for v_lock_user_id in
      select distinct source_user_id
        from pg_catalog.unnest(
          v_target_loss_source_user_ids
        ) as source_ids(source_user_id)
       order by source_user_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'oauth-anon-auth-cleanup:' ||
          v_lock_user_id::text,
          0
        )
      );
    end loop;

    for v_candidate in
      select flow.flow_id,
             flow.source_user_id,
             flow.target_user_id,
             flow.target_session_id
        from public.oauth_flow_intents as flow
       where flow.flow_id = any(v_target_loss_flow_ids)
       order by flow.released_at, flow.flow_id
    loop
      select *
        into v_privacy_job
        from public.oauth_anon_auth_cleanup_jobs
       where flow_id = v_candidate.flow_id
         and source_user_id = v_candidate.source_user_id
       for update;
      if not found
         or v_privacy_job.status not in (
           'dormant',
           'quarantined'
         ) then
        continue;
      end if;
      select target_profile.deleted_at is not null
        into v_target_profile_deleted
        from public.profiles as target_profile
       where target_profile.id = v_candidate.target_user_id
       for update of target_profile;
      v_target_profile_deleted :=
        not found or coalesce(v_target_profile_deleted, true);

      if v_target_profile_deleted then
        v_target_loss_result :=
          public.bp_0093_scrub_oauth_quarantined_source(
            v_candidate.flow_id,
            'target_withdrawn'
          );
      elsif v_privacy_job.recover_until is not null
         and pg_catalog.clock_timestamp() >
           v_privacy_job.recover_until then
        v_target_loss_result :=
          public.bp_0093_scrub_oauth_quarantined_source(
            v_candidate.flow_id,
            'recovery_expired'
          );
      elsif v_privacy_job.status = 'dormant' then
        v_target_loss_result :=
          public.bp_0093_quarantine_oauth_anon_source(
            v_candidate.flow_id
          );
      else
        continue;
      end if;

      if v_target_loss_result is null
         or pg_catalog.jsonb_typeof(v_target_loss_result) <>
           'object'
         or v_target_loss_result->'ok' is null then
        raise exception 'oauth_flow_target_loss_reaper_failed: %',
          'invalid_result'
          using errcode = 'P0001';
      elsif v_target_loss_result->'ok'
           is not distinct from 'true'::jsonb then
        if v_target_loss_result->>'outcome' = 'scrubbed' then
          v_target_loss_converged :=
            v_target_loss_converged + 1;
        elsif v_target_loss_result->>'outcome' not in (
          'quarantined',
          'blocked',
          'authority_live'
        ) then
          raise exception 'oauth_flow_target_loss_reaper_failed: %',
            'invalid_outcome'
            using errcode = 'P0001';
        end if;
      elsif v_target_loss_result->>'error' in (
        'oauth_flow_quarantine_not_applicable',
        'oauth_flow_quarantine_grace_open',
        'oauth_flow_privacy_scrub_not_applicable',
        'oauth_flow_privacy_scrub_not_due'
      ) then
        null;
      else
        raise exception 'oauth_flow_target_loss_reaper_failed: %',
          coalesce(
            v_target_loss_result->>'error',
            'invalid_result'
          )
          using errcode = 'P0001';
      end if;
    end loop;
  end if;

  for v_candidate in
    select flow_id, source_session_id
      from public.oauth_flow_intents
     where state in (
       'completed',
       'failed',
       'cancelled',
       'abandoned',
       'expired'
     )
       and finished_at < v_now - interval '35 days'
       and greatest(
         finished_at,
         coalesce(migration_consumed_at, finished_at),
         coalesce(released_at, finished_at)
       ) < v_now - interval '35 days'
       and not session_fenced
       and not (
         state = 'completed'
         and action = 'continue'
         and source_is_anonymous
         and revoke_confirmed_at is null
         and migration_consumed_at is null
       )
       and not exists (
         select 1
           from public.oauth_anon_auth_cleanup_jobs as cleanup
          where cleanup.flow_id =
            oauth_flow_intents.flow_id
            and (
              cleanup.status in (
                'pending',
                'leased',
                'quarantined',
                'blocked'
              )
              or (
                cleanup.status in (
                  'completed',
                  'protected',
                  'scrubbed'
                )
                and cleanup.finished_at >=
                  v_now - interval '35 days'
              )
            )
       )
     order by finished_at, flow_id
  loop
    exit when v_terminal_prune_admitted >= p_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow:' || v_candidate.flow_id::text,
        0
      )
    ) then
      continue;
    end if;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'oauth-flow-source-session:' ||
        v_candidate.source_session_id::text,
        0
      )
    ) then
      continue;
    end if;
    v_terminal_prune_admitted :=
      v_terminal_prune_admitted + 1;
    delete from public.oauth_flow_intents
     where flow_id = v_candidate.flow_id
       and state in (
         'completed',
         'failed',
         'cancelled',
         'abandoned',
         'expired'
       )
       and finished_at < v_now - interval '35 days'
       and greatest(
         finished_at,
         coalesce(migration_consumed_at, finished_at),
         coalesce(released_at, finished_at)
       ) < v_now - interval '35 days'
       and not session_fenced
       and not (
         state = 'completed'
         and action = 'continue'
         and source_is_anonymous
         and revoke_confirmed_at is null
         and migration_consumed_at is null
       )
       and not exists (
         select 1
           from public.oauth_anon_auth_cleanup_jobs as cleanup
          where cleanup.flow_id =
            oauth_flow_intents.flow_id
            and (
              cleanup.status in (
                'pending',
                'leased',
                'quarantined',
                'blocked'
              )
              or (
                cleanup.status in (
                  'completed',
                  'protected',
                  'scrubbed'
                )
                and cleanup.finished_at >=
                  v_now - interval '35 days'
              )
            )
       );
    get diagnostics v_changed = row_count;
    v_pruned := v_pruned + v_changed;
  end loop;

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_backlog
    from public.oauth_flow_intents
   where state = 'pending'
     and expires_at <= v_now;

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_terminal_retention_backlog
    from public.oauth_flow_intents
   where state in (
     'completed',
     'failed',
     'cancelled',
     'abandoned',
     'expired'
   )
     and finished_at < v_now - interval '35 days'
     and greatest(
       finished_at,
       coalesce(migration_consumed_at, finished_at),
       coalesce(released_at, finished_at)
     ) < v_now - interval '35 days'
     and not session_fenced
     and not (
       state = 'completed'
       and action = 'continue'
       and source_is_anonymous
       and revoke_confirmed_at is null
       and migration_consumed_at is null
     )
     and not exists (
       select 1
         from public.oauth_anon_auth_cleanup_jobs as cleanup
        where cleanup.flow_id =
          oauth_flow_intents.flow_id
          and (
            cleanup.status in (
              'pending',
              'leased',
              'quarantined',
              'blocked'
            )
            or (
              cleanup.status in (
                'completed',
                'protected',
                'scrubbed'
              )
              and cleanup.finished_at >=
                v_now - interval '35 days'
            )
          )
     );

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_target_loss_backlog
    from public.oauth_flow_intents as flow
    join public.oauth_anon_auth_cleanup_jobs as cleanup
      on cleanup.flow_id = flow.flow_id
     and cleanup.source_user_id = flow.source_user_id
   where flow.state = 'completed'
     and flow.action = 'continue'
     and flow.source_is_anonymous
     and flow.revoke_confirmed_at is null
     and flow.released_at is not null
     and (
       cleanup.status = 'blocked'
       or (
         cleanup.status in ('dormant', 'quarantined')
         and (
           not exists (
             select 1
               from public.profiles as target_profile
              where target_profile.id = flow.target_user_id
                and target_profile.deleted_at is null
           )
           or (
             cleanup.recover_until is not null
             and cleanup.recover_until < v_now
           )
           or (
             cleanup.status = 'dormant'
             and flow.migration_consumed_at is null
             and flow.released_at <=
               v_now - interval '24 hours'
             and not exists (
               select 1
                 from auth.sessions as target_session
                where target_session.id =
                  flow.target_session_id
                  and target_session.user_id =
                    flow.target_user_id
                  and target_session.created_at =
                    flow.target_session_created_at
             )
           )
         )
       )
     );

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_migration_backlog
    from public.oauth_flow_intents
   where state = 'completed'
     and action = 'continue'
     and source_is_anonymous
     and revoke_confirmed_at is null
     and migration_consumed_at is null
     and finished_at <
       v_now - interval '35 days';

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_unreleased_backlog
    from public.oauth_flow_intents
   where state = 'completed'
     and action = 'continue'
     and released_at is null
     and finished_at <
       v_now - interval '35 days';

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_unbound_claim_backlog
    from public.oauth_flow_intents
   where state = 'claimed'
     and target_session_id is null
     and expires_at <= v_now;

  select least(
           pg_catalog.count(*),
           2147483647::bigint
         )::integer
    into v_bound_recovery_backlog
    from public.oauth_flow_intents
   where (
       (
         state = 'claimed'
         and target_session_id is not null
       )
       or state in ('signout_required', 'signout_revoked')
     )
     and greatest(
       expires_at + interval '5 minutes',
       target_session_created_at + interval '5 minutes'
     ) <= v_now;

  return pg_catalog.jsonb_build_object(
    'expiredPending', v_expired,
    'boundRecoveryConverged', v_bound_recovery_converged,
    'prunedTerminal', v_pruned,
    'targetAuthorityLossConverged', v_target_loss_converged,
    'targetAuthorityLossBacklog', v_target_loss_backlog,
    'pendingExpiryBacklog', v_backlog,
    'terminalRetentionBacklog', v_terminal_retention_backlog,
    'unconsumedMigrationBacklog', v_migration_backlog,
    'unreleasedContinueBacklog', v_unreleased_backlog,
    'unboundClaimBacklog', v_unbound_claim_backlog,
    'boundRecoveryBacklog', v_bound_recovery_backlog
  );
end;
$$;

create or replace function public.oauth_anon_privacy_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_cap constant bigint := 1000;
  v_open_future bigint := 0;
  v_due bigint := 0;
  v_blocked bigint := 0;
  v_failures bigint := 0;
  v_scrubbed_recent bigint := 0;
begin
  with relevant as (
    select cleanup.status,
           cleanup.quarantine_reason,
           cleanup.recover_until,
           cleanup.last_error,
           flow.migration_consumed_at,
           flow.released_at,
           (
             not exists (
               select 1
                 from public.profiles as target_profile
                where target_profile.id = flow.target_user_id
                  and target_profile.deleted_at is null
             )
             or (
               cleanup.recover_until is not null
               and cleanup.recover_until < v_now
             )
             or (
               cleanup.status = 'dormant'
               and flow.migration_consumed_at is null
               and flow.released_at <=
                 v_now - interval '24 hours'
               and not exists (
                 select 1
                   from auth.sessions as target_session
                  where target_session.id =
                    flow.target_session_id
                    and target_session.user_id =
                      flow.target_user_id
                    and target_session.created_at =
                      flow.target_session_created_at
               )
             )
           ) as due
      from public.oauth_flow_intents as flow
      join public.oauth_anon_auth_cleanup_jobs as cleanup
        on cleanup.flow_id = flow.flow_id
       and cleanup.source_user_id = flow.source_user_id
     where flow.state = 'completed'
       and flow.action = 'continue'
       and flow.source_is_anonymous
       and flow.revoke_confirmed_at is null
       and flow.released_at is not null
  )
  select count(*) filter (
           where status in ('dormant', 'quarantined')
             and not due
         ),
         count(*) filter (
           where status in ('dormant', 'quarantined')
             and due
         ),
         count(*) filter (where status = 'blocked')
    into v_open_future, v_due, v_blocked
    from relevant;

  select count(*)
    into v_failures
    from public.oauth_anon_auth_cleanup_jobs as cleanup
   where (
       cleanup.status in ('pending', 'leased')
       and cleanup.last_error is not null
     )
      or (
        cleanup.status = 'blocked'
        and cleanup.last_error = 'scrub_failed'
      )
      or (
        cleanup.status = 'protected'
        and cleanup.last_error =
          'cleanup_attempt_limit_exhausted'
      );

  select count(*)
    into v_scrubbed_recent
    from public.oauth_anon_auth_cleanup_jobs as cleanup
   where cleanup.status = 'scrubbed'
     and cleanup.scrubbed_at >= v_now - interval '26 hours';

  return pg_catalog.jsonb_build_object(
    'openFuture', least(v_open_future, v_cap)::integer,
    'due', least(v_due, v_cap)::integer,
    'blocked', least(v_blocked, v_cap)::integer,
    'failures', least(v_failures, v_cap)::integer,
    'scrubbedRecent', least(v_scrubbed_recent, v_cap)::integer,
    'capped',
      v_open_future > v_cap
      or v_due > v_cap
      or v_blocked > v_cap
      or v_failures > v_cap
      or v_scrubbed_recent > v_cap
  );
end;
$$;

revoke all on function public.oauth_anon_privacy_status()
  from public, anon, authenticated, service_role;
grant execute on function public.oauth_anon_privacy_status()
  to service_role;

revoke all on function public.begin_oauth_flow_intent(
  uuid, uuid, uuid, boolean, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_oauth_flow_intent(
  uuid, uuid, uuid, boolean, text, text, text, text
) to service_role;

revoke all on function public.claim_oauth_flow_intent(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.claim_oauth_flow_intent(
  uuid, uuid, uuid, text, text, text
) to service_role;

revoke all on function public.bind_oauth_flow_intent_target(
  uuid, uuid, uuid, text, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.bind_oauth_flow_intent_target(
  uuid, uuid, uuid, text, uuid, uuid, text, text
) to service_role;

revoke all on function public.read_oauth_flow_intent_status(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.read_oauth_flow_intent_status(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function public.recover_oauth_flow_intent_authority(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.recover_oauth_flow_intent_authority(
  uuid, uuid, uuid
) to service_role;

revoke all on function public.recover_active_oauth_flow_by_observed_session(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.recover_active_oauth_flow_by_observed_session(
  uuid, uuid
) to service_role;

revoke all on function public.verify_oauth_flow_source_session_evidence(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.verify_oauth_flow_source_session_evidence(
  uuid, uuid, uuid, text, text
) to service_role;

revoke all on function public.verify_oauth_flow_target_session_evidence(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.verify_oauth_flow_target_session_evidence(
  uuid, uuid, uuid, text, text
) to service_role;

revoke all on function public.read_oauth_flow_target_session_evidence(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.read_oauth_flow_target_session_evidence(
  uuid, uuid, uuid
) to service_role;

revoke all on function public.rotate_oauth_flow_target_session_evidence(
  uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.rotate_oauth_flow_target_session_evidence(
  uuid, uuid, uuid, text, text, text, text
) to service_role;

revoke all on function public.release_oauth_flow_intent(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.release_oauth_flow_intent(
  uuid, uuid, uuid, text, text
) to service_role;

revoke all on function public.finalize_oauth_flow_intent(
  uuid, uuid, uuid, text, text, text, uuid, uuid,
  text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_oauth_flow_intent(
  uuid, uuid, uuid, text, text, text, uuid, uuid,
  text, text, text, text
) to service_role;

revoke all on function public.confirm_oauth_flow_signout_revoke(
  uuid, uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.confirm_oauth_flow_signout_revoke(
  uuid, uuid, uuid, text, uuid, uuid
) to service_role;

revoke all on function public.complete_oauth_flow_signout(
  uuid, uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.complete_oauth_flow_signout(
  uuid, uuid, uuid, text, uuid, uuid
) to service_role;

revoke all on function public.complete_recovered_oauth_flow_signout(
  uuid
) from public, anon, authenticated, service_role;
grant execute on function public.complete_recovered_oauth_flow_signout(
  uuid
) to service_role;

revoke all on function public.cancel_oauth_flow_intent(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.cancel_oauth_flow_intent(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function public.abandon_oauth_flow_intent(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.abandon_oauth_flow_intent(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function public.revoke_bound_oauth_flow_target_session(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.revoke_bound_oauth_flow_target_session(
  uuid, uuid, uuid, text
) to service_role;

revoke all on function public.expire_oauth_flow_intent(
  uuid
) from public, anon, authenticated, service_role;
grant execute on function public.expire_oauth_flow_intent(
  uuid
) to service_role;

drop function if exists public.consume_oauth_flow_intent_migration(
  uuid, uuid, uuid, uuid
);
revoke all on function public.consume_oauth_flow_intent_migration(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.consume_oauth_flow_intent_migration(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

revoke all on function
  public.complete_oauth_flow_intent_migration_without_transfer(
    uuid, uuid, uuid, uuid, text
  )
  from public, anon, authenticated, service_role;

revoke all on function public.claim_oauth_anon_auth_cleanup(
  uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.claim_oauth_anon_auth_cleanup(
  uuid, integer
) to service_role;

revoke all on function
  public.verify_oauth_anon_auth_cleanup_source(
    uuid, uuid, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.verify_oauth_anon_auth_cleanup_source(
    uuid, uuid, integer
  )
  to service_role;

revoke all on function public.finish_oauth_anon_auth_cleanup(
  uuid, uuid, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_oauth_anon_auth_cleanup(
  uuid, uuid, integer, text, text
) to service_role;

revoke all on function public.prune_oauth_flow_intents(
  integer
) from public, anon, authenticated, service_role;
grant execute on function public.prune_oauth_flow_intents(
  integer
) to service_role;

create table public.oauth_rollout_deployment_qualifications (
  contract_version text primary key,
  expand_version text not null,
  expand_migration_hash text not null,
  expand_manifest_hash text not null,
  expand_app_commit text not null,
  deployment_app_commit text not null,
  deployment_source_tree text not null,
  provider text not null,
  provider_team_id text not null,
  provider_project_id text not null,
  provider_deployment_id text not null,
  provider_deployment_url text not null,
  production_alias text not null,
  alias_uid text not null,
  provider_function_timeout_seconds integer not null,
  deployment_created_at timestamptz not null,
  provider_ready_at timestamptz not null,
  alias_current_since timestamptz not null,
  evidence_sha256 text not null,
  qualified_at timestamptz not null
    default pg_catalog.clock_timestamp(),
  constraint oauth_rollout_qualification_versions_check
    check (
      contract_version =
        '0094_oauth_flow_migration_contract'
      and expand_version = '0093_oauth_flow_intents'
    ),
  constraint oauth_rollout_qualification_hashes_check
    check (
      expand_migration_hash ~ '^[0-9a-f]{64}$'
      and expand_manifest_hash ~ '^[0-9a-f]{64}$'
      and expand_app_commit ~ '^[0-9a-f]{40}$'
      and deployment_app_commit ~ '^[0-9a-f]{40}$'
      and deployment_source_tree ~ '^[0-9a-f]{40}$'
      and evidence_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint oauth_rollout_qualification_provider_check
    check (
      provider = 'vercel'
      and provider_team_id =
        'team_NmYBq4k4t5BbaQKQNAHRgu8a'
      and provider_project_id =
        'prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU'
      and provider_deployment_id ~
        '^dpl_[A-Za-z0-9]{16,64}$'
      and provider_deployment_url ~
        '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$'
      and provider_deployment_url <>
        'boss-paegi.vercel.app'
      and production_alias = 'boss-paegi.vercel.app'
      and pg_catalog.length(alias_uid) between 64 and 256
      and alias_uid ~ '^[0-9a-f]+$'
      and provider_function_timeout_seconds = 300
    ),
  constraint oauth_rollout_qualification_timeline_check
    check (
      deployment_created_at <= provider_ready_at
      and provider_ready_at <= alias_current_since
      and qualified_at >=
        alias_current_since + interval '1505 seconds'
      and qualified_at <=
        alias_current_since + interval '24 hours'
    )
);

alter table public.oauth_rollout_deployment_qualifications
  enable row level security;
revoke all on table
  public.oauth_rollout_deployment_qualifications
  from public, anon, authenticated, service_role;

create or replace function
  public.guard_oauth_rollout_deployment_qualification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'oauth_rollout_deployment_qualification_append_only'
    using errcode = 'P0001';
end;
$$;

revoke all on function
  public.guard_oauth_rollout_deployment_qualification()
  from public, anon, authenticated, service_role;

create trigger
  trg_oauth_rollout_deployment_qualification_append_only
before update or delete
on public.oauth_rollout_deployment_qualifications
for each row execute function
  public.guard_oauth_rollout_deployment_qualification();

-- Row-level append-only and delete-capture triggers do not run for TRUNCATE.
-- A mistaken owner-level TRUNCATE must therefore fail before it can erase a
-- winner receipt, expose quarantined highlights, or bypass the session-ID
-- tombstones normally persisted by flow/cleanup DELETE triggers.
create or replace function
  public.guard_oauth_critical_relation_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'oauth_critical_relation_truncate_forbidden'
    using errcode = 'P0001';
end;
$$;

revoke all on function
  public.guard_oauth_critical_relation_truncate()
  from public, anon, authenticated, service_role;

create trigger trg_oauth_critical_relation_truncate
before truncate on public.anon_data_reassignments
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.oauth_flow_intents
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.oauth_anon_auth_cleanup_jobs
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.oauth_quarantined_score_highlights
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.oauth_deidentified_score_owner_tombstones
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.oauth_auth_session_id_tombstones
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.legacy_signup_migration_receipts
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create trigger trg_oauth_critical_relation_truncate
before truncate on public.oauth_rollout_deployment_qualifications
for each statement execute function
  public.guard_oauth_critical_relation_truncate();

create or replace function
  public.assert_oauth_rollout_deployment_qualification(
    p_contract_version text
  )
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_contract_version is distinct from
       '0094_oauth_flow_migration_contract'
     or not exists (
       select 1
         from public.oauth_rollout_deployment_qualifications q
        where q.contract_version = p_contract_version
          and q.expand_version = '0093_oauth_flow_intents'
          and q.provider_function_timeout_seconds = 300
          and q.qualified_at <= pg_catalog.clock_timestamp()
          and q.qualified_at >=
            q.alias_current_since + interval '1505 seconds'
          and q.qualified_at <=
            q.alias_current_since + interval '24 hours'
     )
  then
    raise exception
      'oauth_rollout_deployment_qualification_required'
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function
  public.assert_oauth_rollout_deployment_qualification(text)
  from public, anon, authenticated, service_role;

-- PostgreSQL represents the default composite-row-type ACL either as NULL or
-- as the equivalent explicit owner/PUBLIC ACL. Canonicalize the repo-owned
-- relation row types once so the online rollout can touch each pg_type tuple
-- with a transaction-local sentinel grant and return to byte-exact catalog
-- state while fencing concurrent TYPE ACL changes.
grant usage on type public.anon_data_reassignments to public;
grant usage on type public.dolls to public;
grant usage on type public.legacy_signup_migration_receipts to public;
grant usage on type public.member_accounts to public;
grant usage on type public.oauth_anon_auth_cleanup_jobs to public;
grant usage on type public.oauth_auth_session_id_tombstones to public;
grant usage on type
  public.oauth_deidentified_score_owner_tombstones to public;
grant usage on type public.oauth_flow_intents to public;
grant usage on type public.oauth_quarantined_score_highlights to public;
grant usage on type
  public.oauth_rollout_deployment_qualifications to public;
grant usage on type public.profiles to public;
grant usage on type public.score_highlights to public;
grant usage on type public.user_badges to public;

comment on table public.oauth_flow_intents is
  'Secret-free durable OAuth callback, sign-out, and migration ledger.';
comment on column public.oauth_flow_intents.session_fenced is
  'Observed-session recovery fence: active states plus unreleased completed continue.';
comment on column public.oauth_flow_intents.requested_next is
  'Flow-bound safe internal destination retained after callback URL stripping.';
comment on column public.oauth_flow_intents.target_access_token_sha256 is
  'Lowercase SHA-256 digest only; never the target access token.';
comment on column public.oauth_flow_intents.target_refresh_token_sha256 is
  'Lowercase SHA-256 digest only; never the target refresh token.';
comment on column public.oauth_flow_intents.released_at is
  'Durable browser-release boundary; target evidence is immutable afterward.';
comment on column public.oauth_flow_intents.migration_consumed_at is
  'Atomic flow-scoped transfer or proven no-transfer consumption receipt.';
comment on table public.oauth_anon_auth_cleanup_jobs is
  'Flow-scoped source-generation receipt for fenced deletion retry or terminal no-transfer protection.';
comment on column
  public.oauth_anon_auth_cleanup_jobs.source_auth_created_at is
  'Exact original auth.users generation timestamp captured before OAuth hand-off; never inferred at cleanup time.';
comment on table
  public.oauth_rollout_deployment_qualifications is
  'Append-only provider, Git, runtime, and drain evidence required before the OAuth migration contract.';
comment on column
  public.oauth_rollout_deployment_qualifications.expand_app_commit is
  'Immutable 0093 receipt commit; the deployed commit must descend from it and retain identical 0093 bytes.';
comment on column
  public.oauth_rollout_deployment_qualifications.qualified_at is
  'Database-clock qualification after old issuer 300s + legacy TTL 900s + new consumer 300s + clock margin 5s, within the 24-hour alias-current window.';

notify pgrst, 'reload schema';
commit;
