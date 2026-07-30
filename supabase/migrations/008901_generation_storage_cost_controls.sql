-- 008901_generation_storage_cost_controls.sql
--
-- DB-authoritative boundaries for every public path that can create external
-- AI, Storage, or signed-URL cost:
--   A. one durable, payload-bound face-preflight claim before tmp Storage and
--      four Moondream calls;
--   B. one durable raw-submit-once birefnet intent before candidate picking;
--   C. bounded/idempotent signed-upload intents plus bucket byte/MIME limits;
--   D. opaque actor + global quotas for public doll signed-URL egress.
--
-- This is an expand migration. The application rollout remains frozen by
-- GENERATION_COST_PATH_ENABLED until this transaction and the new application
-- are both present.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_user_mutation_lock(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.bp_mutation_object_lock(text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.consume_gen_credit_v2(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_generation_failed_and_refund(uuid,text,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_generation_and_consume(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_generation_row(uuid,text)'
     ) is null
     or pg_catalog.to_regclass(
       'public.storage_upload_intents'
     ) is null
     or pg_catalog.to_regclass(
       'public.public_write_quota_buckets'
     ) is null then
    raise exception '008901 preflight: required expand authority missing';
  end if;
end;
$$;

-- ── 1. Paid face-preflight reservations ───────────────────────────────────

-- A generation receipt is deliberately created before the first paid face
-- request so credit authority precedes external cost. Keep that receipt out of
-- every ordinary queued-generation recovery surface until the preflight has
-- committed its immutable generation plan.
alter table public.ai_generations
  add column if not exists cost_preflight_pending boolean not null
    default false;
create index if not exists ai_generations_cost_preflight_pending_idx
  on public.ai_generations(created_at, id)
  where cost_preflight_pending;

create table if not exists public.generation_preflight_reservations (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  role text not null check (
    role in ('boss', 'exec', 'teamlead', 'client', 'coworker')
  ),
  image_digest text not null check (image_digest ~ '^[0-9a-f]{64}$'),
  requires_credit boolean not null,
  state text not null default 'claimed' check (
    state in (
      'claimed',
      'accepted',
      'rejected',
      'failed',
      'committed',
      'released',
      'expired'
    )
  ),
  analysis_result jsonb,
  terminal_reason text check (
    terminal_reason is null
    or (
      char_length(terminal_reason) between 1 and 100
      and terminal_reason ~ '^[a-z0-9_]+$'
    )
  ),
  -- Generations are financial evidence and already profile-delete restricted.
  -- SET NULL cannot satisfy the committed-row invariant, so deletion must
  -- fail rather than corrupt the exactly-once receipt.
  generation_id uuid references public.ai_generations(id)
    on delete restrict,
  analysis_lease_token uuid,
  analysis_leased_until timestamptz,
  generation_config jsonb,
  generation_plan jsonb,
  config_source text check (
    config_source is null or config_source in ('db', 'default')
  ),
  config_version integer check (
    config_version is null or config_version >= 1
  ),
  config_invalid boolean,
  expires_at timestamptz not null
    default (pg_catalog.clock_timestamp() + interval '15 minutes'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  finalized_at timestamptz,
  constraint generation_preflight_analysis_shape check (
    analysis_result is null
    or (
      pg_catalog.jsonb_typeof(analysis_result) = 'object'
      and pg_catalog.octet_length(analysis_result::text) <= 16384
    )
  ),
  constraint generation_preflight_terminal_shape check (
    (
      state in ('claimed', 'accepted')
      and finalized_at is null
      and generation_id is null
    )
    or (
      state = 'committed'
      and finalized_at is not null
      and generation_id is not null
    )
    or (
      state in ('rejected', 'failed', 'released', 'expired')
      and finalized_at is not null
      and generation_id is null
    )
  ),
  constraint generation_preflight_result_shape check (
    (state = 'accepted' and analysis_result is not null)
    or state <> 'accepted'
  ),
  constraint generation_preflight_analysis_lease_shape check (
    (
      state = 'claimed'
      and (
        (
          analysis_lease_token is null
          and analysis_leased_until is null
        )
        or (
          analysis_lease_token is not null
          and analysis_leased_until is not null
        )
      )
    )
    or (
      state <> 'claimed'
      and analysis_lease_token is null
      and analysis_leased_until is null
    )
  ),
  constraint generation_preflight_config_shape check (
    (
      generation_config is null
      and config_source is null
      and config_version is null
      and config_invalid is null
    )
    or (
      pg_catalog.jsonb_typeof(generation_config) = 'object'
      and pg_catalog.octet_length(generation_config::text) <= 65536
      and config_source is not null
      and (
        (config_source = 'db' and config_version is not null)
        or (config_source = 'default' and config_version is null)
      )
      and config_invalid is not null
    )
  ),
  constraint generation_preflight_plan_shape check (
    generation_plan is null
    or (
      state = 'committed'
      and pg_catalog.jsonb_typeof(generation_plan) = 'object'
      and pg_catalog.octet_length(generation_plan::text) <= 65536
    )
  )
);

comment on table public.generation_preflight_reservations is
  'Payload-bound exactly-once claims and generation-credit receipts issued before face Storage/Moondream cost; service-role only, 2h15 crash expiry.';

-- Reapplying an expand migration against a populated rolling environment must
-- strengthen the previously-created table too. CREATE TABLE IF NOT EXISTS
-- alone does not add later columns, replace the former SET NULL FK, or install
-- new CHECK constraints.
alter table public.generation_preflight_reservations
  add column if not exists analysis_lease_token uuid,
  add column if not exists analysis_leased_until timestamptz,
  add column if not exists generation_config jsonb,
  add column if not exists generation_plan jsonb,
  add column if not exists config_source text,
  add column if not exists config_version integer,
  add column if not exists config_invalid boolean;
alter table public.generation_preflight_reservations
  alter column expires_at set default (
    pg_catalog.clock_timestamp() + interval '2 hours 15 minutes'
  );
alter table public.generation_preflight_reservations
  drop constraint if exists
    generation_preflight_reservations_generation_id_fkey,
  add constraint generation_preflight_reservations_generation_id_fkey
    foreign key (generation_id)
    references public.ai_generations(id)
    on delete restrict;
alter table public.generation_preflight_reservations
  drop constraint if exists
    generation_preflight_reservations_config_source_check,
  add constraint generation_preflight_reservations_config_source_check
    check (
      config_source is null or config_source in ('db', 'default')
    ),
  drop constraint if exists
    generation_preflight_reservations_config_version_check,
  add constraint generation_preflight_reservations_config_version_check
    check (config_version is null or config_version >= 1),
  drop constraint if exists generation_preflight_analysis_shape,
  add constraint generation_preflight_analysis_shape check (
    analysis_result is null
    or (
      pg_catalog.jsonb_typeof(analysis_result) = 'object'
      and pg_catalog.octet_length(analysis_result::text) <= 16384
    )
  ),
  drop constraint if exists generation_preflight_terminal_shape,
  add constraint generation_preflight_terminal_shape check (
    (
      state in ('claimed', 'accepted')
      and finalized_at is null
      and generation_id is not null
    )
    or (
      state = 'committed'
      and finalized_at is not null
      and generation_id is not null
    )
    or (
      state in ('rejected', 'failed', 'released', 'expired')
      and finalized_at is not null
      and generation_id is not null
    )
  ),
  drop constraint if exists generation_preflight_result_shape,
  add constraint generation_preflight_result_shape check (
    (state = 'accepted' and analysis_result is not null)
    or state <> 'accepted'
  ),
  drop constraint if exists generation_preflight_analysis_lease_shape,
  add constraint generation_preflight_analysis_lease_shape check (
    (
      state = 'claimed'
      and (
        (
          analysis_lease_token is null
          and analysis_leased_until is null
        )
        or (
          analysis_lease_token is not null
          and analysis_leased_until is not null
        )
      )
    )
    or (
      state <> 'claimed'
      and analysis_lease_token is null
      and analysis_leased_until is null
    )
  ),
  drop constraint if exists generation_preflight_config_shape,
  add constraint generation_preflight_config_shape check (
    (
      generation_config is null
      and config_source is null
      and config_version is null
      and config_invalid is null
    )
    or (
      pg_catalog.jsonb_typeof(generation_config) = 'object'
      and pg_catalog.octet_length(generation_config::text) <= 65536
      and config_source is not null
      and (
        (config_source = 'db' and config_version is not null)
        or (config_source = 'default' and config_version is null)
      )
      and config_invalid is not null
    )
  ),
  drop constraint if exists generation_preflight_plan_shape,
  add constraint generation_preflight_plan_shape check (
    generation_plan is null
    or (
      state = 'committed'
      and pg_catalog.jsonb_typeof(generation_plan) = 'object'
      and pg_catalog.octet_length(generation_plan::text) <= 65536
    )
  );

alter table public.generation_preflight_reservations enable row level security;
revoke all on table public.generation_preflight_reservations
  from public, anon, authenticated, service_role;

create index if not exists generation_preflight_owner_day_idx
  on public.generation_preflight_reservations(owner_id, created_at);
create index if not exists generation_preflight_global_day_idx
  on public.generation_preflight_reservations(created_at);
create index if not exists generation_preflight_active_idx
  on public.generation_preflight_reservations(expires_at, owner_id, id)
  where state in ('claimed', 'accepted');

create table if not exists public.generation_face_check_intents (
  reservation_id uuid not null
    references public.generation_preflight_reservations(id)
    on delete cascade,
  check_key text not null check (
    check_key in ('face', 'count', 'covered', 'glasses')
  ),
  state text not null default 'planned' check (
    state in (
      'planned',
      'submitting',
      'uncertain',
      'acknowledged',
      'succeeded',
      'rejected'
    )
  ),
  input_payload jsonb not null check (
    pg_catalog.jsonb_typeof(input_payload) = 'object'
    and pg_catalog.octet_length(input_payload::text) <= 8192
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  callback_token_hash text not null check (
    callback_token_hash ~ '^[0-9a-f]{64}$'
  ),
  external_request_id text check (
    external_request_id is null
    or (
      pg_catalog.octet_length(external_request_id) between 1 and 256
      and external_request_id !~ '[[:cntrl:]]'
    )
  ),
  http_status integer check (
    http_status is null or http_status between 100 and 599
  ),
  raw_output text check (
    raw_output is null
    or pg_catalog.octet_length(raw_output) <= 200
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (reservation_id, check_key),
  constraint generation_face_check_state_shape check (
    (
      state = 'planned'
      and claimed_at is null
      and completed_at is null
      and external_request_id is null
      and raw_output is null
    )
    or (
      state in ('submitting', 'uncertain')
      and claimed_at is not null
      and completed_at is null
      and external_request_id is null
      and raw_output is null
    )
    or (
      state = 'acknowledged'
      and claimed_at is not null
      and completed_at is null
      and external_request_id is not null
      and raw_output is null
    )
    or (
      state = 'succeeded'
      and claimed_at is not null
      and completed_at is not null
      and external_request_id is not null
      and raw_output is not null
    )
    or (
      state = 'rejected'
      and claimed_at is not null
      and completed_at is not null
      and raw_output is null
    )
  )
);

comment on table public.generation_face_check_intents is
  'Four payload-bound Moondream child intents. submitting/uncertain are never rearmed; signed full-payload webhooks are the recovery authority.';

alter table public.generation_face_check_intents enable row level security;
revoke all on table public.generation_face_check_intents
  from public, anon, authenticated, service_role;

create table if not exists public.generation_face_check_cost_attempts (
  reservation_id uuid not null,
  check_key text not null check (
    check_key in ('face', 'count', 'covered', 'glasses')
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (reservation_id, check_key),
  foreign key (reservation_id, check_key)
    references public.generation_face_check_intents(
      reservation_id, check_key
    )
    on delete cascade
);

comment on table public.generation_face_check_cost_attempts is
  'Append-only receipt inserted atomically immediately before each one-shot Moondream POST.';

alter table public.generation_face_check_cost_attempts enable row level security;
revoke all on table public.generation_face_check_cost_attempts
  from public, anon, authenticated, service_role;

-- A process can die after the durable `submitting` flip and after the provider
-- accepted the raw POST but before an acknowledgement was recorded. That
-- boundary is intentionally never auto-replayed. Expired ambiguity is handed
-- to this durable operations ledger so cron fails visibly until a human has
-- reconciled the provider evidence.
create table if not exists public.generation_cost_reconciliation_issues (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  issue_kind text not null check (
    issue_kind in (
      'face_submit',
      'flux_submit',
      'pick_submit',
      'pick_materialization'
    )
  ),
  object_key text not null check (
    pg_catalog.octet_length(object_key) between 1 and 160
    and object_key ~ '^[a-z0-9:_-]+$'
  ),
  owner_id uuid not null,
  generation_id uuid,
  reservation_id uuid,
  candidate_index integer check (
    candidate_index is null or candidate_index between 0 and 2
  ),
  state_snapshot text not null check (
    state_snapshot in (
      'submitting',
      'uncertain',
      'acknowledged',
      'conflict',
      'late_acknowledged',
      'provider_done'
    )
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  external_request_id text check (
    external_request_id is null
    or (
      pg_catalog.octet_length(external_request_id) between 1 and 256
      and external_request_id !~ '[[:cntrl:]]'
    )
  ),
  status text not null default 'open' check (
    status in ('open', 'resolved')
  ),
  first_seen_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_seen_at timestamptz not null default pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  resolution_note text check (
    resolution_note is null
    or (
      pg_catalog.octet_length(resolution_note) between 1 and 1000
      and resolution_note !~ '[[:cntrl:]]'
    )
  ),
  unique (issue_kind, object_key),
  constraint generation_cost_reconciliation_identity check (
    (issue_kind = 'face_submit'
      and reservation_id is not null
      and generation_id is not null
      and candidate_index is null)
    or
    (issue_kind = 'flux_submit'
      and reservation_id is null
      and generation_id is not null
      and candidate_index is not null)
    or
    (issue_kind in ('pick_submit', 'pick_materialization')
      and reservation_id is null
      and generation_id is not null
      and candidate_index is not null)
  ),
  constraint generation_cost_reconciliation_terminal check (
    (status = 'open' and resolved_at is null and resolution_note is null)
    or
    (status = 'resolved'
      and resolved_at is not null
      and resolution_note is not null)
  )
);
alter table public.generation_cost_reconciliation_issues
  drop constraint if exists
    generation_cost_reconciliation_issues_issue_kind_check,
  add constraint generation_cost_reconciliation_issues_issue_kind_check
    check (
      issue_kind in (
        'face_submit',
        'flux_submit',
        'pick_submit',
        'pick_materialization'
      )
    ),
  drop constraint if exists
    generation_cost_reconciliation_issues_state_snapshot_check,
  add constraint generation_cost_reconciliation_issues_state_snapshot_check
    check (
      state_snapshot in (
        'submitting',
        'uncertain',
        'acknowledged',
        'conflict',
        'late_acknowledged',
        'provider_done'
      )
    ),
  drop constraint if exists generation_cost_reconciliation_identity,
  add constraint generation_cost_reconciliation_identity check (
    (issue_kind = 'face_submit'
      and reservation_id is not null
      and generation_id is not null
      and candidate_index is null)
    or
    (issue_kind = 'flux_submit'
      and reservation_id is null
      and generation_id is not null
      and candidate_index is not null)
    or
    (issue_kind in ('pick_submit', 'pick_materialization')
      and reservation_id is null
      and generation_id is not null
      and candidate_index is not null)
  );
comment on table public.generation_cost_reconciliation_issues is
  'Fail-visible operations ledger for provider submits whose accept/ack result cannot be inferred safely; never an automatic retry authority.';
alter table public.generation_cost_reconciliation_issues
  enable row level security;
revoke all on table public.generation_cost_reconciliation_issues
  from public, anon, authenticated, service_role;
create index if not exists generation_cost_reconciliation_open_idx
  on public.generation_cost_reconciliation_issues(
    first_seen_at, issue_kind, object_key
  )
  where status = 'open';

alter table public.generation_preflight_reservations
  add column if not exists continuation_state text not null
    default 'pending',
  add column if not exists continuation_lease_token uuid,
  add column if not exists continuation_leased_until timestamptz;
alter table public.generation_preflight_reservations
  drop constraint if exists generation_preflight_continuation_shape;
alter table public.generation_preflight_reservations
  add constraint generation_preflight_continuation_shape check (
    (
      continuation_state = 'pending'
      and continuation_lease_token is null
      and continuation_leased_until is null
    )
    or (
      continuation_state = 'running'
      and state = 'committed'
      and continuation_lease_token is not null
      and continuation_leased_until is not null
    )
    or (
      continuation_state = 'submitted'
      and state = 'committed'
      and continuation_lease_token is null
      and continuation_leased_until is null
    )
  );

create or replace function public.claim_generation_preflight(
  p_user_id uuid,
  p_request_id uuid,
  p_role text,
  p_image_digest text,
  p_requires_credit boolean,
  p_worker_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  c_user_day_limit integer := 25;
  c_global_day_limit integer := 100;
  c_user_inflight_limit integer := 1;
  c_global_inflight_limit integer := 25;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_tomorrow timestamptz :=
    ((v_today + 1)::timestamp at time zone 'Asia/Seoul');
  v_today_start timestamptz :=
    (v_today::timestamp at time zone 'Asia/Seoul');
  v_existing public.generation_preflight_reservations%rowtype;
  v_deleted_at timestamptz;
  v_credits integer;
  v_user_day integer;
  v_global_day integer;
  v_user_inflight integer;
  v_global_inflight integer;
  v_generation_id uuid;
begin
  if p_user_id is null
     or p_request_id is null
     or p_role not in ('boss', 'exec', 'teamlead', 'client', 'coworker')
     or p_image_digest is null
     or p_image_digest !~ '^[0-9a-f]{64}$'
     or p_requires_credit is null
     or p_worker_id is null then
    raise exception 'invalid_generation_preflight'
      using errcode = '22023';
  end if;

  -- Immutable request identity first, then global/day, then canonical user.
  -- Every function touching the same request follows this order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_existing
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if found then
    -- A paid generation row is created before any face/provider cost. Follow
    -- the canonical generation object->user lock order before touching the
    -- owner so a concurrent failure/refund or account mutation cannot invert
    -- locks.
    if v_existing.generation_id is null then
      raise exception 'preflight_generation_receipt_missing'
        using errcode = 'P0001';
    end if;
    perform public.bp_mutation_object_lock(
      'generation', v_existing.generation_id::text
    );
    perform public.bp_user_mutation_lock(p_user_id);
    select p.deleted_at
      into v_deleted_at
      from public.profiles p
     where p.id = p_user_id
     for key share;
    if not found or v_deleted_at is not null then
      raise exception 'account_deleted' using errcode = 'P0001';
    end if;
    if v_existing.owner_id <> p_user_id
       or v_existing.role <> p_role
       or v_existing.image_digest <> p_image_digest
       or v_existing.requires_credit <> p_requires_credit then
      raise exception 'preflight_idempotency_conflict'
        using errcode = 'P0001';
    end if;
    if v_existing.state in ('claimed', 'accepted')
       and v_existing.expires_at <= v_now then
      perform public.mark_generation_failed_and_refund(
        v_existing.generation_id,
        'preflight_claim_expired',
        null
      );
      update public.generation_preflight_reservations
         set state = 'expired',
             terminal_reason = 'claim_expired',
             analysis_lease_token = null,
             analysis_leased_until = null,
             finalized_at = v_now,
             updated_at = v_now
       where id = p_request_id;
      update public.ai_generations
         set cost_preflight_pending = false
       where id = v_existing.generation_id
         and cost_preflight_pending;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'expired', 'reason', 'claim_expired'
      );
    end if;
    if v_existing.state = 'claimed' then
      if v_existing.analysis_lease_token = p_worker_id
         or v_existing.analysis_leased_until is null
         or v_existing.analysis_leased_until <= v_now then
        update public.generation_preflight_reservations
           set analysis_lease_token = p_worker_id,
               analysis_leased_until = v_now + interval '2 minutes',
               updated_at = v_now
         where id = p_request_id;
        return pg_catalog.jsonb_build_object(
          'ok', true, 'outcome', 'claimed'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'outcome', 'processing'
      );
    elsif v_existing.state = 'accepted' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'accepted',
        'analysis', v_existing.analysis_result,
        'generation_config', v_existing.generation_config,
        'config_source', v_existing.config_source,
        'config_version', v_existing.config_version,
        'config_invalid', v_existing.config_invalid
      );
    elsif v_existing.state = 'committed' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'committed',
        'generation_id', v_existing.generation_id
      );
    elsif v_existing.state = 'rejected' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'rejected',
        'reason', v_existing.terminal_reason
      );
    else
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', v_existing.state,
        'reason', v_existing.terminal_reason
      );
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight-day:' || v_today::text,
      0
    )
  );
  v_generation_id := pg_catalog.gen_random_uuid();
  perform public.bp_mutation_object_lock(
    'generation', v_generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);

  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  if p_requires_credit then
    select m.gen_credits
      into v_credits
      from public.member_accounts m
     where m.user_id = p_user_id
     for update;
    if not found or coalesce(v_credits, 0) < 1 then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'no_credits'
      );
    end if;
  end if;

  select pg_catalog.count(*)::integer
    into v_user_day
    from public.generation_preflight_reservations r
   where r.owner_id = p_user_id
     and r.created_at >= v_today_start
     and r.created_at < v_tomorrow;
  select pg_catalog.count(*)::integer
    into v_global_day
    from public.generation_preflight_reservations r
   where r.created_at >= v_today_start
     and r.created_at < v_tomorrow;
  select pg_catalog.count(*)::integer
    into v_user_inflight
    from public.generation_preflight_reservations r
   where r.owner_id = p_user_id
     and r.state in ('claimed', 'accepted')
     and r.expires_at > v_now;
  select pg_catalog.count(*)::integer
    into v_global_inflight
    from public.generation_preflight_reservations r
   where r.state in ('claimed', 'accepted')
     and r.expires_at > v_now;

  if v_user_day >= c_user_day_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'user_day_quota'
    );
  end if;
  if v_global_day >= c_global_day_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'global_day_quota'
    );
  end if;
  if v_user_inflight >= c_user_inflight_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'user_inflight_quota'
    );
  end if;
  if v_global_inflight >= c_global_inflight_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'global_inflight_quota'
    );
  end if;

  -- Create the financial generation receipt and consume its credit before
  -- returning a claim that authorizes any tmp upload or paid face call. The
  -- transaction rolls all of this back together on every error. Invalid-face,
  -- release, and expiry paths call the canonical terminal refund RPC.
  insert into public.ai_generations(
    id, owner_id, status, role, cost_preflight_pending
  )
  values (v_generation_id, p_user_id, 'queued', p_role, true);
  if p_requires_credit then
    v_credits := public.consume_gen_credit_v2(
      p_user_id, v_generation_id
    );
    if v_credits is null then
      raise exception 'insufficient_credits' using errcode = 'P0001';
    end if;
  else
    v_credits := null;
  end if;

  insert into public.generation_preflight_reservations(
    id,
    owner_id,
    role,
    image_digest,
    requires_credit,
    state,
    generation_id,
    expires_at,
    analysis_lease_token,
    analysis_leased_until
  )
  values (
    p_request_id,
    p_user_id,
    p_role,
    p_image_digest,
    p_requires_credit,
    'claimed',
    v_generation_id,
    v_now + interval '2 hours 15 minutes',
    p_worker_id,
    v_now + interval '2 minutes'
  );

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'claimed');
end;
$$;
revoke all on function public.claim_generation_preflight(
  uuid, uuid, text, text, boolean, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_preflight(
  uuid, uuid, text, text, boolean, uuid
) to service_role;

create or replace function public.prepare_generation_face_checks(
  p_user_id uuid,
  p_request_id uuid,
  p_worker_id uuid,
  p_generation_config jsonb,
  p_config_source text,
  p_config_version integer,
  p_config_invalid boolean,
  p_intents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer;
  v_distinct integer;
  v_invalid integer;
  v_ready integer;
  v_raw jsonb;
begin
  if p_user_id is null
     or p_request_id is null
     or p_worker_id is null
     or p_generation_config is null
     or pg_catalog.jsonb_typeof(p_generation_config) <> 'object'
     or pg_catalog.octet_length(p_generation_config::text) > 65536
     or p_config_source not in ('db', 'default')
     or (
       p_config_source = 'db'
       and (p_config_version is null or p_config_version < 1)
     )
     or (
       p_config_source = 'default'
       and p_config_version is not null
     )
     or p_config_invalid is null
     or p_intents is null
     or pg_catalog.jsonb_typeof(p_intents) <> 'array'
     or pg_catalog.jsonb_array_length(p_intents) <> 4
     or pg_catalog.octet_length(p_intents::text) > 65536 then
    raise exception 'invalid_generation_face_checks'
      using errcode = '22023';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct e->>'check_key')::integer,
    pg_catalog.count(*) filter (
      where
        pg_catalog.jsonb_typeof(e) <> 'object'
        or (e->>'check_key') not in (
          'face', 'count', 'covered', 'glasses'
        )
        or (e->>'payload_hash') !~ '^[0-9a-f]{64}$'
        or (e->>'callback_token_hash') !~ '^[0-9a-f]{64}$'
        or pg_catalog.jsonb_typeof(e->'input') <> 'object'
        or (
          select pg_catalog.count(*)
            from pg_catalog.jsonb_object_keys(e->'input')
        ) <> 2
        or not ((e->'input') ? 'image_url')
        or not ((e->'input') ? 'prompt')
        or pg_catalog.octet_length(e->'input'->>'image_url')
             not between 1 and 4096
        or (e->'input'->>'image_url') !~ '^https?://'
        or e->'input'->>'prompt' <> case e->>'check_key'
          when 'face' then
            'Is there a clearly visible human face in this photo? Answer only yes or no.'
          when 'count' then
            'How many people are in this photo? Answer with a single number only.'
          when 'covered' then
            'Is any part of the person''s face covered or blocked by a hand, fingers, or an object? Answer only yes or no.'
          when 'glasses' then
            'Is the person wearing eyeglasses or sunglasses? Answer only yes or no.'
          else null
        end
    )::integer
    into v_count, v_distinct, v_invalid
    from pg_catalog.jsonb_array_elements(p_intents) e;
  if v_count <> 4 or v_distinct <> 4 or v_invalid <> 0 then
    raise exception 'invalid_generation_face_checks'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.state <> 'claimed' then
    raise exception 'generation_face_checks_forbidden'
      using errcode = 'P0001';
  end if;
  if v_reservation.analysis_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;

  if v_reservation.generation_config is null then
    update public.generation_preflight_reservations
       set generation_config = p_generation_config,
           config_source = p_config_source,
           config_version = p_config_version,
           config_invalid = p_config_invalid,
           updated_at = v_now
     where id = p_request_id;
  else
    -- The first durable snapshot wins. A retry after config publication or a
    -- deployment change must resume it rather than conflict or drift output.
    null;
  end if;

  insert into public.generation_face_check_intents(
    reservation_id,
    check_key,
    input_payload,
    payload_hash,
    callback_token_hash
  )
  select
    p_request_id,
    e->>'check_key',
    e->'input',
    e->>'payload_hash',
    e->>'callback_token_hash'
  from pg_catalog.jsonb_array_elements(p_intents) e
  on conflict (reservation_id, check_key) do nothing;

  -- A crash after atomic prepare but before a child claim may leave a signed
  -- input URL aging. Only never-attempted rows can be rebound to the fresh
  -- URL/token/hash. submitting/uncertain/acknowledged rows retain their exact
  -- original binding forever and can only converge through webhook/recovery.
  update public.generation_face_check_intents i
     set input_payload = e.value->'input',
         payload_hash = e.value->>'payload_hash',
         callback_token_hash = e.value->>'callback_token_hash',
         updated_at = v_now
    from pg_catalog.jsonb_array_elements(p_intents) e(value)
   where i.reservation_id = p_request_id
     and i.check_key = e.value->>'check_key'
     and i.state = 'planned'
     and not exists (
       select 1
         from public.generation_face_check_cost_attempts a
        where a.reservation_id = i.reservation_id
          and a.check_key = i.check_key
     );

  select
    pg_catalog.count(*)::integer,
    pg_catalog.jsonb_object_agg(i.check_key, i.raw_output)
    into v_ready, v_raw
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.state = 'succeeded';
  if v_ready = 4 then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'ready', 'raw_outputs', v_raw
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared'
  );
end;
$$;
revoke all on function public.prepare_generation_face_checks(
  uuid, uuid, uuid, jsonb, text, integer, boolean, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_generation_face_checks(
  uuid, uuid, uuid, jsonb, text, integer, boolean, jsonb
) to service_role;

create or replace function public.claim_generation_face_check(
  p_user_id uuid,
  p_request_id uuid,
  p_worker_id uuid,
  p_check_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_intent public.generation_face_check_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_check_key not in ('face', 'count', 'covered', 'glasses') then
    raise exception 'invalid_generation_face_check'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.generation_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.state <> 'claimed'
     or v_reservation.analysis_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  select *
    into v_intent
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.check_key = p_check_key
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_prepared'
    );
  end if;
  if v_intent.state <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', v_intent.state
    );
  end if;

  insert into public.generation_face_check_cost_attempts(
    reservation_id, check_key, payload_hash, created_at
  )
  values (
    p_request_id, p_check_key, v_intent.payload_hash, v_now
  );
  update public.generation_face_check_intents
     set state = 'submitting',
         claimed_at = v_now,
         updated_at = v_now
   where reservation_id = p_request_id
     and check_key = p_check_key;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'claimed',
    'check_key', p_check_key,
    'input', v_intent.input_payload,
    'payload_hash', v_intent.payload_hash,
    'callback_token_hash', v_intent.callback_token_hash
  );
end;
$$;
revoke all on function public.claim_generation_face_check(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_face_check(
  uuid, uuid, uuid, text
) to service_role;

create or replace function public.record_generation_face_check_submit(
  p_request_id uuid,
  p_check_key text,
  p_payload_hash text,
  p_callback_token_hash text,
  p_outcome text,
  p_external_request_id text,
  p_http_status integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_intent public.generation_face_check_intents%rowtype;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id;
  if not found or v_reservation.generation_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(v_reservation.owner_id);
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  select *
    into v_intent
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.check_key = p_check_key
   for update;
  if not found
     or v_intent.payload_hash <> p_payload_hash
     or v_intent.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  if v_intent.state = 'succeeded' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'succeeded'
    );
  end if;
  if v_intent.state = 'rejected' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'rejected'
    );
  end if;
  if v_intent.state not in (
    'submitting', 'uncertain', 'acknowledged'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'state_conflict'
    );
  end if;

  if p_outcome = 'acknowledged' then
    if p_external_request_id is null
       or pg_catalog.octet_length(p_external_request_id)
            not between 1 and 256 then
      raise exception 'invalid_generation_face_check_submit'
        using errcode = '22023';
    end if;
    if v_intent.external_request_id is not null
       and v_intent.external_request_id <> p_external_request_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'request_id_conflict'
      );
    end if;
    update public.generation_face_check_intents
       set state = 'acknowledged',
           external_request_id = p_external_request_id,
           http_status = p_http_status,
           updated_at = v_now
     where reservation_id = p_request_id
       and check_key = p_check_key;
  elsif p_outcome = 'uncertain' then
    if p_external_request_id is not null then
      raise exception 'invalid_generation_face_check_submit'
        using errcode = '22023';
    end if;
    update public.generation_face_check_intents
       set state = 'uncertain',
           http_status = p_http_status,
           updated_at = v_now
     where reservation_id = p_request_id
       and check_key = p_check_key;
  elsif p_outcome = 'rejected' then
    if p_external_request_id is not null then
      raise exception 'invalid_generation_face_check_submit'
        using errcode = '22023';
    end if;
    update public.generation_face_check_intents
       set state = 'rejected',
           http_status = p_http_status,
           completed_at = v_now,
           updated_at = v_now
     where reservation_id = p_request_id
       and check_key = p_check_key;
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_face_check_submit_rejected',
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = 'failed',
           terminal_reason = 'face_check_submit_rejected',
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = p_request_id
       and state = 'claimed';
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
  else
    raise exception 'invalid_generation_face_check_submit'
      using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', p_outcome
  );
end;
$$;
revoke all on function public.record_generation_face_check_submit(
  uuid, text, text, text, text, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_face_check_submit(
  uuid, text, text, text, text, text, integer
) to service_role;

create or replace function public.record_generation_face_check_webhook(
  p_request_id uuid,
  p_check_key text,
  p_payload_hash text,
  p_callback_token_hash text,
  p_external_request_id text,
  p_status text,
  p_raw_output text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_intent public.generation_face_check_intents%rowtype;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_ready integer;
  v_raw jsonb;
begin
  if p_status not in ('OK', 'ERROR')
     or p_external_request_id is null
     or pg_catalog.octet_length(p_external_request_id)
          not between 1 and 256
     or (
       p_status = 'OK'
       and (
         p_raw_output is null
         or pg_catalog.octet_length(p_raw_output) > 200
       )
     )
     or (p_status = 'ERROR' and p_raw_output is not null) then
    raise exception 'invalid_generation_face_check_webhook'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id;
  if not found or v_reservation.generation_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(v_reservation.owner_id);
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  select *
    into v_intent
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.check_key = p_check_key
   for update;
  if not found
     or v_intent.payload_hash <> p_payload_hash
     or v_intent.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  if v_intent.external_request_id is not null
     and v_intent.external_request_id <> p_external_request_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'request_id_conflict'
    );
  end if;
  if v_intent.state = 'succeeded' then
    if v_intent.raw_output <> p_raw_output then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'result_conflict'
      );
    end if;
  elsif v_intent.state = 'rejected' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'rejected',
      'owner_id', v_reservation.owner_id
    );
  elsif v_intent.state in (
    'submitting', 'uncertain', 'acknowledged'
  ) then
    if p_status = 'ERROR' then
      update public.generation_face_check_intents
         set state = 'rejected',
             external_request_id = p_external_request_id,
             completed_at = v_now,
             updated_at = v_now
       where reservation_id = p_request_id
         and check_key = p_check_key;
      v_terminal := public.mark_generation_failed_and_refund(
        v_reservation.generation_id,
        'preflight_face_check_provider_error',
        null
      );
      if v_terminal is null
         or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
         or v_terminal->'ok' is distinct from 'true'::jsonb then
        raise exception 'preflight_refund_unconfirmed'
          using errcode = 'P0001';
      end if;
      update public.generation_preflight_reservations
         set state = 'failed',
             terminal_reason = 'face_check_provider_error',
             analysis_lease_token = null,
             analysis_leased_until = null,
             finalized_at = v_now,
             updated_at = v_now
       where id = p_request_id
         and state = 'claimed';
      update public.ai_generations
         set cost_preflight_pending = false
       where id = v_reservation.generation_id
         and cost_preflight_pending;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'outcome', 'rejected',
        'owner_id', v_reservation.owner_id
      );
    end if;
    update public.generation_face_check_intents
       set state = 'succeeded',
           external_request_id = p_external_request_id,
           raw_output = p_raw_output,
           completed_at = v_now,
           updated_at = v_now
     where reservation_id = p_request_id
       and check_key = p_check_key;
  else
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'state_conflict'
    );
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.jsonb_object_agg(i.check_key, i.raw_output)
    into v_ready, v_raw
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.state = 'succeeded';
  if v_ready = 4 then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'ready',
      'owner_id', v_reservation.owner_id,
      'raw_outputs', v_raw
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'recorded'
  );
end;
$$;
revoke all on function public.record_generation_face_check_webhook(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_face_check_webhook(
  uuid, text, text, text, text, text, text
) to service_role;

create or replace function public.finalize_generation_face_checks(
  p_request_id uuid,
  p_analysis jsonb,
  p_failure_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_ready integer;
  v_invalid integer;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if v_reservation.state = 'accepted' then
    if v_reservation.analysis_result <> p_analysis then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'result_conflict'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'accepted'
    );
  end if;
  if v_reservation.state <> 'claimed' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', v_reservation.state
    );
  end if;

  select pg_catalog.count(*)::integer
    into v_ready
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.state = 'succeeded';
  if p_failure_reason is not null then
    if p_failure_reason !~ '^[a-z0-9_]{1,100}$'
       or v_ready <> 4 then
      raise exception 'invalid_generation_face_check_result'
        using errcode = '22023';
    end if;
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_' || p_failure_reason,
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = case
             when p_failure_reason in (
               'no_face', 'multiple_people', 'face_obstructed'
             ) then 'rejected'
             else 'failed'
           end,
           analysis_result = p_analysis,
           terminal_reason = p_failure_reason,
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = p_request_id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', case
        when p_failure_reason in (
          'no_face', 'multiple_people', 'face_obstructed'
        ) then 'rejected'
        else 'failed'
      end
    );
  end if;
  if p_analysis is null
     or pg_catalog.jsonb_typeof(p_analysis) <> 'object'
     or pg_catalog.octet_length(p_analysis::text) > 16384
     or v_ready <> 4
     or p_analysis->>'model' <> 'fal-ai/moondream3-preview/query'
     or p_analysis->>'status' <> 'ok'
     or pg_catalog.jsonb_typeof(p_analysis->'checks') <> 'array'
     or pg_catalog.jsonb_array_length(p_analysis->'checks') <> 4 then
    raise exception 'invalid_generation_face_check_result'
      using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer
    into v_invalid
    from pg_catalog.jsonb_array_elements(
      p_analysis->'checks'
    ) with ordinality c(value, position)
    left join public.generation_face_check_intents i
      on i.reservation_id = p_request_id
     and i.check_key = c.value->>'key'
   where i.reservation_id is null
      or i.state <> 'succeeded'
      or c.value->>'rawOutput' is distinct from i.raw_output
      or c.value->>'prompt' <> case c.position
        when 1 then
          'Is there a clearly visible human face in this photo? Answer only yes or no.'
        when 2 then
          'How many people are in this photo? Answer with a single number only.'
        when 3 then
          'Is any part of the person''s face covered or blocked by a hand, fingers, or an object? Answer only yes or no.'
        when 4 then
          'Is the person wearing eyeglasses or sunglasses? Answer only yes or no.'
        else null
      end
      or c.value->>'key' <> case c.position
        when 1 then 'face'
        when 2 then 'count'
        when 3 then 'covered'
        when 4 then 'glasses'
        else null
      end;
  if v_invalid <> 0 then
    raise exception 'invalid_generation_face_check_result'
      using errcode = '22023';
  end if;
  if (
    select pg_catalog.count(distinct c.value->>'key')
      from pg_catalog.jsonb_array_elements(p_analysis->'checks') c(value)
  ) <> 4 then
    raise exception 'invalid_generation_face_check_result'
      using errcode = '22023';
  end if;
  update public.generation_preflight_reservations
     set state = 'accepted',
         analysis_result = p_analysis,
         analysis_lease_token = null,
         analysis_leased_until = null,
         updated_at = v_now
   where id = p_request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'accepted'
  );
end;
$$;
revoke all on function public.finalize_generation_face_checks(
  uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_generation_face_checks(
  uuid, jsonb, text
) to service_role;

create or replace function public.record_generation_preflight_result(
  p_user_id uuid,
  p_request_id uuid,
  p_worker_id uuid,
  p_role text,
  p_image_digest text,
  p_outcome text,
  p_analysis jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_deleted_at timestamptz;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.role <> p_role
     or v_reservation.image_digest <> p_image_digest then
    raise exception 'preflight_idempotency_conflict'
      using errcode = 'P0001';
  end if;
  if v_reservation.generation_id is null then
    raise exception 'preflight_generation_receipt_missing'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  if v_reservation.state <> 'claimed' then
    if v_reservation.state = p_outcome then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', v_reservation.state,
        'analysis', v_reservation.analysis_result
      );
    end if;
    raise exception 'preflight_state_conflict' using errcode = 'P0001';
  end if;
  if v_reservation.analysis_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  if v_reservation.expires_at <= v_now then
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_claim_expired',
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = 'expired',
           terminal_reason = 'claim_expired',
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = p_request_id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'expired'
    );
  end if;

  if p_outcome = 'accepted' then
    if p_analysis is null
       or pg_catalog.jsonb_typeof(p_analysis) <> 'object'
       or pg_catalog.octet_length(p_analysis::text) > 16384
       or p_reason is not null then
      raise exception 'invalid_preflight_result' using errcode = '22023';
    end if;
    update public.generation_preflight_reservations
       set state = 'accepted',
           analysis_result = p_analysis,
           analysis_lease_token = null,
           analysis_leased_until = null,
           updated_at = v_now
     where id = p_request_id;
  elsif p_outcome in ('rejected', 'failed') then
    if p_analysis is not null
       or p_reason is null
       or p_reason !~ '^[a-z0-9_]{1,100}$' then
      raise exception 'invalid_preflight_result' using errcode = '22023';
    end if;
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_' || p_reason,
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = p_outcome,
           terminal_reason = p_reason,
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = p_request_id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
  else
    raise exception 'invalid_preflight_result' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', p_outcome);
end;
$$;
revoke all on function public.record_generation_preflight_result(
  uuid, uuid, uuid, text, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_preflight_result(
  uuid, uuid, uuid, text, text, text, jsonb, text
) to service_role;

create or replace function public.commit_generation_preflight(
  p_user_id uuid,
  p_request_id uuid,
  p_role text,
  p_image_digest text,
  p_worker_id uuid,
  p_generation_plan jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_generation_id uuid;
  v_deleted_at timestamptz;
  v_generation_status text;
  v_credit_lot_id uuid;
  v_consumed_at timestamptz;
  v_remaining integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_worker_id is null
     or p_generation_plan is null
     or pg_catalog.jsonb_typeof(p_generation_plan) <> 'object'
     or pg_catalog.octet_length(p_generation_plan::text) > 65536 then
    raise exception 'invalid_generation_preflight_commit'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.role <> p_role
     or v_reservation.image_digest <> p_image_digest then
    raise exception 'preflight_idempotency_conflict'
      using errcode = 'P0001';
  end if;
  if v_reservation.generation_id is null then
    raise exception 'preflight_generation_receipt_missing'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select g.status, g.credit_lot_id, g.consumed_at
    into v_generation_status, v_credit_lot_id, v_consumed_at
    from public.ai_generations g
   where g.id = v_reservation.generation_id
     and g.owner_id = p_user_id
   for update;
  if not found
     or (
       v_reservation.state <> 'committed'
       and (
         v_generation_status <> 'queued'
         or (
           v_reservation.requires_credit
           and (v_credit_lot_id is null or v_consumed_at is null)
         )
         or (
           not v_reservation.requires_credit
           and (v_credit_lot_id is not null or v_consumed_at is not null)
         )
       )
     ) then
    raise exception 'preflight_generation_receipt_invalid'
      using errcode = 'P0001';
  end if;
  if v_reservation.state = 'committed' then
    if v_reservation.generation_plan <> p_generation_plan then
      raise exception 'generation_plan_snapshot_conflict'
        using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'committed',
      'generation_id', v_reservation.generation_id,
      'remaining', null,
      'analysis', v_reservation.analysis_result,
      'generation_config', v_reservation.generation_config,
      'config_source', v_reservation.config_source,
      'config_version', v_reservation.config_version,
      'config_invalid', v_reservation.config_invalid,
      'generation_plan', v_reservation.generation_plan
    );
  end if;
  if v_reservation.state <> 'accepted' then
    raise exception 'preflight_not_accepted' using errcode = 'P0001';
  end if;
  if v_reservation.expires_at <= v_now then
    raise exception 'preflight_expired' using errcode = 'P0001';
  end if;

  v_generation_id := v_reservation.generation_id;
  select m.gen_credits
    into v_remaining
    from public.member_accounts m
   where m.user_id = p_user_id;

  update public.generation_preflight_reservations
     set state = 'committed',
         generation_id = v_generation_id,
         generation_plan = p_generation_plan,
         continuation_state = 'running',
         continuation_lease_token = p_worker_id,
         continuation_leased_until = v_now + interval '2 minutes',
         finalized_at = v_now,
         updated_at = v_now
   where id = p_request_id;
  update public.ai_generations
     set cost_preflight_pending = false
   where id = v_generation_id
     and cost_preflight_pending;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'committed',
    'generation_id', v_generation_id,
      'remaining', v_remaining,
    'analysis', v_reservation.analysis_result,
    'generation_config', v_reservation.generation_config,
    'config_source', v_reservation.config_source,
    'config_version', v_reservation.config_version,
    'config_invalid', v_reservation.config_invalid,
    'generation_plan', p_generation_plan
  );
end;
$$;
revoke all on function public.commit_generation_preflight(
  uuid, uuid, text, text, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_generation_preflight(
  uuid, uuid, text, text, uuid, jsonb
) to service_role;

create or replace function public.claim_generation_preflight_continuation(
  p_user_id uuid,
  p_request_id uuid,
  p_worker_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_deleted_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_user_id is null or p_request_id is null or p_worker_id is null then
    raise exception 'invalid_preflight_continuation' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.generation_id is null then
    raise exception 'preflight_idempotency_conflict'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found or v_reservation.owner_id <> p_user_id then
    raise exception 'preflight_idempotency_conflict'
      using errcode = 'P0001';
  end if;
  if v_reservation.state <> 'committed' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_committed'
    );
  end if;
  if v_reservation.continuation_state = 'submitted' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'submitted',
      'generation_id', v_reservation.generation_id
    );
  end if;
  if v_reservation.continuation_state = 'running'
     and v_reservation.continuation_lease_token <> p_worker_id
     and v_reservation.continuation_leased_until > v_now then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'processing',
      'generation_id', v_reservation.generation_id
    );
  end if;
  update public.generation_preflight_reservations
     set continuation_state = 'running',
         continuation_lease_token = p_worker_id,
         continuation_leased_until = v_now + interval '2 minutes',
         updated_at = v_now
   where id = p_request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'claimed',
    'generation_id', v_reservation.generation_id,
    'analysis', v_reservation.analysis_result,
    'generation_config', v_reservation.generation_config,
    'config_source', v_reservation.config_source,
    'config_version', v_reservation.config_version,
    'config_invalid', v_reservation.config_invalid,
    'generation_plan', v_reservation.generation_plan
  );
end;
$$;
revoke all on function public.claim_generation_preflight_continuation(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_preflight_continuation(
  uuid, uuid, uuid
) to service_role;

create or replace function public.complete_generation_preflight_continuation(
  p_user_id uuid,
  p_request_id uuid,
  p_worker_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.state <> 'committed' then
    raise exception 'preflight_continuation_forbidden'
      using errcode = 'P0001';
  end if;
  if v_reservation.continuation_state = 'submitted' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'submitted'
    );
  end if;
  if v_reservation.continuation_state <> 'running'
     or v_reservation.continuation_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  update public.generation_preflight_reservations
     set continuation_state = 'submitted',
         continuation_lease_token = null,
         continuation_leased_until = null,
         updated_at = pg_catalog.clock_timestamp()
   where id = p_request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'submitted'
  );
end;
$$;
revoke all on function public.complete_generation_preflight_continuation(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.complete_generation_preflight_continuation(
  uuid, uuid, uuid
) to service_role;

create or replace function public.release_generation_preflight(
  p_user_id uuid,
  p_request_id uuid,
  p_worker_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_worker_id is null
     or p_reason is null
     or p_reason !~ '^[a-z0-9_]{1,100}$' then
    raise exception 'invalid_preflight_release' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found or v_reservation.owner_id <> p_user_id then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'missing'
    );
  end if;
  if v_reservation.generation_id is null then
    raise exception 'preflight_generation_receipt_missing'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  if v_reservation.state = 'claimed'
     and v_reservation.analysis_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  if v_reservation.state = 'claimed' then
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_' || p_reason,
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = 'released',
           terminal_reason = p_reason,
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = p_request_id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'released'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', v_reservation.state
  );
end;
$$;
revoke all on function public.release_generation_preflight(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.release_generation_preflight(
  uuid, uuid, uuid, text
) to service_role;

-- Persist the exact Flux payload. 0086 intentionally persisted only hashes,
-- which cannot resume a planned candidate after process/deployment loss.
alter table public.generation_submit_intents
  add column if not exists input_payload jsonb;
alter table public.generation_submit_intents
  add column if not exists provider_output jsonb,
  add column if not exists provider_output_at timestamptz,
  add column if not exists provider_output_scrubbed_at timestamptz;
alter table public.generation_submit_intents
  drop constraint if exists generation_submit_input_payload_shape;
alter table public.generation_submit_intents
  add constraint generation_submit_input_payload_shape check (
    input_payload is null
    or (
      pg_catalog.jsonb_typeof(input_payload) = 'object'
      and pg_catalog.octet_length(input_payload::text) <= 65536
    )
  );
alter table public.generation_submit_intents
  drop constraint if exists generation_submit_provider_output_shape;
alter table public.generation_submit_intents
  add constraint generation_submit_provider_output_shape check (
    (provider_output is null) = (provider_output_at is null)
    and (provider_output is null or provider_output_scrubbed_at is null)
    and (
      provider_output is null
      or (
        pg_catalog.jsonb_typeof(provider_output) = 'object'
        and pg_catalog.octet_length(provider_output::text) <= 16384
        and provider_output ?& array['image', 'seed', 'nsfw']
        and provider_output - array['image', 'seed', 'nsfw']
              = '{}'::jsonb
        and pg_catalog.jsonb_typeof(provider_output->'image') = 'object'
        and (provider_output->'image')
              ?& array[
                'url', 'width', 'height', 'content_type', 'file_size'
              ]
        and (provider_output->'image')
              - array[
                'url', 'width', 'height', 'content_type', 'file_size'
              ] = '{}'::jsonb
        and pg_catalog.octet_length(
              provider_output->'image'->>'url'
            ) between 35 and 4096
        and provider_output->'image'->>'url'
              ~ '^https://v3b[.]fal[.]media/files/b/[^[:space:]#]+$'
        and pg_catalog.jsonb_typeof(
              provider_output->'image'->'width'
            ) = 'number'
        and (provider_output->'image'->>'width')::numeric
              between 1 and 40000000
        and (provider_output->'image'->>'width')::numeric
              = pg_catalog.floor(
                  (provider_output->'image'->>'width')::numeric
                )
        and pg_catalog.jsonb_typeof(
              provider_output->'image'->'height'
            ) = 'number'
        and (provider_output->'image'->>'height')::numeric
              between 1 and 40000000
        and (provider_output->'image'->>'height')::numeric
              = pg_catalog.floor(
                  (provider_output->'image'->>'height')::numeric
                )
        and (provider_output->'image'->>'width')::numeric
              * (provider_output->'image'->>'height')::numeric
              <= 40000000
        and (
          provider_output->'image'->'content_type' = 'null'::jsonb
          or provider_output->'image'->>'content_type' = 'image/jpeg'
        )
        and (
          provider_output->'image'->'file_size' = 'null'::jsonb
          or (
            pg_catalog.jsonb_typeof(
              provider_output->'image'->'file_size'
            ) = 'number'
            and (provider_output->'image'->>'file_size')::numeric >= 1
            and (provider_output->'image'->>'file_size')::numeric
                  <= 9007199254740991
            and (provider_output->'image'->>'file_size')::numeric
                  = pg_catalog.floor(
                      (provider_output->'image'->>'file_size')::numeric
                    )
          )
        )
        and pg_catalog.jsonb_typeof(provider_output->'seed') = 'number'
        and (provider_output->>'seed')::numeric >= 0
        and (provider_output->>'seed')::numeric <= 9007199254740991
        and (provider_output->>'seed')::numeric
              = pg_catalog.floor((provider_output->>'seed')::numeric)
        and pg_catalog.jsonb_typeof(provider_output->'nsfw') = 'boolean'
      )
    )
  );

create or replace function public.prepare_generation_submit_inputs(
  p_gen_id uuid,
  p_owner_id uuid,
  p_intents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations%rowtype;
  v_item jsonb;
  v_index integer;
  v_existing public.generation_submit_intents%rowtype;
  v_seen integer[] := array[]::integer[];
  v_params jsonb;
begin
  if p_gen_id is null
     or p_owner_id is null
     or pg_catalog.jsonb_typeof(p_intents) <> 'array'
     or pg_catalog.jsonb_array_length(p_intents) <> 3
     or pg_catalog.octet_length(p_intents::text) > 262144 then
    raise exception 'generation_submit_inputs_invalid'
      using errcode = '22023';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if g.owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'owner_mismatch'
    );
  end if;
  if g.status <> 'queued' or g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'terminal'
    );
  end if;

  v_params := g.gen_params;
  for v_item in
    select value from pg_catalog.jsonb_array_elements(p_intents)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (v_item->>'candidateIndex') !~ '^[0-2]$'
       or pg_catalog.jsonb_typeof(v_item->'input') <> 'object'
       or pg_catalog.octet_length((v_item->'input')::text) > 65536
       or (v_item->>'payloadHash') !~ '^[0-9a-f]{64}$'
       or (v_item->>'callbackTokenHash') !~ '^[0-9a-f]{64}$' then
      raise exception 'generation_submit_input_invalid'
        using errcode = '22023';
    end if;
    v_index := (v_item->>'candidateIndex')::integer;
    if v_index = any(v_seen) then
      raise exception 'generation_submit_candidate_duplicate'
        using errcode = '22023';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_index);

    insert into public.generation_submit_intents(
      generation_id,
      candidate_index,
      owner_id,
      payload_hash,
      callback_token_hash,
      input_payload
    )
    values (
      p_gen_id,
      v_index,
      p_owner_id,
      v_item->>'payloadHash',
      v_item->>'callbackTokenHash',
      v_item->'input'
    )
    on conflict (generation_id, candidate_index) do nothing;

    select *
      into v_existing
      from public.generation_submit_intents i
     where i.generation_id = p_gen_id
       and i.candidate_index = v_index
     for update;
    if v_existing.owner_id <> p_owner_id
       or v_existing.payload_hash <> v_item->>'payloadHash'
       or v_existing.callback_token_hash <>
            v_item->>'callbackTokenHash'
       or v_existing.input_payload is distinct from v_item->'input' then
      raise exception 'generation_submit_input_conflict'
        using errcode = 'P0001';
    end if;
    v_params := public.bp_0086_merge_generation_candidate(
      v_params,
      v_index,
      pg_catalog.jsonb_build_object(
        'submitState', v_existing.state,
        'payloadHash', v_existing.payload_hash
      )
    );
  end loop;
  update public.ai_generations
     set gen_params = v_params
   where id = p_gen_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared'
  );
end;
$$;
revoke all on function public.prepare_generation_submit_inputs(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_generation_submit_inputs(
  uuid, uuid, jsonb
) to service_role;

create or replace function public.get_generation_submit_preparation(
  p_gen_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_count integer;
  v_intents jsonb;
begin
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);
  select g.owner_id
    into v_owner
    from public.ai_generations g
   where g.id = p_gen_id
   for update;
  if not found or v_owner <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  select
    pg_catalog.count(*)::integer,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'candidate_index', i.candidate_index,
        'input', i.input_payload,
        'payload_hash', i.payload_hash,
        'callback_token_hash', i.callback_token_hash,
        'state', i.state
      )
      order by i.candidate_index
    )
    into v_count, v_intents
    from public.generation_submit_intents i
   where i.generation_id = p_gen_id;
  if v_count = 0 then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'missing'
    );
  end if;
  if v_count <> 3
     or exists (
       select 1
         from public.generation_submit_intents i
        where i.generation_id = p_gen_id
          and i.input_payload is null
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'incomplete'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared', 'intents', v_intents
  );
end;
$$;
revoke all on function public.get_generation_submit_preparation(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.get_generation_submit_preparation(
  uuid, uuid
) to service_role;

create or replace function public.record_generation_submit_provider_output(
  p_gen_id uuid,
  p_candidate_index integer,
  p_payload_hash text,
  p_callback_token_hash text,
  p_request_id text,
  p_output jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_intent public.generation_submit_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_gen_id is null
     or p_candidate_index is null
     or p_candidate_index not between 0 and 2
     or p_payload_hash is null
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_callback_token_hash is null
     or p_callback_token_hash !~ '^[0-9a-f]{64}$'
     or p_request_id is null
     or pg_catalog.octet_length(p_request_id) not between 1 and 256
     or p_request_id ~ '[[:cntrl:]]'
     or p_output is null
     or pg_catalog.jsonb_typeof(p_output) <> 'object'
     or pg_catalog.octet_length(p_output::text) > 16384 then
    raise exception 'generation_provider_output_invalid'
      using errcode = '22023';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  select g.owner_id
    into v_owner_id
    from public.ai_generations g
   where g.id = p_gen_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  perform public.bp_user_mutation_lock(v_owner_id);
  select *
    into v_intent
    from public.generation_submit_intents i
   where i.generation_id = p_gen_id
     and i.candidate_index = p_candidate_index
   for update;
  if not found
     or v_intent.owner_id <> v_owner_id
     or v_intent.payload_hash <> p_payload_hash
     or v_intent.callback_token_hash <> p_callback_token_hash
     or v_intent.request_id <> p_request_id
     or v_intent.webhook_status <> 'OK' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  if v_intent.provider_output_scrubbed_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_scrubbed'
    );
  end if;
  if v_intent.provider_output is not null then
    return pg_catalog.jsonb_build_object(
      'ok', v_intent.provider_output = p_output,
      'outcome', case
        when v_intent.provider_output = p_output then 'already_recorded'
        else 'result_conflict'
      end
    );
  end if;
  update public.generation_submit_intents
     set provider_output = p_output,
         provider_output_at = v_now
   where generation_id = p_gen_id
     and candidate_index = p_candidate_index;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'recorded'
  );
end;
$$;
revoke all on function public.record_generation_submit_provider_output(
  uuid, integer, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_submit_provider_output(
  uuid, integer, text, text, text, jsonb
) to service_role;

create or replace function public.list_generation_submit_provider_outputs(
  p_gen_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_outputs jsonb;
begin
  select g.owner_id
    into v_owner_id
    from public.ai_generations g
   where g.id = p_gen_id;
  if not found or v_owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'candidate_index', i.candidate_index,
        'request_id', i.request_id,
        'output', i.provider_output
      )
      order by i.candidate_index
    ),
    '[]'::jsonb
  )
    into v_outputs
    from public.generation_submit_intents i
   where i.generation_id = p_gen_id
     and i.provider_output is not null;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'listed', 'outputs', v_outputs
  );
end;
$$;
revoke all on function public.list_generation_submit_provider_outputs(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.list_generation_submit_provider_outputs(
  uuid, uuid
) to service_role;

-- Terminal materialization seals every candidate binding, including candidates
-- whose webhook has not replayed yet. This prevents a late duplicate from
-- reintroducing an expiring private-CDN URL after it was scrubbed.
create or replace function public.scrub_generation_submit_provider_outputs(
  p_gen_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations%rowtype;
  v_scrubbed integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_gen_id is null or p_owner_id is null then
    raise exception 'generation_provider_output_scrub_invalid'
      using errcode = '22023';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found or g.owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if g.status = 'queued' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_terminal'
    );
  end if;
  update public.generation_submit_intents
     set provider_output = null,
         provider_output_at = null,
         provider_output_scrubbed_at = v_now
   where generation_id = p_gen_id
     and provider_output_scrubbed_at is null;
  get diagnostics v_scrubbed = row_count;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', case
      when v_scrubbed = 0 then 'already_scrubbed'
      else 'scrubbed'
    end,
    'scrubbed', v_scrubbed
  );
end;
$$;
revoke all on function public.scrub_generation_submit_provider_outputs(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.scrub_generation_submit_provider_outputs(
  uuid, uuid
) to service_role;

create or replace function public.rebind_generation_submit_inputs(
  p_gen_id uuid,
  p_owner_id uuid,
  p_intents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations%rowtype;
  v_count integer;
  v_item jsonb;
  v_index integer;
  v_seen integer[] := array[]::integer[];
  v_intent public.generation_submit_intents%rowtype;
  v_params jsonb;
begin
  if p_gen_id is null
     or p_owner_id is null
     or pg_catalog.jsonb_typeof(p_intents) <> 'array'
     or pg_catalog.jsonb_array_length(p_intents) not between 1 and 3
     or pg_catalog.octet_length(p_intents::text) > 262144 then
    raise exception 'generation_submit_rebind_invalid'
      using errcode = '22023';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found or g.owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if g.status <> 'queued' or g.refunded_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'terminal'
    );
  end if;
  select pg_catalog.count(*)::integer
    into v_count
    from public.generation_submit_intents i
   where i.generation_id = p_gen_id
     and i.owner_id = p_owner_id
     and i.state = 'planned'
     and i.attempt_count = 0;
  if v_count <> pg_catalog.jsonb_array_length(p_intents) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'attempt_already_started'
    );
  end if;
  v_params := g.gen_params;
  for v_item in
    select value from pg_catalog.jsonb_array_elements(p_intents)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (v_item->>'candidateIndex') !~ '^[0-2]$'
       or pg_catalog.jsonb_typeof(v_item->'input') <> 'object'
       or pg_catalog.octet_length((v_item->'input')::text) > 65536
       or (v_item->>'payloadHash') !~ '^[0-9a-f]{64}$'
       or (v_item->>'callbackTokenHash') !~ '^[0-9a-f]{64}$' then
      raise exception 'generation_submit_rebind_item_invalid'
        using errcode = '22023';
    end if;
    v_index := (v_item->>'candidateIndex')::integer;
    if v_index = any(v_seen) then
      raise exception 'generation_submit_candidate_duplicate'
        using errcode = '22023';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_index);
    select *
      into v_intent
      from public.generation_submit_intents i
     where i.generation_id = p_gen_id
       and i.owner_id = p_owner_id
       and i.candidate_index = v_index
     for update;
    if not found
       or v_intent.state <> 'planned'
       or v_intent.attempt_count <> 0 then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'attempt_already_started'
      );
    end if;
    update public.generation_submit_intents
       set input_payload = v_item->'input',
           payload_hash = v_item->>'payloadHash',
           callback_token_hash = v_item->>'callbackTokenHash'
     where generation_id = p_gen_id
       and candidate_index = v_index;
    v_params := public.bp_0086_merge_generation_candidate(
      v_params,
      v_index,
      pg_catalog.jsonb_build_object(
        'submitState', 'planned',
        'payloadHash', v_item->>'payloadHash'
      )
    );
  end loop;
  update public.ai_generations
     set gen_params = v_params
   where id = p_gen_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared'
  );
end;
$$;
revoke all on function public.rebind_generation_submit_inputs(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.rebind_generation_submit_inputs(
  uuid, uuid, jsonb
) to service_role;

create or replace function public.claim_generation_submit_work(
  p_gen_id uuid,
  p_owner_id uuid,
  p_candidate_index integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.ai_generations%rowtype;
  i public.generation_submit_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_params jsonb;
begin
  if p_gen_id is null
     or p_owner_id is null
     or p_candidate_index not between 0 and 2 then
    raise exception 'generation_submit_work_invalid'
      using errcode = '22023';
  end if;
  perform public.bp_mutation_object_lock('generation', p_gen_id::text);
  perform public.bp_user_mutation_lock(p_owner_id);
  select *
    into g
    from public.ai_generations
   where id = p_gen_id
   for update;
  if not found or g.owner_id <> p_owner_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  select *
    into i
    from public.generation_submit_intents s
   where s.generation_id = p_gen_id
     and s.candidate_index = p_candidate_index
   for update;
  if not found or i.input_payload is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'intent_missing'
    );
  end if;
  insert into public.generation_cost_reconciliation_issues(
    issue_kind,
    object_key,
    owner_id,
    generation_id,
    candidate_index,
    state_snapshot,
    payload_hash,
    external_request_id,
    last_seen_at
  )
  select
    'flux_submit',
    s.generation_id::text || ':' || s.candidate_index::text,
    s.owner_id,
    s.generation_id,
    s.candidate_index,
    s.state,
    s.payload_hash,
    s.request_id,
    v_now
  from public.generation_submit_intents s
  where s.generation_id = p_gen_id
    and (
      (
        s.state in ('submitting', 'uncertain')
        and s.submit_started_at <= v_now - interval '200 minutes'
      )
      or s.state in ('conflict', 'late_acknowledged')
    )
  on conflict (issue_kind, object_key) do update
    set last_seen_at = excluded.last_seen_at,
        state_snapshot = excluded.state_snapshot,
        external_request_id = excluded.external_request_id
    where generation_cost_reconciliation_issues.status = 'open';
  if exists (
    select 1
    from public.generation_cost_reconciliation_issues q
    where q.status = 'open'
      and q.issue_kind = 'flux_submit'
      and q.generation_id = p_gen_id
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'manual_review'
    );
  end if;
  if i.state = 'planned'
     and i.attempt_count = 0
     and g.status = 'queued'
     and g.refunded_at is null then
    update public.generation_submit_intents
       set state = 'submitting',
           attempt_count = 1,
           submit_started_at = v_now
     where generation_id = p_gen_id
       and candidate_index = p_candidate_index;
    v_params := public.bp_0086_merge_generation_candidate(
      g.gen_params,
      p_candidate_index,
      pg_catalog.jsonb_build_object('submitState', 'submitting')
    );
    update public.ai_generations
       set gen_params = v_params
     where id = p_gen_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'claimed',
      'input', i.input_payload,
      'payload_hash', i.payload_hash,
      'callback_token_hash', i.callback_token_hash
    );
  end if;
  if i.state = 'acknowledged' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'acknowledged',
      'request_id', i.request_id
    );
  end if;
  if i.state in (
    'submitting', 'uncertain', 'conflict', 'late_acknowledged'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'in_flight', 'state', i.state
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', false, 'outcome', i.state
  );
end;
$$;
revoke all on function public.claim_generation_submit_work(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_submit_work(
  uuid, uuid, integer
) to service_role;

-- ── 2. Exactly-once birefnet submit/pick intents ──────────────────────────

create table if not exists public.generation_pick_intents (
  generation_id uuid primary key
    references public.ai_generations(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  candidate_index integer not null check (candidate_index between 0 and 2),
  attempt_id uuid not null unique,
  state text not null default 'claimed' check (
    state in (
      'claimed',
      'submitting',
      'uncertain',
      'acknowledged',
      'provider_done',
      'rejected',
      'committed',
      'expired'
    )
  ),
  input_payload jsonb,
  payload_hash text check (
    payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'
  ),
  callback_token_hash text check (
    callback_token_hash is null
    or callback_token_hash ~ '^[0-9a-f]{64}$'
  ),
  external_request_id text check (
    external_request_id is null
    or (
      char_length(external_request_id) between 1 and 256
      and external_request_id !~ '[[:cntrl:]]'
    )
  ),
  provider_result_url text check (
    provider_result_url is null
    or char_length(provider_result_url) between 1 and 4096
  ),
  rejection_status integer check (
    rejection_status is null
    or rejection_status between 100 and 599
  ),
  expires_at timestamptz not null
    default (pg_catalog.clock_timestamp() + interval '2 hours 5 minutes'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  external_started_at timestamptz,
  provider_done_at timestamptz,
  materialization_lease_token uuid,
  materialization_leased_until timestamptz,
  committed_at timestamptz,
  constraint generation_pick_submit_binding check (
    (
      state in ('claimed', 'expired')
      and payload_hash is null
      and callback_token_hash is null
      and external_started_at is null
    )
    or (
      state not in ('claimed', 'expired')
      and payload_hash is not null
      and callback_token_hash is not null
      and external_started_at is not null
    )
  ),
  constraint generation_pick_request_binding check (
    (state in ('acknowledged', 'provider_done', 'committed')
      and external_request_id is not null)
    or state not in ('acknowledged', 'provider_done', 'committed')
  ),
  constraint generation_pick_result_binding check (
    (state in ('provider_done', 'committed')
      and provider_result_url is not null
      and provider_done_at is not null)
    or state not in ('provider_done', 'committed')
  ),
  constraint generation_pick_commit_binding check (
    (state = 'committed' and committed_at is not null)
    or (state <> 'committed' and committed_at is null)
  ),
  constraint generation_pick_input_binding check (
    (
      state in ('claimed', 'expired')
      and input_payload is null
    )
    or (
      state not in ('claimed', 'expired')
      and pg_catalog.jsonb_typeof(input_payload) = 'object'
      and input_payload = pg_catalog.jsonb_build_object(
        'image_url', input_payload->>'image_url',
        'output_format', 'png'
      )
      and input_payload->>'output_format' = 'png'
      and pg_catalog.octet_length(input_payload->>'image_url')
            between 1 and 4096
      and input_payload->>'image_url' ~ '^https://'
    )
  ),
  constraint generation_pick_materialization_lease_shape check (
    (
      state = 'provider_done'
      and (
        (
          materialization_lease_token is null
          and materialization_leased_until is null
        )
        or (
          materialization_lease_token is not null
          and materialization_leased_until is not null
        )
      )
    )
    or (
      state <> 'provider_done'
      and materialization_lease_token is null
      and materialization_leased_until is null
    )
  )
);

comment on table public.generation_pick_intents is
  'One raw queue submission per generation pick. Ambiguous accepts remain fenced until signed webhook/request-id recovery.';

alter table public.generation_pick_intents enable row level security;
revoke all on table public.generation_pick_intents
  from public, anon, authenticated, service_role;
alter table public.generation_pick_intents
  add column if not exists input_payload jsonb,
  add column if not exists materialization_lease_token uuid,
  add column if not exists materialization_leased_until timestamptz;
alter table public.generation_pick_intents
  drop constraint if exists generation_pick_input_binding,
  add constraint generation_pick_input_binding check (
    (
      state in ('claimed', 'expired')
      and input_payload is null
    )
    or (
      state not in ('claimed', 'expired')
      and pg_catalog.jsonb_typeof(input_payload) = 'object'
      and input_payload = pg_catalog.jsonb_build_object(
        'image_url', input_payload->>'image_url',
        'output_format', 'png'
      )
      and input_payload->>'output_format' = 'png'
      and pg_catalog.octet_length(input_payload->>'image_url')
            between 1 and 4096
      and input_payload->>'image_url' ~ '^https://'
    )
  ),
  drop constraint if exists generation_pick_materialization_lease_shape,
  add constraint generation_pick_materialization_lease_shape check (
    (
      state = 'provider_done'
      and (
        (
          materialization_lease_token is null
          and materialization_leased_until is null
        )
        or (
          materialization_lease_token is not null
          and materialization_leased_until is not null
        )
      )
    )
    or (
      state <> 'provider_done'
      and materialization_lease_token is null
      and materialization_leased_until is null
    )
  );
create index if not exists generation_pick_intent_expiry_idx
  on public.generation_pick_intents(expires_at, generation_id)
  where state not in ('committed', 'rejected', 'expired');

create table if not exists public.generation_pick_cost_attempts (
  attempt_id uuid primary key,
  generation_id uuid not null,
  owner_id uuid not null,
  day_kst date not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint generation_pick_cost_day_matches check (
    day_kst = (created_at at time zone 'Asia/Seoul')::date
  )
);
comment on table public.generation_pick_cost_attempts is
  'Append-only authorization receipts consumed immediately before each raw Birefnet POST; retained independently of mutable pick intent state.';
alter table public.generation_pick_cost_attempts enable row level security;
revoke all on table public.generation_pick_cost_attempts
  from public, anon, authenticated, service_role;
create index if not exists generation_pick_cost_owner_day_idx
  on public.generation_pick_cost_attempts(owner_id, day_kst, attempt_id);
create index if not exists generation_pick_cost_day_idx
  on public.generation_pick_cost_attempts(day_kst, attempt_id);

create or replace function public.claim_generation_pick(
  p_user_id uuid,
  p_generation_id uuid,
  p_candidate_index integer,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_generation public.ai_generations%rowtype;
  v_intent public.generation_pick_intents%rowtype;
  v_expected_path text;
  v_deleted_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_user_id is null
     or p_generation_id is null
     or p_attempt_id is null
     or p_candidate_index not between 0 and 2 then
    raise exception 'invalid_generation_pick' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  perform public.bp_mutation_object_lock(
    'generation', p_generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'account_deleted'
    );
  end if;
  select *
    into v_generation
    from public.ai_generations g
   where g.id = p_generation_id
   for update;
  if not found or v_generation.owner_id <> p_user_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if v_generation.status = 'picked'
     and v_generation.picked_doll_id is not null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'already_picked',
      'doll_id', v_generation.picked_doll_id
    );
  end if;
  if v_generation.status <> 'done' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_selectable'
    );
  end if;
  v_expected_path :=
    p_user_id::text || '/candidates/' || p_generation_id::text
      || '/' || p_candidate_index::text || '.jpg';
  if not coalesce(
       v_generation.candidate_urls @>
         pg_catalog.jsonb_build_array(v_expected_path),
       false
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'candidate_not_found'
    );
  end if;

  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if found then
    if v_intent.owner_id <> p_user_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'candidate_conflict'
      );
    end if;
    if v_intent.candidate_index <> p_candidate_index
       and not (
         v_intent.state in ('rejected', 'expired')
         or (
           v_intent.state = 'claimed'
           and v_intent.expires_at <= v_now
         )
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'candidate_conflict'
      );
    end if;
    if v_intent.state = 'committed' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'already_picked',
        'doll_id', v_intent.attempt_id
      );
    elsif v_intent.state = 'provider_done'
          and v_intent.expires_at <= v_now then
      insert into public.generation_cost_reconciliation_issues(
        issue_kind,
        object_key,
        owner_id,
        generation_id,
        candidate_index,
        state_snapshot,
        payload_hash,
        external_request_id,
        last_seen_at
      )
      values (
        'pick_materialization',
        v_intent.generation_id::text || ':' || v_intent.attempt_id::text,
        v_intent.owner_id,
        v_intent.generation_id,
        v_intent.candidate_index,
        'provider_done',
        v_intent.payload_hash,
        v_intent.external_request_id,
        v_now
      )
      on conflict (issue_kind, object_key) do update
        set last_seen_at = excluded.last_seen_at
        where generation_cost_reconciliation_issues.status = 'open';
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'manual_review'
      );
    elsif v_intent.state = 'provider_done' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'provider_done',
        'attempt_id', v_intent.attempt_id,
        'request_id', v_intent.external_request_id,
        'result_url', v_intent.provider_result_url
      );
    elsif v_intent.state = 'acknowledged'
          and v_intent.expires_at <= v_now then
      insert into public.generation_cost_reconciliation_issues(
        issue_kind,
        object_key,
        owner_id,
        generation_id,
        candidate_index,
        state_snapshot,
        payload_hash,
        external_request_id,
        last_seen_at
      )
      values (
        'pick_submit',
        v_intent.generation_id::text || ':' || v_intent.attempt_id::text,
        v_intent.owner_id,
        v_intent.generation_id,
        v_intent.candidate_index,
        'acknowledged',
        v_intent.payload_hash,
        v_intent.external_request_id,
        v_now
      )
      on conflict (issue_kind, object_key) do update
        set last_seen_at = excluded.last_seen_at,
            state_snapshot = excluded.state_snapshot,
            external_request_id = excluded.external_request_id
        where generation_cost_reconciliation_issues.status = 'open';
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'manual_review'
      );
    elsif v_intent.state = 'acknowledged' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'resume',
        'attempt_id', v_intent.attempt_id,
        'request_id', v_intent.external_request_id
      );
    elsif v_intent.state in ('submitting', 'uncertain')
          and v_intent.expires_at <= v_now then
      insert into public.generation_cost_reconciliation_issues(
        issue_kind,
        object_key,
        owner_id,
        generation_id,
        candidate_index,
        state_snapshot,
        payload_hash,
        external_request_id,
        last_seen_at
      )
      values (
        'pick_submit',
        v_intent.generation_id::text || ':' || v_intent.attempt_id::text,
        v_intent.owner_id,
        v_intent.generation_id,
        v_intent.candidate_index,
        v_intent.state,
        v_intent.payload_hash,
        v_intent.external_request_id,
        v_now
      )
      on conflict (issue_kind, object_key) do update
        set last_seen_at = excluded.last_seen_at,
            state_snapshot = excluded.state_snapshot,
            external_request_id = excluded.external_request_id
        where generation_cost_reconciliation_issues.status = 'open';
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'manual_review'
      );
    elsif v_intent.state in ('submitting', 'uncertain') then
      -- A crash/timeout after raw submission starts is ambiguous, never proof
      -- of provider rejection. Keep it fenced until signed callback or manual
      -- reconciliation; an application retry must not submit a second charge.
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'processing',
        'attempt_id', v_intent.attempt_id
      );
    elsif v_intent.state = 'claimed' then
      if v_intent.expires_at <= v_now then
        update public.generation_pick_intents
           set attempt_id = p_attempt_id,
               candidate_index = p_candidate_index,
               expires_at = v_now + interval '2 hours 5 minutes',
               updated_at = v_now
         where generation_id = p_generation_id;
        return pg_catalog.jsonb_build_object(
          'ok', true, 'outcome', 'claimed', 'attempt_id', p_attempt_id
        );
      end if;
      if v_intent.attempt_id = p_attempt_id then
        return pg_catalog.jsonb_build_object(
          'ok', true,
          'outcome', 'claimed',
          'attempt_id', v_intent.attempt_id
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'processing',
        'attempt_id', v_intent.attempt_id
      );
    elsif v_intent.state = 'rejected'
          and v_intent.attempt_id = p_attempt_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'rejected'
      );
    elsif v_intent.state in ('rejected', 'expired') then
      update public.generation_pick_intents
         set attempt_id = p_attempt_id,
             candidate_index = p_candidate_index,
             state = 'claimed',
             input_payload = null,
             payload_hash = null,
             callback_token_hash = null,
             external_request_id = null,
             provider_result_url = null,
             rejection_status = null,
             expires_at = v_now + interval '2 hours 5 minutes',
             updated_at = v_now,
             external_started_at = null,
             provider_done_at = null,
             materialization_lease_token = null,
             materialization_leased_until = null,
             committed_at = null
       where generation_id = p_generation_id;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'outcome', 'claimed', 'attempt_id', p_attempt_id
      );
    end if;
  end if;

  insert into public.generation_pick_intents(
    generation_id,
    owner_id,
    candidate_index,
    attempt_id,
    state
  )
  values (
    p_generation_id,
    p_user_id,
    p_candidate_index,
    p_attempt_id,
    'claimed'
  );
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'claimed', 'attempt_id', p_attempt_id
  );
end;
$$;
revoke all on function public.claim_generation_pick(
  uuid, uuid, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_pick(
  uuid, uuid, integer, uuid
) to service_role;

create or replace function public.prepare_generation_pick_submit(
  p_user_id uuid,
  p_generation_id uuid,
  p_attempt_id uuid,
  p_input_payload jsonb,
  p_payload_hash text,
  p_callback_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_user_day_limit integer := 25;
  c_global_day_limit integer := 100;
  v_intent public.generation_pick_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (v_now at time zone 'Asia/Seoul')::date;
  v_deleted_at timestamptz;
  v_user_day integer;
  v_global_day integer;
begin
  if p_input_payload is null
     or pg_catalog.jsonb_typeof(p_input_payload) <> 'object'
     or p_input_payload <> pg_catalog.jsonb_build_object(
       'image_url', p_input_payload->>'image_url',
       'output_format', 'png'
     )
     or pg_catalog.octet_length(p_input_payload->>'image_url')
          not between 1 and 4096
     or p_input_payload->>'image_url' !~ '^https://'
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_callback_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_generation_pick_submit' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick-cost-day:' || v_today::text,
      0
    )
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'account_deleted'
    );
  end if;
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.owner_id <> p_user_id
     or v_intent.attempt_id <> p_attempt_id then
    raise exception 'pick_submit_forbidden' using errcode = 'P0001';
  end if;
  if v_intent.state = 'claimed' then
    select pg_catalog.count(*)::integer
      into v_user_day
      from public.generation_pick_cost_attempts a
     where a.owner_id = p_user_id
       and a.day_kst = v_today;
    select pg_catalog.count(*)::integer
      into v_global_day
      from public.generation_pick_cost_attempts a
     where a.day_kst = v_today;
    if v_user_day >= c_user_day_limit then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'user_day_quota'
      );
    end if;
    if v_global_day >= c_global_day_limit then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'global_day_quota'
      );
    end if;
    insert into public.generation_pick_cost_attempts(
      attempt_id, generation_id, owner_id, day_kst, created_at
    )
    values (
      p_attempt_id, p_generation_id, p_user_id, v_today, v_now
    );
    update public.generation_pick_intents
       set state = 'submitting',
           input_payload = p_input_payload,
           payload_hash = p_payload_hash,
           callback_token_hash = p_callback_token_hash,
           external_started_at = v_now,
           expires_at = v_now + interval '2 hours 5 minutes',
           updated_at = v_now
     where generation_id = p_generation_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'prepared'
    );
  end if;
  if v_intent.input_payload = p_input_payload
     and v_intent.payload_hash = p_payload_hash
     and v_intent.callback_token_hash = p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', v_intent.state
    );
  end if;
  raise exception 'pick_submit_binding_conflict' using errcode = 'P0001';
end;
$$;
revoke all on function public.prepare_generation_pick_submit(
  uuid, uuid, uuid, jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_generation_pick_submit(
  uuid, uuid, uuid, jsonb, text, text
) to service_role;

create or replace function public.record_generation_pick_submit_outcome(
  p_generation_id uuid,
  p_attempt_id uuid,
  p_payload_hash text,
  p_callback_token_hash text,
  p_outcome text,
  p_request_id text,
  p_http_status integer,
  p_webhook_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.generation_pick_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.attempt_id <> p_attempt_id
     or v_intent.payload_hash <> p_payload_hash
     or v_intent.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  if v_intent.state in ('provider_done', 'committed') then
    if p_request_id is not null
       and v_intent.external_request_id = p_request_id then
      return pg_catalog.jsonb_build_object(
        'ok', true, 'outcome', 'already_acknowledged'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'late_conflict'
    );
  end if;

  if p_outcome = 'acknowledged' then
    if p_request_id is null
       or char_length(p_request_id) not between 1 and 256
       or p_request_id ~ '[[:cntrl:]]'
       or (
         p_webhook_status is not null
         and p_webhook_status not in ('OK', 'ERROR')
       )
       then
      raise exception 'invalid_pick_submit_outcome' using errcode = '22023';
    end if;
    if v_intent.external_request_id is not null
       and v_intent.external_request_id <> p_request_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'request_id_conflict'
      );
    end if;
    update public.generation_pick_intents
       set state = case
             when p_webhook_status = 'ERROR' then 'rejected'
             else 'acknowledged'
           end,
           external_request_id = p_request_id,
           rejection_status = case
             when p_webhook_status = 'ERROR' then coalesce(p_http_status, 502)
             else null
           end,
           updated_at = v_now
     where generation_id = p_generation_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', case
        when p_webhook_status = 'ERROR' then 'rejected'
        else 'acknowledged'
      end
    );
  elsif p_outcome = 'uncertain' then
    if p_request_id is not null then
      raise exception 'invalid_pick_submit_outcome' using errcode = '22023';
    end if;
    if v_intent.state = 'submitting' then
      update public.generation_pick_intents
         set state = 'uncertain',
             rejection_status = p_http_status,
             updated_at = v_now
       where generation_id = p_generation_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'uncertain'
    );
  elsif p_outcome = 'rejected' then
    if p_request_id is not null
       or p_http_status is null
       or p_http_status not between 400 and 499 then
      raise exception 'invalid_pick_submit_outcome' using errcode = '22023';
    end if;
    update public.generation_pick_intents
       set state = 'rejected',
           rejection_status = p_http_status,
           updated_at = v_now
     where generation_id = p_generation_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'rejected'
    );
  else
    raise exception 'invalid_pick_submit_outcome' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.record_generation_pick_submit_outcome(
  uuid, uuid, text, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_pick_submit_outcome(
  uuid, uuid, text, text, text, text, integer, text
) to service_role;

create or replace function public.record_generation_pick_provider_result(
  p_user_id uuid,
  p_generation_id uuid,
  p_attempt_id uuid,
  p_request_id text,
  p_result_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.generation_pick_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_result_url is null
     or char_length(p_result_url) not between 1 and 4096 then
    raise exception 'invalid_pick_provider_result' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.owner_id <> p_user_id
     or v_intent.attempt_id <> p_attempt_id
     or v_intent.external_request_id <> p_request_id then
    raise exception 'pick_provider_result_forbidden'
      using errcode = 'P0001';
  end if;
  if v_intent.state = 'provider_done' then
    if v_intent.provider_result_url <> p_result_url then
      raise exception 'pick_provider_result_conflict'
        using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_recorded'
    );
  end if;
  if v_intent.state <> 'acknowledged' then
    raise exception 'pick_provider_result_not_expected'
      using errcode = 'P0001';
  end if;
  update public.generation_pick_intents
     set state = 'provider_done',
         provider_result_url = p_result_url,
         provider_done_at = v_now,
         expires_at = v_now + interval '6 hours',
         updated_at = v_now
   where generation_id = p_generation_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'recorded'
  );
end;
$$;
revoke all on function public.record_generation_pick_provider_result(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_pick_provider_result(
  uuid, uuid, uuid, text, text
) to service_role;

create or replace function public.record_generation_pick_webhook_result(
  p_generation_id uuid,
  p_attempt_id uuid,
  p_payload_hash text,
  p_callback_token_hash text,
  p_request_id text,
  p_status text,
  p_result_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.generation_pick_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_request_id is null
     or char_length(p_request_id) not between 1 and 256
     or p_request_id ~ '[[:cntrl:]]'
     or p_status not in ('OK', 'ERROR')
     or (
       p_status = 'OK'
       and (
         p_result_url is null
         or char_length(p_result_url) not between 1 and 4096
       )
     )
     or (p_status = 'ERROR' and p_result_url is not null) then
    raise exception 'invalid_pick_webhook_result' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.attempt_id <> p_attempt_id
     or v_intent.payload_hash <> p_payload_hash
     or v_intent.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  if v_intent.external_request_id is not null
     and v_intent.external_request_id <> p_request_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'request_id_conflict'
    );
  end if;
  if v_intent.state = 'committed' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'committed'
    );
  end if;
  if p_status = 'ERROR' then
    if v_intent.state = 'provider_done' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'late_conflict'
      );
    end if;
    update public.generation_pick_intents
       set state = 'rejected',
           external_request_id = p_request_id,
           rejection_status = 502,
           updated_at = v_now
     where generation_id = p_generation_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'rejected'
    );
  end if;
  if v_intent.state = 'provider_done' then
    if v_intent.provider_result_url <> p_result_url then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'result_conflict'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'provider_done'
    );
  end if;
  if v_intent.state not in (
       'submitting', 'uncertain', 'acknowledged'
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'state_conflict'
    );
  end if;
  update public.generation_pick_intents
     set state = 'provider_done',
         external_request_id = p_request_id,
         provider_result_url = p_result_url,
         provider_done_at = v_now,
         expires_at = v_now + interval '6 hours',
         rejection_status = null,
         updated_at = v_now
   where generation_id = p_generation_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'provider_done'
  );
end;
$$;
revoke all on function public.record_generation_pick_webhook_result(
  uuid, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_generation_pick_webhook_result(
  uuid, uuid, text, text, text, text, text
) to service_role;

create or replace function public.claim_generation_pick_materialization(
  p_user_id uuid,
  p_generation_id uuid,
  p_worker_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_intent public.generation_pick_intents%rowtype;
  v_deleted_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_generation_id is null or p_worker_id is null then
    raise exception 'invalid_pick_materialization'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  perform public.bp_mutation_object_lock(
    'generation', p_generation_id::text
  );
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or (p_user_id is not null and v_intent.owner_id <> p_user_id) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if v_intent.state = 'committed' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'committed',
      'doll_id', v_intent.attempt_id
    );
  end if;
  if v_intent.state <> 'provider_done' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', v_intent.state
    );
  end if;
  if v_intent.expires_at <= v_now then
    insert into public.generation_cost_reconciliation_issues(
      issue_kind,
      object_key,
      owner_id,
      generation_id,
      candidate_index,
      state_snapshot,
      payload_hash,
      external_request_id,
      last_seen_at
    )
    values (
      'pick_materialization',
      v_intent.generation_id::text || ':' || v_intent.attempt_id::text,
      v_intent.owner_id,
      v_intent.generation_id,
      v_intent.candidate_index,
      'provider_done',
      v_intent.payload_hash,
      v_intent.external_request_id,
      v_now
    )
    on conflict (issue_kind, object_key) do update
      set last_seen_at = excluded.last_seen_at
      where generation_cost_reconciliation_issues.status = 'open';
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'manual_review'
    );
  end if;

  perform public.bp_user_mutation_lock(v_intent.owner_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = v_intent.owner_id
   for key share;
  if not found or v_deleted_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'account_deleted'
    );
  end if;
  if v_intent.materialization_lease_token is not null
     and v_intent.materialization_lease_token <> p_worker_id
     and v_intent.materialization_leased_until > v_now then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'processing'
    );
  end if;
  update public.generation_pick_intents
     set materialization_lease_token = p_worker_id,
         materialization_leased_until = v_now + interval '5 minutes',
         updated_at = v_now
   where generation_id = p_generation_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'claimed',
    'owner_id', v_intent.owner_id,
    'candidate_index', v_intent.candidate_index,
    'attempt_id', v_intent.attempt_id,
    'result_url', v_intent.provider_result_url
  );
end;
$$;
revoke all on function public.claim_generation_pick_materialization(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.claim_generation_pick_materialization(
  uuid, uuid, uuid
) to service_role;

create or replace function public.list_generation_pick_materializations(
  p_limit integer default 20
)
returns table(generation_id uuid, owner_id uuid)
language sql
security definer
set search_path = ''
as $$
  select i.generation_id, i.owner_id
    from public.generation_pick_intents i
    join public.profiles p on p.id = i.owner_id
   where i.state = 'provider_done'
     and i.expires_at > pg_catalog.clock_timestamp()
     and p.deleted_at is null
     and (
       i.materialization_lease_token is null
       or i.materialization_leased_until
            <= pg_catalog.clock_timestamp()
     )
   order by i.provider_done_at, i.generation_id
   limit greatest(
     1, least(coalesce(p_limit, 20), 100)
   );
$$;
revoke all on function public.list_generation_pick_materializations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_generation_pick_materializations(integer)
  to service_role;

-- Server-side doll object intents are deterministic by the pick attempt UUID.
-- Make a committed/lost-response replay exact instead of creating a second
-- cleanup identity.
create or replace function public.create_doll_upload_intent(
  p_user_id uuid,
  p_doll_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_existing public.storage_upload_intents%rowtype;
  v_id uuid;
begin
  if p_user_id is null
     or p_doll_id is null
     or p_path <> (p_user_id::text || '/' || p_doll_id::text || '.png') then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('storage-path:dolls:' || p_path, 0)
  );
  select *
    into v_existing
    from public.storage_upload_intents i
   where i.bucket = 'dolls'
     and i.path = p_path
   for update;
  if found then
    if v_existing.owner_user_id <> p_user_id
       or v_existing.subject_id <> p_doll_id
       or v_existing.purpose <> 'doll_upload'
       or v_existing.status in ('pending', 'leased', 'cleaned') then
      raise exception 'upload_intent_forbidden' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'intent_id', v_existing.id
    );
  end if;
  insert into public.storage_upload_intents(
    owner_user_id,
    subject_id,
    purpose,
    bucket,
    path,
    status,
    confirmed_at
  )
  values (
    p_user_id,
    p_doll_id,
    'doll_upload',
    'dolls',
    p_path,
    'confirmed',
    pg_catalog.clock_timestamp()
  )
  returning id into v_id;
  return pg_catalog.jsonb_build_object('ok', true, 'intent_id', v_id);
end;
$$;
revoke all on function public.create_doll_upload_intent(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_doll_upload_intent(uuid, uuid, text)
  to service_role;

create or replace function public.commit_generation_pick(
  p_user_id uuid,
  p_generation_id uuid,
  p_candidate_index integer,
  p_attempt_id uuid,
  p_worker_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation public.ai_generations%rowtype;
  v_intent public.generation_pick_intents%rowtype;
  v_upload public.storage_upload_intents%rowtype;
  v_doll public.dolls%rowtype;
  v_deleted_at timestamptz;
  v_style jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_worker_id is null then
    raise exception 'pick_commit_forbidden' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select *
    into v_generation
    from public.ai_generations g
   where g.id = p_generation_id
   for update;
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.owner_id <> p_user_id
     or v_intent.candidate_index <> p_candidate_index
     or v_intent.attempt_id <> p_attempt_id
     or v_intent.state not in ('provider_done', 'committed')
     or (
       v_intent.state = 'provider_done'
       and v_intent.materialization_lease_token <> p_worker_id
     )
     or p_path <> (
       p_user_id::text || '/' || p_attempt_id::text || '.png'
     ) then
    raise exception 'pick_commit_forbidden' using errcode = 'P0001';
  end if;
  if v_generation.owner_id <> p_user_id then
    raise exception 'pick_commit_forbidden' using errcode = 'P0001';
  end if;
  if v_generation.status = 'picked'
     and v_generation.picked_doll_id = p_attempt_id
     and v_intent.state = 'committed' then
    select *
      into v_doll
      from public.dolls d
     where d.id = p_attempt_id;
    if not found then
      raise exception 'pick_commit_doll_missing' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_committed',
      'doll', pg_catalog.to_jsonb(v_doll)
    );
  end if;
  if v_generation.status <> 'done' then
    raise exception 'pick_commit_state_conflict' using errcode = 'P0001';
  end if;

  select *
    into v_upload
    from public.storage_upload_intents u
   where u.bucket = 'dolls'
     and u.path = p_path
   for update;
  if not found
     or v_upload.owner_user_id <> p_user_id
     or v_upload.subject_id <> p_attempt_id
     or v_upload.purpose <> 'doll_upload'
     or v_upload.status <> 'confirmed' then
    raise exception 'pick_commit_upload_unconfirmed'
      using errcode = 'P0001';
  end if;

  v_style := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'sourceGenerationId', p_generation_id,
    'candidateIndex', p_candidate_index
  );
  insert into public.dolls(
    id, owner_id, image_url, style_meta, role
  )
  values (
    p_attempt_id,
    p_user_id,
    p_path,
    v_style,
    v_generation.role
  )
  on conflict (id) do nothing;
  select *
    into v_doll
    from public.dolls d
   where d.id = p_attempt_id
   for update;
  if not found
     or v_doll.owner_id <> p_user_id
     or v_doll.image_url <> p_path
     or v_doll.role <> v_generation.role
     or v_doll.style_meta <> v_style then
    raise exception 'pick_commit_doll_conflict' using errcode = 'P0001';
  end if;

  update public.ai_generations
     set status = 'picked',
         picked_doll_id = p_attempt_id,
         picked_index = p_candidate_index
   where id = p_generation_id;
  update public.generation_pick_intents
     set state = 'committed',
         materialization_lease_token = null,
         materialization_leased_until = null,
         committed_at = v_now,
         updated_at = v_now
   where generation_id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'committed',
    'doll', pg_catalog.to_jsonb(v_doll)
  );
end;
$$;
revoke all on function public.commit_generation_pick(
  uuid, uuid, integer, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.commit_generation_pick(
  uuid, uuid, integer, uuid, uuid, text
) to service_role;

-- ── 3. Bounded/idempotent signed-upload issuance ──────────────────────────

alter table public.storage_upload_intents
  add column if not exists issuance_request_id uuid,
  add column if not exists quota_actor_key text,
  add column if not exists token_issue_count integer not null default 0,
  add column if not exists last_token_horizon timestamptz;
alter table public.storage_upload_intents
  drop constraint if exists storage_upload_intent_actor_key_check;
alter table public.storage_upload_intents
  add constraint storage_upload_intent_actor_key_check check (
    quota_actor_key is null or quota_actor_key ~ '^[0-9a-f]{64}$'
  );
alter table public.storage_upload_intents
  drop constraint if exists storage_upload_intent_token_issue_check;
alter table public.storage_upload_intents
  add constraint storage_upload_intent_token_issue_check check (
    token_issue_count between 0 and 2
    and (
      (token_issue_count = 0 and last_token_horizon is null)
      or (token_issue_count > 0 and last_token_horizon is not null)
    )
  );
create unique index if not exists storage_upload_intent_request_uidx
  on public.storage_upload_intents(
    owner_user_id, purpose, issuance_request_id
  )
  where issuance_request_id is not null;
create index if not exists storage_upload_intent_issuance_day_idx
  on public.storage_upload_intents(created_at, purpose, owner_user_id);
create index if not exists storage_upload_intent_actor_day_idx
  on public.storage_upload_intents(
    quota_actor_key, created_at, purpose
  )
  where quota_actor_key is not null;

create table if not exists public.storage_upload_token_issues (
  intent_id uuid not null
    references public.storage_upload_intents(id) on delete restrict,
  issue_sequence integer not null check (issue_sequence between 1 and 2),
  owner_user_id uuid not null,
  purpose text not null check (
    purpose in (
      'site_asset_og',
      'site_asset_logo',
      'event_image',
      'avatar_upload',
      'highlight_upload'
    )
  ),
  quota_actor_key text not null check (
    quota_actor_key ~ '^[0-9a-f]{64}$'
  ),
  day_kst date not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (intent_id, issue_sequence),
  constraint storage_upload_token_issue_day_matches check (
    day_kst = (created_at at time zone 'Asia/Seoul')::date
  )
);
alter table public.storage_upload_token_issues enable row level security;
revoke all on table public.storage_upload_token_issues
  from public, anon, authenticated, service_role;
create index if not exists storage_upload_token_issue_day_idx
  on public.storage_upload_token_issues(day_kst, purpose, intent_id);
create index if not exists storage_upload_token_issue_actor_day_idx
  on public.storage_upload_token_issues(
    quota_actor_key, day_kst, purpose, intent_id
  );
create index if not exists storage_upload_token_issue_owner_day_idx
  on public.storage_upload_token_issues(
    owner_user_id, day_kst, purpose, intent_id
  );

-- A Supabase signed-upload token remains reusable for roughly two hours. If an
-- attached avatar/highlight is detached and removed immediately, the same
-- still-live token can PUT the orphan back after the cleanup receipt becomes
-- terminal. Fence detached-object cleanup through the intent horizon plus a
-- five-minute skew allowance. The existing worker removes, then performs an
-- existence recheck before it marks the receipt complete.
do $$
begin
  if exists (
    select 1
      from public.storage_object_cleanup_jobs j
      join public.storage_upload_intents i
        on i.bucket = j.bucket
       and i.path = j.path
     where j.status = 'leased'
       and i.purpose in ('avatar_upload', 'highlight_upload')
       and coalesce(i.last_token_horizon, i.expires_at)
             > pg_catalog.clock_timestamp()
  ) then
    raise exception
      '008901 preflight: live-token detached cleanup lease in progress';
  end if;
end;
$$;

update public.storage_object_cleanup_jobs j
   set status = 'pending',
       lease_token = null,
       leased_until = null,
       next_attempt_at = greatest(
         j.next_attempt_at,
         coalesce(i.last_token_horizon, i.expires_at)
       ),
       last_error = null,
       completed_at = null,
       updated_at = pg_catalog.clock_timestamp()
  from public.storage_upload_intents i
 where i.bucket = j.bucket
   and i.path = j.path
   and i.purpose in ('avatar_upload', 'highlight_upload')
   and coalesce(i.last_token_horizon, i.expires_at)
         > pg_catalog.clock_timestamp()
   and j.status in ('pending', 'completed');

create or replace function public.bp_enqueue_detached_storage_asset(
  p_kind text,
  p_user_id uuid,
  p_subject_id uuid,
  p_bucket text,
  p_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_not_before timestamptz := pg_catalog.clock_timestamp();
  v_upload_expires_at timestamptz;
begin
  if p_path is null or p_path = '' then
    return null;
  end if;
  if not (
    (p_kind in ('avatar_clear', 'avatar_replace')
      and p_bucket = 'avatars')
    or (p_kind in ('doll_delete', 'doll_create_compensation')
      and p_bucket = 'dolls')
    or (p_kind = 'highlight_expired' and p_bucket = 'highlights')
  ) then
    raise exception 'invalid_cleanup_target' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-path:' || p_bucket || ':' || p_path,
      0
    )
  );
  if public.bp_storage_path_is_referenced(p_bucket, p_path) then
    return null;
  end if;

  if p_bucket in ('avatars', 'highlights') then
    select coalesce(i.last_token_horizon, i.expires_at)
      into v_upload_expires_at
      from public.storage_upload_intents i
     where i.bucket = p_bucket
       and i.path = p_path
       and (
         (p_bucket = 'avatars' and i.purpose = 'avatar_upload')
         or (
           p_bucket = 'highlights'
           and i.purpose = 'highlight_upload'
         )
       )
     for update;
    if found then
      v_not_before := greatest(
        v_not_before,
        v_upload_expires_at
      );
    end if;
  end if;

  insert into public.storage_object_cleanup_jobs(
    kind,
    user_id,
    subject_id,
    bucket,
    path,
    next_attempt_at
  )
  values (
    p_kind,
    p_user_id,
    p_subject_id,
    p_bucket,
    p_path,
    v_not_before
  )
  on conflict (bucket, path) do update
     set kind = excluded.kind,
         user_id = excluded.user_id,
         subject_id = excluded.subject_id,
         status = 'pending',
         lease_token = null,
         leased_until = null,
         next_attempt_at = greatest(
           public.storage_object_cleanup_jobs.next_attempt_at,
           excluded.next_attempt_at
         ),
         last_error = null,
         completed_at = null,
         updated_at = pg_catalog.clock_timestamp()
   where public.storage_object_cleanup_jobs.status
           in ('canceled', 'completed')
  returning id into v_id;

  if v_id is null then
    select j.id
      into v_id
      from public.storage_object_cleanup_jobs j
     where j.bucket = p_bucket
       and j.path = p_path;
  end if;
  return v_id;
end;
$$;
revoke all on function public.bp_enqueue_detached_storage_asset(
  text, uuid, uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function public.claim_storage_object_cleanup(
  p_job_id uuid default null,
  p_lease_seconds int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.storage_object_cleanup_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds int := greatest(
    15,
    least(coalesce(p_lease_seconds, 120), 600)
  );
begin
  with candidate as (
    select j.id
      from public.storage_object_cleanup_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and not public.bp_storage_path_is_referenced(j.bucket, j.path)
       and not exists (
         select 1
           from public.storage_upload_intents i
          where i.bucket = j.bucket
            and i.path = j.path
            and i.purpose in ('avatar_upload', 'highlight_upload')
            and coalesce(i.last_token_horizon, i.expires_at)
                  > pg_catalog.clock_timestamp()
       )
       and (
         (
           j.status = 'pending'
           and j.next_attempt_at <= pg_catalog.clock_timestamp()
         )
         or (
           j.status = 'leased'
           and j.leased_until <= pg_catalog.clock_timestamp()
         )
       )
     order by j.next_attempt_at, j.created_at, j.id
     limit 1
     for update skip locked
  )
  update public.storage_object_cleanup_jobs j
     set status = 'leased',
         lease_version = j.lease_version + 1,
         lease_token = v_token,
         leased_until =
           pg_catalog.clock_timestamp()
             + pg_catalog.make_interval(secs => v_seconds),
         attempt_count = j.attempt_count + 1,
         updated_at = pg_catalog.clock_timestamp()
    from candidate c
   where j.id = c.id
  returning j.* into v_job;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'job_id', v_job.id,
    'kind', v_job.kind,
    'user_id', v_job.user_id,
    'subject_id', v_job.subject_id,
    'bucket', v_job.bucket,
    'path', v_job.path,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count
  );
end;
$$;
revoke all on function public.claim_storage_object_cleanup(uuid, int)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_storage_object_cleanup(uuid, int)
  to service_role;

create or replace function public.bp_create_bounded_storage_upload_intent(
  p_owner_user_id uuid,
  p_subject_id uuid,
  p_purpose text,
  p_bucket text,
  p_path text,
  p_request_id uuid,
  p_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_global_day_limit integer;
  v_actor_day_limit integer;
  v_owner_day_limit integer;
  v_actor_outstanding_limit integer;
  v_owner_outstanding_limit integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_existing public.storage_upload_intents%rowtype;
  v_deleted_at timestamptz;
  v_score_owner uuid;
  v_score_review text;
  v_global_day integer;
  v_actor_day integer;
  v_owner_day integer;
  v_actor_outstanding integer;
  v_owner_outstanding integer;
  v_subject_outstanding integer;
  v_id uuid;
  v_expires_at timestamptz;
  v_issue_sequence integer;
  v_units_needed integer;
begin
  if p_owner_user_id is null
     or p_request_id is null
     or p_actor_key is null
     or p_actor_key !~ '^[0-9a-f]{64}$'
     or p_purpose not in (
       'site_asset_og',
       'site_asset_logo',
       'event_image',
       'avatar_upload',
       'highlight_upload'
     )
     or p_bucket not in (
       'site-assets', 'events', 'avatars', 'highlights'
     )
     or p_path is null
     or char_length(p_path) not between 1 and 512 then
    raise exception 'invalid_upload_intent' using errcode = '22023';
  end if;

  if p_purpose = 'avatar_upload' then
    v_global_day_limit := 500;
    v_actor_day_limit := 10;
    v_owner_day_limit := 10;
    v_actor_outstanding_limit := 2;
    v_owner_outstanding_limit := 2;
  elsif p_purpose = 'highlight_upload' then
    v_global_day_limit := 100;
    v_actor_day_limit := 5;
    v_owner_day_limit := 5;
    v_actor_outstanding_limit := 2;
    v_owner_outstanding_limit := 2;
  else
    v_global_day_limit := 100;
    v_actor_day_limit := 50;
    v_owner_day_limit := 50;
    v_actor_outstanding_limit := 5;
    v_owner_outstanding_limit := 5;
  end if;

  -- Lock order is stable request -> purpose/day global -> opaque actor ->
  -- canonical user. All mutable authority is re-read after those locks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-upload-request:' || p_owner_user_id::text || ':'
        || p_purpose || ':' || p_request_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-upload-day:' || p_purpose || ':' || v_today::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-upload-actor:' || p_actor_key,
      0
    )
  );
  perform public.bp_user_mutation_lock(p_owner_user_id);

  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_owner_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  if p_purpose in ('site_asset_og', 'site_asset_logo', 'event_image') then
    perform public.bp_assert_active_admin(p_owner_user_id);
  elsif p_purpose = 'highlight_upload' then
    if p_subject_id is null then
      raise exception 'invalid_upload_intent' using errcode = 'P0001';
    end if;
    select s.owner_id, s.review_status
      into v_score_owner, v_score_review
      from public.scores s
     where s.id = p_subject_id
     for key share;
    if not found or v_score_owner <> p_owner_user_id then
      raise exception 'forbidden' using errcode = 'P0001';
    end if;
    if v_score_review not in ('registered', 'cleared') then
      raise exception 'score_not_publishable' using errcode = 'P0001';
    end if;
    if exists (
      select 1
        from public.score_highlights h
       where h.score_id = p_subject_id
    ) then
      raise exception 'already_set' using errcode = 'P0001';
    end if;
  end if;

  -- Canonical path/purpose binding is repeated inside this locked authority;
  -- outer wrappers are only early validation and cannot authorize a stale
  -- account, score, or admin snapshot.
  if not (
    (
      p_purpose = 'avatar_upload'
      and p_subject_id is null
      and p_bucket = 'avatars'
      and p_path ~ (
        '^' || p_owner_user_id::text || '/' || p_request_id::text
          || '\.(png|jpg|webp)$'
      )
    )
    or (
      p_purpose = 'highlight_upload'
      and p_bucket = 'highlights'
      and p_path ~ (
        '^' || p_subject_id::text || '/' || p_request_id::text
          || '\.(mp4|webm)$'
      )
    )
    or (
      p_purpose = 'site_asset_og'
      and p_subject_id is null
      and p_bucket = 'site-assets'
      and p_path ~ (
        '^og/[0-9]{6}/' || p_request_id::text
          || '\.(png|jpg|webp)$'
      )
    )
    or (
      p_purpose = 'site_asset_logo'
      and p_subject_id is null
      and p_bucket = 'site-assets'
      and p_path ~ (
        '^logo/[0-9]{6}/' || p_request_id::text
          || '\.(png|jpg|webp)$'
      )
    )
    or (
      p_purpose = 'event_image'
      and p_subject_id is null
      and p_bucket = 'events'
      and p_path ~ (
        '^[0-9]{6}/' || p_request_id::text
          || '\.(png|jpg|webp|gif)$'
      )
    )
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;

  select *
    into v_existing
    from public.storage_upload_intents i
   where i.owner_user_id = p_owner_user_id
     and i.purpose = p_purpose
     and i.issuance_request_id = p_request_id
   for update;
  if not found then
    -- Rolling adoption: 0079 receipts predate issuance_request_id. The
    -- canonical path already embeds the new request UUID, so an exact
    -- owner/purpose/path match can be upgraded in place. Count the possible
    -- legacy token as issue #1, leaving only one bounded response-loss issue;
    -- every mismatch fails closed instead of creating a second receipt.
    select *
      into v_existing
      from public.storage_upload_intents i
     where i.bucket = p_bucket
       and i.path = p_path
     for update;
    if found then
      if v_existing.owner_user_id <> p_owner_user_id
         or v_existing.subject_id is distinct from p_subject_id
         or v_existing.purpose <> p_purpose
         or v_existing.issuance_request_id is not null
         or v_existing.quota_actor_key is not null
         or v_existing.token_issue_count <> 0
         or v_existing.status <> 'issued' then
        raise exception 'upload_idempotency_conflict'
          using errcode = 'P0001';
      end if;
      update public.storage_upload_intents
         set issuance_request_id = p_request_id,
             quota_actor_key = p_actor_key,
             token_issue_count = 1,
             last_token_horizon = greatest(v_existing.expires_at, v_now),
             updated_at = v_now
       where id = v_existing.id
      returning * into v_existing;
      insert into public.storage_upload_token_issues(
        intent_id,
        issue_sequence,
        owner_user_id,
        purpose,
        quota_actor_key,
        day_kst,
        created_at
      )
      values (
        v_existing.id,
        1,
        p_owner_user_id,
        p_purpose,
        p_actor_key,
        v_today,
        v_now
      );
    end if;
  end if;
  if v_existing.id is not null then
    if v_existing.subject_id is distinct from p_subject_id
       or v_existing.bucket <> p_bucket
       or v_existing.path <> p_path
       or v_existing.quota_actor_key <> p_actor_key then
      raise exception 'upload_idempotency_conflict' using errcode = 'P0001';
    end if;
    if v_existing.status <> 'issued'
       or v_existing.token_issue_count >= 2 then
      raise exception 'upload_token_replay_exhausted'
        using errcode = 'P0001';
    end if;
    v_id := v_existing.id;
    v_issue_sequence := v_existing.token_issue_count + 1;
    if exists (
      select 1
      from public.storage_upload_token_issues q
      where q.intent_id = v_existing.id
        and q.issue_sequence = 1
        and q.day_kst = v_today
    ) then
      -- The first same-day issue reserved this one bounded response-loss
      -- replay, so converting the reservation to an actual token consumes no
      -- new day unit.
      v_units_needed := 0;
    else
      -- A replay across the KST day boundary was not reserved today.
      v_units_needed := 1;
    end if;
  else
    v_issue_sequence := 1;
    -- One initial token plus exactly one possible response-loss replay.
    v_units_needed := 2;
  end if;

  select (
      select pg_catalog.count(*)::integer
      from public.storage_upload_token_issues q
      where q.purpose = p_purpose
        and q.day_kst = v_today
    ) + (
      select pg_catalog.count(*)::integer
      from public.storage_upload_intents r
      join public.storage_upload_token_issues first_issue
        on first_issue.intent_id = r.id
       and first_issue.issue_sequence = 1
       and first_issue.day_kst = v_today
      where r.purpose = p_purpose
        and r.token_issue_count = 1
    )
    into v_global_day
  ;
  select (
      select pg_catalog.count(*)::integer
      from public.storage_upload_token_issues q
      where q.quota_actor_key = p_actor_key
        and q.purpose = p_purpose
        and q.day_kst = v_today
    ) + (
      select pg_catalog.count(*)::integer
      from public.storage_upload_intents r
      join public.storage_upload_token_issues first_issue
        on first_issue.intent_id = r.id
       and first_issue.issue_sequence = 1
       and first_issue.day_kst = v_today
      where r.quota_actor_key = p_actor_key
        and r.purpose = p_purpose
        and r.token_issue_count = 1
    )
    into v_actor_day
  ;
  select (
      select pg_catalog.count(*)::integer
      from public.storage_upload_token_issues q
      where q.owner_user_id = p_owner_user_id
        and q.purpose = p_purpose
        and q.day_kst = v_today
    ) + (
      select pg_catalog.count(*)::integer
      from public.storage_upload_intents r
      join public.storage_upload_token_issues first_issue
        on first_issue.intent_id = r.id
       and first_issue.issue_sequence = 1
       and first_issue.day_kst = v_today
      where r.owner_user_id = p_owner_user_id
        and r.purpose = p_purpose
        and r.token_issue_count = 1
    )
    into v_owner_day
  ;
  select pg_catalog.count(*)::integer
    into v_actor_outstanding
    from public.storage_upload_intents i
   where i.quota_actor_key = p_actor_key
     and i.purpose = p_purpose
     and i.status in ('issued', 'confirmed')
     and i.expires_at > v_now
     and (v_existing.id is null or i.id <> v_existing.id);
  select pg_catalog.count(*)::integer
    into v_owner_outstanding
    from public.storage_upload_intents i
   where i.owner_user_id = p_owner_user_id
     and i.purpose = p_purpose
     and i.status in ('issued', 'confirmed')
     and i.expires_at > v_now
     and (v_existing.id is null or i.id <> v_existing.id);
  if p_purpose = 'highlight_upload' then
    select pg_catalog.count(*)::integer
      into v_subject_outstanding
      from public.storage_upload_intents i
     where i.subject_id = p_subject_id
       and i.purpose = 'highlight_upload'
       and i.status in ('issued', 'confirmed')
       and i.expires_at > v_now
       and (v_existing.id is null or i.id <> v_existing.id);
  else
    v_subject_outstanding := 0;
  end if;

  if v_global_day + v_units_needed > v_global_day_limit then
    raise exception 'upload_global_day_quota' using errcode = 'P0001';
  elsif v_actor_day + v_units_needed > v_actor_day_limit then
    raise exception 'upload_actor_day_quota' using errcode = 'P0001';
  elsif v_owner_day + v_units_needed > v_owner_day_limit then
    raise exception 'upload_owner_day_quota' using errcode = 'P0001';
  elsif v_actor_outstanding >= v_actor_outstanding_limit then
    raise exception 'upload_actor_outstanding_quota' using errcode = 'P0001';
  elsif v_owner_outstanding >= v_owner_outstanding_limit then
    raise exception 'upload_owner_outstanding_quota' using errcode = 'P0001';
  elsif v_subject_outstanding >= 1 then
    raise exception 'upload_subject_outstanding_quota' using errcode = 'P0001';
  end if;

  v_expires_at := v_now + interval '2 hours 5 minutes';
  if v_existing.id is null then
    insert into public.storage_upload_intents(
      owner_user_id,
      subject_id,
      purpose,
      bucket,
      path,
      issuance_request_id,
      quota_actor_key,
      token_issue_count,
      last_token_horizon,
      expires_at,
      cleanup_after,
      next_attempt_at
    )
    values (
      p_owner_user_id,
      p_subject_id,
      p_purpose,
      p_bucket,
      p_path,
      p_request_id,
      p_actor_key,
      1,
      v_expires_at,
      v_expires_at,
      v_expires_at,
      v_expires_at
    )
    returning id into v_id;
  else
    update public.storage_upload_intents
       set token_issue_count = v_issue_sequence,
           last_token_horizon = v_expires_at,
           expires_at = v_expires_at,
           cleanup_after = v_expires_at,
           next_attempt_at = v_expires_at,
           updated_at = v_now
     where id = v_id;
  end if;
  insert into public.storage_upload_token_issues(
    intent_id,
    issue_sequence,
    owner_user_id,
    purpose,
    quota_actor_key,
    day_kst,
    created_at
  )
  values (
    v_id,
    v_issue_sequence,
    p_owner_user_id,
    p_purpose,
    p_actor_key,
    v_today,
    v_now
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'intent_id', v_id,
    'expires_at', v_expires_at,
    'token_issue_sequence', v_issue_sequence
  );
end;
$$;
revoke all on function public.bp_create_bounded_storage_upload_intent(
  uuid, uuid, text, text, text, uuid, text
) from public, anon, authenticated, service_role;

-- New exact-idempotency overloads. The HMAC actor is supplied by the app and
-- never contains raw IP/Auth identifiers.
create or replace function public.create_avatar_upload_intent(
  p_user_id uuid,
  p_path text,
  p_request_id uuid,
  p_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  if p_path !~ (
    '^' || p_user_id::text || '/' || v_uuid_pattern || '\.(png|jpg|webp)$'
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;
  return public.bp_create_bounded_storage_upload_intent(
    p_user_id, null, 'avatar_upload', 'avatars', p_path,
    p_request_id, p_actor_key
  );
end;
$$;
revoke all on function public.create_avatar_upload_intent(
  uuid, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_avatar_upload_intent(
  uuid, text, uuid, text
) to service_role;

create or replace function public.create_highlight_upload_intent(
  p_user_id uuid,
  p_score_id uuid,
  p_path text,
  p_request_id uuid,
  p_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_path !~ (
    '^' || p_score_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-'
      || '[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$'
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;
  return public.bp_create_bounded_storage_upload_intent(
    p_user_id, p_score_id, 'highlight_upload', 'highlights', p_path,
    p_request_id, p_actor_key
  );
end;
$$;
revoke all on function public.create_highlight_upload_intent(
  uuid, uuid, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_highlight_upload_intent(
  uuid, uuid, text, uuid, text
) to service_role;

create or replace function public.create_admin_storage_upload_intent(
  p_admin_id uuid,
  p_purpose text,
  p_bucket text,
  p_path text,
  p_request_id uuid,
  p_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  if not (
    (
      p_purpose = 'site_asset_og'
      and p_bucket = 'site-assets'
      and p_path ~ ('^og/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$')
    )
    or (
      p_purpose = 'site_asset_logo'
      and p_bucket = 'site-assets'
      and p_path ~ ('^logo/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$')
    )
    or (
      p_purpose = 'event_image'
      and p_bucket = 'events'
      and p_path ~ ('^[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp|gif)$')
    )
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;
  return public.bp_create_bounded_storage_upload_intent(
    p_admin_id, null, p_purpose, p_bucket, p_path,
    p_request_id, p_actor_key
  );
end;
$$;
revoke all on function public.create_admin_storage_upload_intent(
  uuid, text, text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_admin_storage_upload_intent(
  uuid, text, text, text, uuid, text
) to service_role;

-- Bounded rolling compatibility. Legacy routes cannot provide a network HMAC,
-- so each owner receives a deterministic opaque legacy actor. Global/day and
-- owner caps still make random anonymous UUID rotation finite.
create or replace function public.create_avatar_upload_intent(
  p_user_id uuid,
  p_path text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.create_avatar_upload_intent(
    p_user_id,
    p_path,
    (pg_catalog.regexp_match(
      p_path,
      '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.'
    ))[1]::uuid,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to('legacy-upload:' || p_user_id::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  );
$$;
revoke all on function public.create_avatar_upload_intent(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_avatar_upload_intent(uuid, text)
  to service_role;

create or replace function public.create_highlight_upload_intent(
  p_user_id uuid,
  p_score_id uuid,
  p_path text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.create_highlight_upload_intent(
    p_user_id,
    p_score_id,
    p_path,
    (pg_catalog.regexp_match(
      p_path,
      '/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.'
    ))[1]::uuid,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to('legacy-upload:' || p_user_id::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  );
$$;
revoke all on function public.create_highlight_upload_intent(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_highlight_upload_intent(
  uuid, uuid, text
) to service_role;

create or replace function public.create_admin_storage_upload_intent(
  p_admin_id uuid,
  p_purpose text,
  p_bucket text,
  p_path text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.create_admin_storage_upload_intent(
    p_admin_id,
    p_purpose,
    p_bucket,
    p_path,
    (pg_catalog.regexp_match(
      p_path,
      '/?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.'
    ))[1]::uuid,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to('legacy-upload:' || p_admin_id::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  );
$$;
revoke all on function public.create_admin_storage_upload_intent(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_admin_storage_upload_intent(
  uuid, text, text, text
) to service_role;

-- The application rejects the same sizes/MIME after upload; Storage must also
-- reject them while the token is still unattached. Existing production
-- inventory (avatars <=148301 JPEG, highlights <=3936275 MP4) fits.
insert into storage.buckets(id, name, public)
values
  ('dolls', 'dolls', false),
  ('avatars', 'avatars', true),
  ('highlights', 'highlights', false),
  ('events', 'events', true),
  ('site-assets', 'site-assets', true)
on conflict (id) do update
  set name = excluded.name,
      public = excluded.public;

do $$
declare
  v_bad bigint;
begin
  select pg_catalog.count(*)
    into v_bad
    from storage.objects o
   where o.bucket_id = 'avatars'
     and (
       coalesce((o.metadata->>'size') ~ '^[0-9]+$', false) is false
       or case
            when coalesce((o.metadata->>'size') ~ '^[0-9]+$', false)
              then (o.metadata->>'size')::numeric > 524288
            else false
          end
       or pg_catalog.lower(coalesce(o.metadata->>'mimetype', ''))
          not in ('image/png', 'image/jpeg', 'image/webp')
     );
  if v_bad > 0 then
    raise exception '008901 preflight: incompatible avatar objects=%', v_bad;
  end if;
  select pg_catalog.count(*)
    into v_bad
    from storage.objects o
   where o.bucket_id = 'highlights'
     and (
       coalesce((o.metadata->>'size') ~ '^[0-9]+$', false) is false
       or case
            when coalesce((o.metadata->>'size') ~ '^[0-9]+$', false)
              then (o.metadata->>'size')::numeric > 4194304
            else false
          end
       or pg_catalog.lower(coalesce(o.metadata->>'mimetype', ''))
          not in ('video/mp4', 'video/webm')
     );
  if v_bad > 0 then
    raise exception '008901 preflight: incompatible highlight objects=%', v_bad;
  end if;
  select pg_catalog.count(*)
    into v_bad
    from storage.objects o
   where o.bucket_id = 'events'
     and (
       coalesce((o.metadata->>'size') ~ '^[0-9]+$', false) is false
       or case
            when coalesce((o.metadata->>'size') ~ '^[0-9]+$', false)
              then (o.metadata->>'size')::numeric > 5242880
            else false
          end
       or pg_catalog.lower(coalesce(o.metadata->>'mimetype', ''))
          not in (
            'image/png', 'image/jpeg', 'image/webp', 'image/gif'
          )
     );
  if v_bad > 0 then
    raise exception '008901 preflight: incompatible event objects=%', v_bad;
  end if;
  select pg_catalog.count(*)
    into v_bad
    from storage.objects o
   where o.bucket_id = 'site-assets'
     and (
       coalesce((o.metadata->>'size') ~ '^[0-9]+$', false) is false
       or case
            when coalesce((o.metadata->>'size') ~ '^[0-9]+$', false)
              then (o.metadata->>'size')::numeric > 5242880
            else false
          end
       or pg_catalog.lower(coalesce(o.metadata->>'mimetype', ''))
          not in ('image/png', 'image/jpeg', 'image/webp')
     );
  if v_bad > 0 then
    raise exception '008901 preflight: incompatible site objects=%', v_bad;
  end if;
end;
$$;

update storage.buckets
   set file_size_limit = 524288,
       allowed_mime_types = array[
         'image/png', 'image/jpeg', 'image/webp'
       ]::text[]
 where id = 'avatars';
update storage.buckets
   set file_size_limit = 4194304,
       allowed_mime_types = array[
         'video/mp4', 'video/webm'
       ]::text[]
 where id = 'highlights';
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array[
         'image/png', 'image/jpeg', 'image/webp', 'image/gif'
       ]::text[]
 where id = 'events';
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array[
         'image/png', 'image/jpeg', 'image/webp'
       ]::text[]
 where id = 'site-assets';

-- ── 4. Public doll signed-URL egress quota ────────────────────────────────

alter table public.public_write_quota_buckets
  drop constraint if exists public_write_quota_endpoint_check;
alter table public.public_write_quota_buckets
  add constraint public_write_quota_endpoint_check check (
    endpoint in (
      'telemetry', 'track', 'score', 'report', 'doll_signed_urls'
    )
  );

create or replace function public.consume_doll_signed_url_quota(
  p_actor_key text,
  p_units integer
)
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  c_global_unit_limit integer := 10000;
  c_actor_unit_limit integer := 1000;
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_global integer;
  v_actor integer;
begin
  if p_actor_key is null
     or p_actor_key !~ '^[0-9a-f]{64}$'
     or p_units is null
     or p_units < 1
     or p_units > 100 then
    return 'invalid_actor';
  end if;
  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values ('doll_signed_urls', v_today, 'global')
  on conflict (endpoint, day_kst, actor_key) do nothing;
  select q.request_count
    into strict v_global
    from public.public_write_quota_buckets q
   where q.endpoint = 'doll_signed_urls'
     and q.day_kst = v_today
     and q.actor_key = 'global'
   for update;
  if v_global + p_units > c_global_unit_limit then
    return 'global_request_quota';
  end if;

  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values ('doll_signed_urls', v_today, p_actor_key)
  on conflict (endpoint, day_kst, actor_key) do nothing;
  select q.request_count
    into strict v_actor
    from public.public_write_quota_buckets q
   where q.endpoint = 'doll_signed_urls'
     and q.day_kst = v_today
     and q.actor_key = p_actor_key
   for update;
  if v_actor + p_units > c_actor_unit_limit then
    return 'actor_request_quota';
  end if;
  update public.public_write_quota_buckets q
     set request_count = q.request_count + p_units,
         updated_at = pg_catalog.clock_timestamp()
   where q.endpoint = 'doll_signed_urls'
     and q.day_kst = v_today
     and q.actor_key in ('global', p_actor_key);
  return 'accepted';
exception
  when lock_not_available or query_canceled then
    return 'quota_busy';
end;
$$;
revoke all on function public.consume_doll_signed_url_quota(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_doll_signed_url_quota(text, integer)
  to service_role;

-- Rolling compatibility is still finite. New application code must call the
-- unit-aware overload with the exact validated id/transform cost.
create or replace function public.consume_doll_signed_url_quota(
  p_actor_key text
)
returns text
language sql
security definer
set search_path = ''
as $$
  select public.consume_doll_signed_url_quota(p_actor_key, 1);
$$;
revoke all on function public.consume_doll_signed_url_quota(text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_doll_signed_url_quota(text)
  to service_role;

-- ── 5. Bounded retention/expiry maintenance ──────────────────────────────

create or replace function public.list_generation_cost_reconciliation_issues(
  p_limit integer default 100
)
returns table(
  issue_id uuid,
  issue_kind text,
  object_key text,
  owner_id uuid,
  generation_id uuid,
  reservation_id uuid,
  candidate_index integer,
  state_snapshot text,
  payload_hash text,
  external_request_id text,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_generation_cost_reconciliation_limit'
      using errcode = '22023';
  end if;
  return query
    select
      i.id,
      i.issue_kind,
      i.object_key,
      i.owner_id,
      i.generation_id,
      i.reservation_id,
      i.candidate_index,
      i.state_snapshot,
      i.payload_hash,
      i.external_request_id,
      i.first_seen_at,
      i.last_seen_at
    from public.generation_cost_reconciliation_issues i
    where i.status = 'open'
    order by i.first_seen_at, i.id
    limit p_limit;
end;
$$;
revoke all on function
  public.list_generation_cost_reconciliation_issues(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.list_generation_cost_reconciliation_issues(integer)
  to service_role;

create or replace function public.resolve_generation_cost_reconciliation_issue(
  p_issue_id uuid,
  p_resolution_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issue public.generation_cost_reconciliation_issues%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_issue_id is null
     or p_resolution_note is null
     or pg_catalog.octet_length(p_resolution_note) not between 1 and 1000
     or p_resolution_note ~ '[[:cntrl:]]' then
    raise exception 'invalid_generation_cost_reconciliation_resolution'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-cost-reconciliation:' || p_issue_id::text,
      0
    )
  );
  select *
    into v_issue
    from public.generation_cost_reconciliation_issues i
   where i.id = p_issue_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if v_issue.status = 'resolved' then
    if v_issue.resolution_note <> p_resolution_note then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'resolution_conflict'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_resolved'
    );
  end if;
  update public.generation_cost_reconciliation_issues
     set status = 'resolved',
         resolution_note = p_resolution_note,
         resolved_at = v_now,
         last_seen_at = v_now
   where id = p_issue_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'resolved'
  );
end;
$$;
revoke all on function
  public.resolve_generation_cost_reconciliation_issue(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.resolve_generation_cost_reconciliation_issue(uuid, text)
  to service_role;

create or replace function public.prune_generation_cost_controls(
  p_limit integer default 2000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_candidate record;
  v_reservation public.generation_preflight_reservations%rowtype;
  v_terminal jsonb;
  v_expired integer := 0;
  v_face_cost_deleted integer := 0;
  v_face_intent_deleted integer := 0;
  v_preflight_deleted integer := 0;
  v_flux_intent_deleted integer := 0;
  v_pick_cost_deleted integer := 0;
  v_pick_intent_deleted integer := 0;
  v_upload_issue_deleted integer := 0;
  v_upload_intent_deleted integer := 0;
  v_rows integer := 0;
  v_manual_observed integer := 0;
  v_manual_open integer := 0;
  v_expiry_backlog integer := 0;
  v_retention_backlog integer := 0;
  v_provider_output_scrubbed integer := 0;
  v_provider_output_scrub_backlog integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'invalid_generation_cost_prune_limit'
      using errcode = '22023';
  end if;
  -- Materialize every expired ambiguous accept boundary before any retention
  -- work. ON CONFLICT only refreshes evidence; a resolved issue is never
  -- silently reopened or interpreted as permission to retry.
  insert into public.generation_cost_reconciliation_issues(
    issue_kind,
    object_key,
    owner_id,
    generation_id,
    reservation_id,
    candidate_index,
    state_snapshot,
    payload_hash,
    external_request_id,
    last_seen_at
  )
  select
    'face_submit',
    r.id::text || ':' || i.check_key,
    r.owner_id,
    r.generation_id,
    r.id,
    null,
    i.state,
    i.payload_hash,
    i.external_request_id,
    v_now
  from public.generation_face_check_intents i
  join public.generation_preflight_reservations r
    on r.id = i.reservation_id
  where i.state in ('submitting', 'uncertain')
    and r.expires_at <= v_now
  order by r.expires_at, r.id, i.check_key
  limit p_limit
  on conflict (issue_kind, object_key) do update
    set last_seen_at = excluded.last_seen_at,
        state_snapshot = excluded.state_snapshot,
        external_request_id = excluded.external_request_id
    where generation_cost_reconciliation_issues.status = 'open';
  get diagnostics v_manual_observed = row_count;

  insert into public.generation_cost_reconciliation_issues(
    issue_kind,
    object_key,
    owner_id,
    generation_id,
    reservation_id,
    candidate_index,
    state_snapshot,
    payload_hash,
    external_request_id,
    last_seen_at
  )
  select
    'flux_submit',
    i.generation_id::text || ':' || i.candidate_index::text,
    i.owner_id,
    i.generation_id,
    null,
    i.candidate_index,
    i.state,
    i.payload_hash,
    i.request_id,
    v_now
  from public.generation_submit_intents i
  where (
      i.state in ('submitting', 'uncertain')
      and i.submit_started_at <= v_now - interval '200 minutes'
    )
    or i.state in ('conflict', 'late_acknowledged')
  order by i.submit_started_at, i.generation_id, i.candidate_index
  limit p_limit
  on conflict (issue_kind, object_key) do update
    set last_seen_at = excluded.last_seen_at,
        state_snapshot = excluded.state_snapshot,
        external_request_id = excluded.external_request_id
    where generation_cost_reconciliation_issues.status = 'open';
  get diagnostics v_rows = row_count;
  v_manual_observed := v_manual_observed + v_rows;

  insert into public.generation_cost_reconciliation_issues(
    issue_kind,
    object_key,
    owner_id,
    generation_id,
    reservation_id,
    candidate_index,
    state_snapshot,
    payload_hash,
    external_request_id,
    last_seen_at
  )
  select
    'pick_submit',
    i.generation_id::text || ':' || i.attempt_id::text,
    i.owner_id,
    i.generation_id,
    null,
    i.candidate_index,
    i.state,
    i.payload_hash,
    i.external_request_id,
    v_now
  from public.generation_pick_intents i
  where i.state in ('submitting', 'uncertain', 'acknowledged')
    and i.expires_at <= v_now
  order by i.expires_at, i.generation_id
  limit p_limit
  on conflict (issue_kind, object_key) do update
    set last_seen_at = excluded.last_seen_at,
        state_snapshot = excluded.state_snapshot,
        external_request_id = excluded.external_request_id
    where generation_cost_reconciliation_issues.status = 'open';
  get diagnostics v_rows = row_count;
  v_manual_observed := v_manual_observed + v_rows;

  insert into public.generation_cost_reconciliation_issues(
    issue_kind,
    object_key,
    owner_id,
    generation_id,
    reservation_id,
    candidate_index,
    state_snapshot,
    payload_hash,
    external_request_id,
    last_seen_at
  )
  select
    'pick_materialization',
    i.generation_id::text || ':' || i.attempt_id::text,
    i.owner_id,
    i.generation_id,
    null,
    i.candidate_index,
    'provider_done',
    i.payload_hash,
    i.external_request_id,
    v_now
  from public.generation_pick_intents i
  where i.state = 'provider_done'
    and i.expires_at <= v_now
  order by i.expires_at, i.generation_id
  limit p_limit
  on conflict (issue_kind, object_key) do update
    set last_seen_at = excluded.last_seen_at,
        external_request_id = excluded.external_request_id
    where generation_cost_reconciliation_issues.status = 'open';
  get diagnostics v_rows = row_count;
  v_manual_observed := v_manual_observed + v_rows;

  -- Refund one financial receipt at a time under the same
  -- request->generation-object->user lock order as live mutations. A refund
  -- acknowledgement is a hard prerequisite for terminalizing the reservation.
  for v_candidate in
    select r.id
      from public.generation_preflight_reservations r
     where r.state in ('claimed', 'accepted')
       and r.expires_at <= v_now
     order by r.expires_at, r.id
     limit p_limit
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'generation-preflight:' || v_candidate.id::text,
        0
      )
    );
    select *
      into v_reservation
      from public.generation_preflight_reservations r
     where r.id = v_candidate.id;
    if not found
       or v_reservation.state not in ('claimed', 'accepted')
       or v_reservation.expires_at > v_now
       or v_reservation.generation_id is null then
      continue;
    end if;
    perform public.bp_mutation_object_lock(
      'generation', v_reservation.generation_id::text
    );
    perform public.bp_user_mutation_lock(v_reservation.owner_id);
    select *
      into v_reservation
      from public.generation_preflight_reservations r
     where r.id = v_candidate.id
     for update;
    if not found
       or v_reservation.state not in ('claimed', 'accepted')
       or v_reservation.expires_at > v_now then
      continue;
    end if;
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_claim_expired',
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = 'expired',
           terminal_reason = 'claim_expired',
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = v_reservation.id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
    v_expired := v_expired + 1;
  end loop;

  -- Private fal CDN URLs are useful only until our durable materialization.
  -- Seal terminal bindings immediately and all remaining bindings after the
  -- provider's six-hour lifecycle. A seal also prevents late webhook replay
  -- from reintroducing the URL.
  with target as (
    select i.generation_id, i.candidate_index
      from public.generation_submit_intents i
      join public.ai_generations g on g.id = i.generation_id
     where i.provider_output_scrubbed_at is null
       and (
         g.status <> 'queued'
         or coalesce(
              i.provider_output_at,
              i.acknowledged_at,
              i.submit_started_at,
              i.created_at
            ) <= v_now - interval '6 hours'
       )
     order by
       coalesce(
         i.provider_output_at,
         i.acknowledged_at,
         i.submit_started_at,
         i.created_at
       ),
       i.generation_id,
       i.candidate_index
     limit p_limit
  )
  update public.generation_submit_intents i
     set provider_output = null,
         provider_output_at = null,
         provider_output_scrubbed_at = v_now
    from target
   where i.generation_id = target.generation_id
     and i.candidate_index = target.candidate_index;
  get diagnostics v_provider_output_scrubbed = row_count;

  -- Child-first retention. Open reconciliation evidence and ambiguous provider
  -- states are excluded from deletion by construction.
  with target as (
    select a.reservation_id, a.check_key
    from public.generation_face_check_cost_attempts a
    join public.generation_preflight_reservations r
      on r.id = a.reservation_id
    where r.finalized_at < v_now - interval '35 days'
      and r.state not in ('claimed', 'accepted')
      and not exists (
        select 1
        from public.generation_cost_reconciliation_issues q
        where q.status = 'open'
          and q.reservation_id = r.id
      )
    order by r.finalized_at, a.reservation_id, a.check_key
    limit p_limit
  )
  delete from public.generation_face_check_cost_attempts a
  using target
  where a.reservation_id = target.reservation_id
    and a.check_key = target.check_key;
  get diagnostics v_face_cost_deleted = row_count;

  with target as (
    select i.reservation_id, i.check_key
    from public.generation_face_check_intents i
    join public.generation_preflight_reservations r
      on r.id = i.reservation_id
    where r.finalized_at < v_now - interval '35 days'
      and r.state not in ('claimed', 'accepted')
      and not exists (
        select 1
        from public.generation_face_check_cost_attempts a
        where a.reservation_id = i.reservation_id
          and a.check_key = i.check_key
      )
      and not exists (
        select 1
        from public.generation_cost_reconciliation_issues q
        where q.status = 'open'
          and q.reservation_id = r.id
      )
    order by r.finalized_at, i.reservation_id, i.check_key
    limit p_limit
  )
  delete from public.generation_face_check_intents i
  using target
  where i.reservation_id = target.reservation_id
    and i.check_key = target.check_key;
  get diagnostics v_face_intent_deleted = row_count;

  with target as (
    select r.id
    from public.generation_preflight_reservations r
    where r.finalized_at < v_now - interval '35 days'
      and r.state not in ('claimed', 'accepted')
      and not exists (
        select 1 from public.generation_face_check_intents i
        where i.reservation_id = r.id
      )
      and not exists (
        select 1
        from public.generation_cost_reconciliation_issues q
        where q.status = 'open'
          and q.reservation_id = r.id
      )
    order by r.finalized_at, r.id
    limit p_limit
  )
  delete from public.generation_preflight_reservations r
  using target
  where r.id = target.id;
  get diagnostics v_preflight_deleted = row_count;

  with target as (
    select i.generation_id, i.candidate_index
    from public.generation_submit_intents i
    join public.ai_generations g on g.id = i.generation_id
    where i.created_at < v_now - interval '35 days'
      and i.state not in ('submitting', 'uncertain', 'conflict',
                          'late_acknowledged')
      and g.status <> 'queued'
      and not exists (
        select 1
        from public.generation_cost_reconciliation_issues q
        where q.status = 'open'
          and q.issue_kind = 'flux_submit'
          and q.generation_id = i.generation_id
          and q.candidate_index = i.candidate_index
      )
    order by i.created_at, i.generation_id, i.candidate_index
    limit p_limit
  )
  delete from public.generation_submit_intents i
  using target
  where i.generation_id = target.generation_id
    and i.candidate_index = target.candidate_index;
  get diagnostics v_flux_intent_deleted = row_count;

  with target as (
    select a.attempt_id
    from public.generation_pick_cost_attempts a
    join public.generation_pick_intents i
      on i.attempt_id = a.attempt_id
    where i.updated_at < v_now - interval '35 days'
      and i.state in ('rejected', 'committed', 'expired')
      and not exists (
        select 1
        from public.generation_cost_reconciliation_issues q
        where q.status = 'open'
          and q.issue_kind = 'pick_submit'
          and q.generation_id = i.generation_id
      )
    order by i.updated_at, a.attempt_id
    limit p_limit
  )
  delete from public.generation_pick_cost_attempts a
  using target
  where a.attempt_id = target.attempt_id;
  get diagnostics v_pick_cost_deleted = row_count;

  with target as (
    select i.generation_id
    from public.generation_pick_intents i
    where i.updated_at < v_now - interval '35 days'
      and i.state in ('rejected', 'committed', 'expired')
      and not exists (
        select 1 from public.generation_pick_cost_attempts a
        where a.attempt_id = i.attempt_id
      )
      and not exists (
        select 1
        from public.generation_cost_reconciliation_issues q
        where q.status = 'open'
          and q.issue_kind = 'pick_submit'
          and q.generation_id = i.generation_id
      )
    order by i.updated_at, i.generation_id
    limit p_limit
  )
  delete from public.generation_pick_intents i
  using target
  where i.generation_id = target.generation_id;
  get diagnostics v_pick_intent_deleted = row_count;

  with target as (
    select q.intent_id, q.issue_sequence
    from public.storage_upload_token_issues q
    join public.storage_upload_intents i on i.id = q.intent_id
    where q.created_at < v_now - interval '35 days'
      and i.status in ('attached', 'cleaned')
    order by q.created_at, q.intent_id, q.issue_sequence
    limit p_limit
  )
  delete from public.storage_upload_token_issues q
  using target
  where q.intent_id = target.intent_id
    and q.issue_sequence = target.issue_sequence;
  get diagnostics v_upload_issue_deleted = row_count;

  with target as (
    select i.id
    from public.storage_upload_intents i
    where i.created_at < v_now - interval '35 days'
      and i.status in ('attached', 'cleaned')
      and not exists (
        select 1 from public.storage_upload_token_issues q
        where q.intent_id = i.id
      )
    order by i.created_at, i.id
    limit p_limit
  )
  delete from public.storage_upload_intents i
  using target
  where i.id = target.id;
  get diagnostics v_upload_intent_deleted = row_count;

  select pg_catalog.count(*)::integer
    into v_manual_open
    from public.generation_cost_reconciliation_issues i
   where i.status = 'open';
  select pg_catalog.count(*)::integer
    into v_expiry_backlog
    from public.generation_preflight_reservations r
   where r.state in ('claimed', 'accepted')
     and r.expires_at <= v_now;
  select pg_catalog.count(*)::integer
    into v_provider_output_scrub_backlog
    from public.generation_submit_intents i
    join public.ai_generations g on g.id = i.generation_id
   where i.provider_output_scrubbed_at is null
     and (
       g.status <> 'queued'
       or coalesce(
            i.provider_output_at,
            i.acknowledged_at,
            i.submit_started_at,
            i.created_at
          ) <= v_now - interval '6 hours'
     );
  select (
    select pg_catalog.count(*) from public.generation_face_check_intents i
    join public.generation_preflight_reservations r
      on r.id = i.reservation_id
    where r.finalized_at < v_now - interval '35 days'
      and r.state not in ('claimed', 'accepted')
  )::integer + (
    select pg_catalog.count(*) from public.generation_submit_intents i
    join public.ai_generations g on g.id = i.generation_id
    where i.created_at < v_now - interval '35 days'
      and g.status <> 'queued'
      and i.state not in ('submitting', 'uncertain', 'conflict',
                          'late_acknowledged')
  )::integer + (
    select pg_catalog.count(*) from public.generation_pick_intents i
    where i.updated_at < v_now - interval '35 days'
      and i.state in ('rejected', 'committed', 'expired')
  )::integer + (
    select pg_catalog.count(*) from public.storage_upload_intents i
    where i.created_at < v_now - interval '35 days'
      and i.status in ('attached', 'cleaned')
  )::integer
  into v_retention_backlog;

  return pg_catalog.jsonb_build_object(
    'ok', v_manual_open = 0
      and v_expiry_backlog = 0
      and v_provider_output_scrub_backlog = 0
      and v_retention_backlog = 0,
    'expired', v_expired,
    'manual_review_observed', v_manual_observed,
    'manual_review_open', v_manual_open,
    'expiry_backlog', v_expiry_backlog,
    'provider_output_scrubbed', v_provider_output_scrubbed,
    'provider_output_scrub_backlog',
      v_provider_output_scrub_backlog,
    'retention_backlog', v_retention_backlog,
    'deleted', pg_catalog.jsonb_build_object(
      'face_costs', v_face_cost_deleted,
      'face_intents', v_face_intent_deleted,
      'preflights', v_preflight_deleted,
      'flux_intents', v_flux_intent_deleted,
      'pick_costs', v_pick_cost_deleted,
      'pick_intents', v_pick_intent_deleted,
      'upload_token_issues', v_upload_issue_deleted,
      'upload_intents', v_upload_intent_deleted
    )
  );
end;
$$;
revoke all on function public.prune_generation_cost_controls(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_generation_cost_controls(integer)
  to service_role;

-- A provider terminal webhook proves that candidate has already fetched its
-- signed face input. Once all three candidate intents either have terminal
-- webhook evidence or were definitively rejected before provider admission,
-- the application may delete the raw generation face immediately.
create or replace function public.get_generation_face_cleanup_readiness(
  p_generation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_total integer;
  v_terminal integer;
begin
  if p_generation_id is null then
    raise exception 'invalid_generation_face_cleanup'
      using errcode = '22023';
  end if;
  select g.owner_id
    into v_owner_id
    from public.ai_generations g
   where g.id = p_generation_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where i.webhook_status in ('OK', 'ERROR')
         or i.state = 'rejected'
    )::integer
    into v_total, v_terminal
    from public.generation_submit_intents i
   where i.generation_id = p_generation_id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'owner_id', v_owner_id,
    'ready', v_total = 3 and v_terminal = 3
  );
end;
$$;
revoke all on function public.get_generation_face_cleanup_readiness(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_generation_face_cleanup_readiness(uuid)
  to service_role;

-- ── 6. Exact postflight + journal ─────────────────────────────────────────

drop function if exists public.claim_generation_preflight(
  uuid, uuid, text, text, boolean
);
drop function if exists public.record_generation_preflight_result(
  uuid, uuid, text, text, text, jsonb, text
);
drop function if exists public.commit_generation_preflight(
  uuid, uuid, text, text
);
drop function if exists public.release_generation_preflight(
  uuid, uuid, text
);
drop function if exists public.prepare_generation_pick_submit(
  uuid, uuid, uuid, text, text
);
drop function if exists public.commit_generation_pick(
  uuid, uuid, integer, uuid, text
);

do $$
declare
  v_avatar_limit bigint;
  v_highlight_limit bigint;
  v_event_limit bigint;
  v_site_limit bigint;
  v_avatar_mimes text[];
  v_highlight_mimes text[];
  v_event_mimes text[];
  v_site_mimes text[];
  v_table regclass;
  v_function regprocedure;
begin
  select b.file_size_limit, b.allowed_mime_types
    into v_avatar_limit, v_avatar_mimes
    from storage.buckets b
   where b.id = 'avatars';
  select b.file_size_limit, b.allowed_mime_types
    into v_highlight_limit, v_highlight_mimes
    from storage.buckets b
   where b.id = 'highlights';
  select b.file_size_limit, b.allowed_mime_types
    into v_event_limit, v_event_mimes
    from storage.buckets b
   where b.id = 'events';
  select b.file_size_limit, b.allowed_mime_types
    into v_site_limit, v_site_mimes
    from storage.buckets b
   where b.id = 'site-assets';
  if v_avatar_limit is distinct from 524288
     or v_avatar_mimes is distinct from
          array['image/png','image/jpeg','image/webp']::text[]
     or v_highlight_limit is distinct from 4194304
     or v_highlight_mimes is distinct from
          array['video/mp4','video/webm']::text[]
     or v_event_limit is distinct from 5242880
     or v_event_mimes is distinct from
          array[
            'image/png','image/jpeg','image/webp','image/gif'
          ]::text[]
     or v_site_limit is distinct from 5242880
     or v_site_mimes is distinct from
          array['image/png','image/jpeg','image/webp']::text[]
     or exists (
       select 1
         from (values
           ('avatars', true),
           ('highlights', false),
           ('events', true),
           ('site-assets', true),
           ('dolls', false)
         ) expected(id, is_public)
         left join storage.buckets b on b.id = expected.id
        where b.id is null
           or b.name <> expected.id
           or b.public is distinct from expected.is_public
     )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid = 'storage.objects'::regclass
     )
     or exists (
       select 1
         from pg_catalog.pg_policy p
        where p.polrelid = 'storage.objects'::regclass
     )
     or pg_catalog.to_regprocedure(
          'public.claim_generation_preflight(uuid,uuid,text,text,boolean,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.prepare_generation_face_checks(uuid,uuid,uuid,jsonb,text,integer,boolean,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.claim_generation_face_check(uuid,uuid,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_face_check_submit(uuid,text,text,text,text,text,integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_face_check_webhook(uuid,text,text,text,text,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.finalize_generation_face_checks(uuid,jsonb,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.commit_generation_preflight(uuid,uuid,text,text,uuid,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.claim_generation_preflight_continuation(uuid,uuid,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.complete_generation_preflight_continuation(uuid,uuid,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.release_generation_preflight(uuid,uuid,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.prepare_generation_submit_inputs(uuid,uuid,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.get_generation_submit_preparation(uuid,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_submit_provider_output(uuid,integer,text,text,text,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.list_generation_submit_provider_outputs(uuid,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.scrub_generation_submit_provider_outputs(uuid,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.rebind_generation_submit_inputs(uuid,uuid,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.claim_generation_submit_work(uuid,uuid,integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.claim_generation_pick(uuid,uuid,integer,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.prepare_generation_pick_submit(uuid,uuid,uuid,jsonb,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_pick_submit_outcome(uuid,uuid,text,text,text,text,integer,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_generation_pick_webhook_result(uuid,uuid,text,text,text,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.claim_generation_pick_materialization(uuid,uuid,uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.list_generation_pick_materializations(integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.create_doll_upload_intent(uuid,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.commit_generation_pick(uuid,uuid,integer,uuid,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.create_avatar_upload_intent(uuid,text,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.create_highlight_upload_intent(uuid,uuid,text,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.create_admin_storage_upload_intent(uuid,text,text,text,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.consume_doll_signed_url_quota(text,integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.list_generation_cost_reconciliation_issues(integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.resolve_generation_cost_reconciliation_issue(uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.prune_generation_cost_controls(integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.get_generation_face_cleanup_readiness(uuid)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.claim_generation_preflight(uuid,uuid,text,text,boolean)'
        ) is not null
     or pg_catalog.to_regprocedure(
          'public.record_generation_preflight_result(uuid,uuid,text,text,text,jsonb,text)'
        ) is not null
     or pg_catalog.to_regprocedure(
          'public.commit_generation_preflight(uuid,uuid,text,text)'
        ) is not null
     or pg_catalog.to_regprocedure(
          'public.release_generation_preflight(uuid,uuid,text)'
        ) is not null
     or pg_catalog.to_regprocedure(
          'public.prepare_generation_pick_submit(uuid,uuid,uuid,text,text)'
        ) is not null
     or pg_catalog.to_regprocedure(
          'public.commit_generation_pick(uuid,uuid,integer,uuid,text)'
        ) is not null then
    raise exception '008901 postflight: cost authority drift';
  end if;

  foreach v_table in array array[
    'public.generation_preflight_reservations'::regclass,
    'public.generation_face_check_intents'::regclass,
    'public.generation_face_check_cost_attempts'::regclass,
    'public.generation_submit_intents'::regclass,
    'public.generation_pick_intents'::regclass,
    'public.generation_pick_cost_attempts'::regclass,
    'public.storage_upload_intents'::regclass,
    'public.storage_upload_token_issues'::regclass,
    'public.generation_cost_reconciliation_issues'::regclass
  ]
  loop
    if not (
      select c.relrowsecurity
        from pg_catalog.pg_class c
       where c.oid = v_table
    )
       or pg_catalog.has_table_privilege(
         'service_role', v_table, 'SELECT'
       )
       or pg_catalog.has_table_privilege(
         'service_role', v_table, 'INSERT'
       )
       or pg_catalog.has_table_privilege(
         'service_role', v_table, 'UPDATE'
       )
       or pg_catalog.has_table_privilege(
         'service_role', v_table, 'DELETE'
       )
       or pg_catalog.has_table_privilege(
         'authenticated', v_table, 'SELECT'
       )
       or pg_catalog.has_table_privilege(
         'authenticated', v_table, 'INSERT'
       )
       or pg_catalog.has_table_privilege(
         'authenticated', v_table, 'UPDATE'
       )
       or pg_catalog.has_table_privilege(
         'authenticated', v_table, 'DELETE'
       )
       or pg_catalog.has_table_privilege(
         'anon', v_table, 'SELECT'
       )
       or pg_catalog.has_table_privilege(
         'anon', v_table, 'INSERT'
       )
       or pg_catalog.has_table_privilege(
         'anon', v_table, 'UPDATE'
       )
       or pg_catalog.has_table_privilege(
         'anon', v_table, 'DELETE'
       )
       or exists (
         select 1 from pg_catalog.pg_policy p
          where p.polrelid = v_table
       ) then
      raise exception '008901 postflight: table authority drift %',
        v_table;
    end if;
  end loop;

  foreach v_function in array array[
    'public.claim_generation_preflight(uuid,uuid,text,text,boolean,uuid)'::regprocedure,
    'public.prepare_generation_face_checks(uuid,uuid,uuid,jsonb,text,integer,boolean,jsonb)'::regprocedure,
    'public.claim_generation_face_check(uuid,uuid,uuid,text)'::regprocedure,
    'public.record_generation_face_check_submit(uuid,text,text,text,text,text,integer)'::regprocedure,
    'public.record_generation_face_check_webhook(uuid,text,text,text,text,text,text)'::regprocedure,
    'public.finalize_generation_face_checks(uuid,jsonb,text)'::regprocedure,
    'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'::regprocedure,
    'public.commit_generation_preflight(uuid,uuid,text,text,uuid,jsonb)'::regprocedure,
    'public.claim_generation_preflight_continuation(uuid,uuid,uuid)'::regprocedure,
    'public.complete_generation_preflight_continuation(uuid,uuid,uuid)'::regprocedure,
    'public.release_generation_preflight(uuid,uuid,uuid,text)'::regprocedure,
    'public.prepare_generation_submit_inputs(uuid,uuid,jsonb)'::regprocedure,
    'public.get_generation_submit_preparation(uuid,uuid)'::regprocedure,
    'public.record_generation_submit_provider_output(uuid,integer,text,text,text,jsonb)'::regprocedure,
    'public.list_generation_submit_provider_outputs(uuid,uuid)'::regprocedure,
    'public.scrub_generation_submit_provider_outputs(uuid,uuid)'::regprocedure,
    'public.rebind_generation_submit_inputs(uuid,uuid,jsonb)'::regprocedure,
    'public.claim_generation_submit_work(uuid,uuid,integer)'::regprocedure,
    'public.claim_generation_pick(uuid,uuid,integer,uuid)'::regprocedure,
    'public.prepare_generation_pick_submit(uuid,uuid,uuid,jsonb,text,text)'::regprocedure,
    'public.record_generation_pick_submit_outcome(uuid,uuid,text,text,text,text,integer,text)'::regprocedure,
    'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'::regprocedure,
    'public.record_generation_pick_webhook_result(uuid,uuid,text,text,text,text,text)'::regprocedure,
    'public.claim_generation_pick_materialization(uuid,uuid,uuid)'::regprocedure,
    'public.list_generation_pick_materializations(integer)'::regprocedure,
    'public.create_doll_upload_intent(uuid,uuid,text)'::regprocedure,
    'public.commit_generation_pick(uuid,uuid,integer,uuid,uuid,text)'::regprocedure,
    'public.create_avatar_upload_intent(uuid,text,uuid,text)'::regprocedure,
    'public.create_highlight_upload_intent(uuid,uuid,text,uuid,text)'::regprocedure,
    'public.create_admin_storage_upload_intent(uuid,text,text,text,uuid,text)'::regprocedure,
    'public.consume_doll_signed_url_quota(text,integer)'::regprocedure,
    'public.list_generation_cost_reconciliation_issues(integer)'::regprocedure,
    'public.resolve_generation_cost_reconciliation_issue(uuid,text)'::regprocedure,
    'public.prune_generation_cost_controls(integer)'::regprocedure,
    'public.get_generation_face_cleanup_readiness(uuid)'::regprocedure
  ]
  loop
    if not pg_catalog.has_function_privilege(
      'service_role', v_function, 'EXECUTE'
    )
       or pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
         'anon', v_function, 'EXECUTE'
       ) then
      raise exception '008901 postflight: function authority drift %',
        v_function;
    end if;
  end loop;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values (
  '008901_generation_storage_cost_controls', null, null, null
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
