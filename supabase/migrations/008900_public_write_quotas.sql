-- 008900_public_write_quotas.sql
--
-- Bound public durable-write surfaces at the database authority:
--   * telemetry: per-session + opaque actor + global request/new-session caps
--   * analytics: opaque actor + global caps, atomically with every event insert
--   * score: network + canonical owner + global caps with quota-free replay
--   * report: network + global caps with quota-free immutable receipt replay
--
-- The app HMACs only a proven member Auth subject; anonymous/pre-consent and
-- explicitly network-scoped surfaces use the trusted edge IP.
-- This table never receives a raw Auth UUID or IP address and is retained for
-- only the current and two preceding KST quota days.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create table if not exists public.public_write_quota_buckets (
  endpoint text not null,
  day_kst date not null,
  actor_key text not null,
  request_count integer not null default 0,
  new_session_count integer not null default 0,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (endpoint, day_kst, actor_key),
  constraint public_write_quota_endpoint_check
    check (endpoint in ('telemetry', 'track', 'score', 'report')),
  constraint public_write_quota_actor_key_check
    check (
      actor_key = 'global'
      or actor_key ~ '^[0-9a-f]{64}$'
    ),
  constraint public_write_quota_counts_check
    check (request_count >= 0 and new_session_count >= 0)
);

comment on table public.public_write_quota_buckets is
  'Short-lived opaque HMAC counters for DB-authoritative public write quotas; no raw IP/Auth/session identifiers.';

alter table public.public_write_quota_buckets enable row level security;
alter table public.public_write_quota_buckets
  drop constraint if exists public_write_quota_endpoint_check;
alter table public.public_write_quota_buckets
  add constraint public_write_quota_endpoint_check
  check (endpoint in ('telemetry', 'track', 'score', 'report'));
revoke all on table public.public_write_quota_buckets
  from public, anon, authenticated, service_role;

-- Retention must seek directly into expired days. The primary key begins with
-- endpoint, so it cannot bound a cross-endpoint stale-day lookup.
create index if not exists public_write_quota_retention_idx
  on public.public_write_quota_buckets(day_kst, endpoint, actor_key);

-- A quota increment and a later core failure cannot both survive when they
-- occur in one PostgreSQL transaction. The app therefore commits one opaque,
-- operation-keyed reservation RPC before invoking score/report core work.
-- Failed operations are cached so exact retries neither consume quota twice
-- nor repeatedly exercise ownership/state/constraint validation.
create table if not exists public.public_write_attempts (
  endpoint text not null check (endpoint in ('score', 'report')),
  operation_key text not null check (
    operation_key ~ '^[0-9a-f]{64}$'
  ),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  day_kst date not null,
  state text not null default 'reserved' check (
    state in ('reserved', 'succeeded', 'failed')
  ),
  error_code text check (
    error_code is null
    or (
      pg_catalog.char_length(error_code) between 1 and 128
      and error_code ~ '^[a-z0-9_]+$'
    )
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (endpoint, operation_key),
  constraint public_write_attempt_state_shape check (
    (state = 'failed' and error_code is not null)
    or (state <> 'failed' and error_code is null)
  )
);
comment on table public.public_write_attempts is
  'Three-KST-day opaque score/report operation reservations. They make failed public attempts quota-counted exact-once without retaining raw identities.';
alter table public.public_write_attempts enable row level security;
revoke all on table public.public_write_attempts
  from public, anon, authenticated, service_role;
create index if not exists public_write_attempt_retention_idx
  on public.public_write_attempts(day_kst, endpoint, operation_key);

create or replace function public.bp_consume_public_write_quota(
  p_endpoint text,
  p_actor_key text,
  p_is_new_session boolean
)
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_global public.public_write_quota_buckets;
  v_actor public.public_write_quota_buckets;
  v_global_request_limit integer;
  v_actor_request_limit integer;
  v_global_new_session_limit integer;
  v_actor_new_session_limit integer;
begin
  if p_actor_key is null
     or p_actor_key !~ '^[0-9a-f]{64}$' then
    return 'invalid_actor';
  end if;

  case p_endpoint
    when 'telemetry' then
      -- One 30-minute session emits about 181 normal 10-second flushes. These
      -- caps preserve ~276 maximum-length sessions/day globally and five per
      -- actor while bounding Free-plan DB mutations to a sub-1/sec daily mean.
      v_global_request_limit := 50000;
      v_actor_request_limit := 1000;
      v_global_new_session_limit := 2000;
      v_actor_new_session_limit := 30;
    when 'track' then
      -- Normal acquisition emits two visits/browser and shares are debounced.
      -- 2,000 raw rows/day keeps the 90-day Free-plan retention finite while
      -- still covering roughly 1,000 ordinary new visitors/day.
      v_global_request_limit := 2000;
      v_actor_request_limit := 200;
      v_global_new_session_limit := 0;
      v_actor_new_session_limit := 0;
      if coalesce(p_is_new_session, false) then
        return 'invalid_actor';
      end if;
    else
      return 'invalid_actor';
  end case;

  -- Every contender locks the same endpoint/day global row first. This makes
  -- the cap exact across all Vercel instances and gives actor-row creation a
  -- hard global upper bound even under distributed random actor keys.
  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values (p_endpoint, v_today, 'global')
  on conflict (endpoint, day_kst, actor_key) do nothing;

  select *
    into strict v_global
    from public.public_write_quota_buckets q
   where q.endpoint = p_endpoint
     and q.day_kst = v_today
     and q.actor_key = 'global'
   for update;

  -- Opportunistic bounded retention. A stale backlog can never turn the first
  -- later public request into an unbounded DELETE/timeout.
  delete from public.public_write_quota_buckets q
   where q.ctid in (
     select stale.ctid
       from public.public_write_quota_buckets stale
      where stale.day_kst < v_today - 2
      order by stale.day_kst, stale.endpoint, stale.actor_key
      for update skip locked
      limit 256
   );

  if v_global.request_count >= v_global_request_limit then
    return 'global_request_quota';
  end if;
  if coalesce(p_is_new_session, false)
     and v_global.new_session_count >= v_global_new_session_limit then
    return 'global_new_session_quota';
  end if;

  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values (p_endpoint, v_today, p_actor_key)
  on conflict (endpoint, day_kst, actor_key) do nothing;

  select *
    into strict v_actor
    from public.public_write_quota_buckets q
   where q.endpoint = p_endpoint
     and q.day_kst = v_today
     and q.actor_key = p_actor_key
   for update;

  if v_actor.request_count >= v_actor_request_limit then
    return 'actor_request_quota';
  end if;
  if coalesce(p_is_new_session, false)
     and v_actor.new_session_count >= v_actor_new_session_limit then
    return 'actor_new_session_quota';
  end if;

  update public.public_write_quota_buckets q
     set request_count = q.request_count + 1,
         new_session_count =
           q.new_session_count
           + case when coalesce(p_is_new_session, false) then 1 else 0 end,
         updated_at = pg_catalog.clock_timestamp()
   where q.endpoint = p_endpoint
     and q.day_kst = v_today
     and q.actor_key in ('global', p_actor_key);

  return 'accepted';
end;
$$;
revoke all on function public.bp_consume_public_write_quota(
  text, text, boolean
) from public, anon, authenticated, service_role;

-- Preserve the hardened 0074 implementation as a non-Data-API core. Reapply
-- is idempotent: once renamed, only the wrappers below are replaced.
do $$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'
     ) is null then
    if pg_catalog.to_regprocedure(
         'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)'
       ) is null then
      raise exception '008900 preflight: telemetry ingest core missing';
    end if;
    alter function public.ingest_telemetry_delta(
      uuid, uuid, boolean, jsonb
    ) rename to bp_ingest_telemetry_delta_core;
  end if;
end;
$$;
revoke all on function public.bp_ingest_telemetry_delta_core(
  uuid, uuid, boolean, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.ingest_telemetry_delta(
  p_session_id uuid,
  p_owner_id uuid,
  p_is_member boolean,
  p_actor_key text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  c_max_session_writes integer := 400;
  v_exists boolean;
  v_last_seq integer := 0;
  v_write_count integer := 0;
  v_requested_seq integer := 0;
  v_quota text;
begin
  if p_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'mode', 'off', 'reason', 'no_session', 'lastSeq', 0
    );
  end if;

  begin
    v_requested_seq := least(
      greatest(
        coalesce(
          nullif(p_payload#>>'{summary,seqHigh}', '')::bigint,
          0
        ),
        0
      ),
      2147483647
    )::integer;
  exception
    when invalid_text_representation
      or numeric_value_out_of_range then
      v_requested_seq := 0;
  end;

  -- Serialize the absent-row decision for one random session UUID. Concurrent
  -- first deltas can therefore consume at most one new-session unit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-telemetry-session:' || p_session_id::text,
      0
    )
  );
  select t.last_seq, t.write_count
    into v_last_seq, v_write_count
    from public.telemetry_sessions t
   where t.id = p_session_id
   for update;
  v_exists := found;

  if v_exists and v_write_count >= c_max_session_writes then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'mode', 'off',
      'reason', 'session_quota',
      'lastSeq', greatest(v_last_seq, v_requested_seq)
    );
  end if;

  v_quota := public.bp_consume_public_write_quota(
    'telemetry', p_actor_key, not v_exists
  );
  if v_quota <> 'accepted' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'mode', 'off',
      'reason', v_quota,
      'lastSeq', greatest(v_last_seq, v_requested_seq)
    );
  end if;

  return public.bp_ingest_telemetry_delta_core(
    p_session_id,
    p_owner_id,
    p_is_member,
    p_payload
  );
exception
  when lock_not_available or query_canceled then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'mode', 'off',
      'reason', 'quota_busy',
      'lastSeq', v_requested_seq
    );
end;
$$;
revoke all on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, text, jsonb
) to service_role;

-- Rolling old app compatibility remains bounded. Authenticated callers share
-- an opaque digest per subject; truly unbound callers share one fail-safe
-- bucket. New code always uses the five-argument HMAC actor wrapper above.
create or replace function public.ingest_telemetry_delta(
  p_session_id uuid,
  p_owner_id uuid,
  p_is_member boolean,
  p_payload jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
  select public.ingest_telemetry_delta(
    p_session_id,
    p_owner_id,
    p_is_member,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          'legacy:' || coalesce(p_owner_id::text, 'unbound'),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    p_payload
  );
$$;
revoke all on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, jsonb
) to service_role;

-- Score submissions need three independent authorities: global, network
-- (anonymous Auth UUIDs are cheap to rotate), and canonical owner. Actor
-- dimensions are re-hashed with distinct prefixes before short-lived storage.
create or replace function public.bp_consume_score_write_quota(
  p_network_actor_key text,
  p_owner_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  c_global_limit integer := 5000;
  c_network_limit integer := 300;
  c_owner_limit integer := 100;
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_network_key text;
  v_owner_key text;
  v_global_count integer;
  v_network_count integer;
  v_owner_count integer;
begin
  if p_network_actor_key is null
     or p_network_actor_key !~ '^[0-9a-f]{64}$'
     or p_owner_id is null then
    return 'invalid_actor';
  end if;
  v_network_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'score-network:' || p_network_actor_key,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_owner_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to('score-owner:' || p_owner_id::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values ('score', v_today, 'global')
  on conflict (endpoint, day_kst, actor_key) do nothing;
  select q.request_count
    into strict v_global_count
    from public.public_write_quota_buckets q
   where q.endpoint = 'score'
     and q.day_kst = v_today
     and q.actor_key = 'global'
   for update;
  if v_global_count >= c_global_limit then
    return 'global_request_quota';
  end if;

  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values
    ('score', v_today, v_network_key),
    ('score', v_today, v_owner_key)
  on conflict (endpoint, day_kst, actor_key) do nothing;
  -- Every score contender locks its two actor dimensions lexically.
  perform 1
    from public.public_write_quota_buckets q
   where q.endpoint = 'score'
     and q.day_kst = v_today
     and q.actor_key in (v_network_key, v_owner_key)
   order by q.actor_key
   for update;

  select q.request_count
    into strict v_network_count
    from public.public_write_quota_buckets q
   where q.endpoint = 'score'
     and q.day_kst = v_today
     and q.actor_key = v_network_key;
  select q.request_count
    into strict v_owner_count
    from public.public_write_quota_buckets q
   where q.endpoint = 'score'
     and q.day_kst = v_today
     and q.actor_key = v_owner_key;
  if v_network_count >= c_network_limit then
    -- The other dimension may have been inserted at zero by this rejected
    -- cross-product attempt. Do not let a capped network spray unbounded
    -- owner rows without consuming the global counter.
    delete from public.public_write_quota_buckets q
     where q.endpoint = 'score'
       and q.day_kst = v_today
       and q.actor_key in (v_network_key, v_owner_key)
       and q.request_count = 0
       and q.new_session_count = 0;
    return 'network_request_quota';
  end if;
  if v_owner_count >= c_owner_limit then
    -- Symmetric cleanup prevents a capped owner from spraying new network
    -- rows. Accepted dimensions are never zero and therefore stay intact.
    delete from public.public_write_quota_buckets q
     where q.endpoint = 'score'
       and q.day_kst = v_today
       and q.actor_key in (v_network_key, v_owner_key)
       and q.request_count = 0
       and q.new_session_count = 0;
    return 'owner_request_quota';
  end if;

  update public.public_write_quota_buckets q
     set request_count = q.request_count + 1,
         updated_at = pg_catalog.clock_timestamp()
   where q.endpoint = 'score'
     and q.day_kst = v_today
     and q.actor_key in ('global', v_network_key, v_owner_key);
  return 'accepted';
end;
$$;
revoke all on function public.bp_consume_score_write_quota(text, uuid)
  from public, anon, authenticated, service_role;

drop function if exists public.bp_refund_score_write_quota(text, uuid);

do $$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_submit_score_with_review_core(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)'
     ) is null then
    if pg_catalog.to_regprocedure(
         'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)'
       ) is null then
      raise exception '008900 preflight: score submit core missing';
    end if;
    alter function public.submit_score_with_review(
      uuid, uuid, integer, text, integer, integer, text, uuid,
      text, jsonb, jsonb, integer, text
    ) rename to bp_submit_score_with_review_core;
  end if;
end;
$$;
revoke all on function public.bp_submit_score_with_review_core(
  uuid, uuid, integer, text, integer, integer, text, uuid,
  text, jsonb, jsonb, integer, text
) from public, anon, authenticated, service_role;

-- Cheap immutable-receipt probe. Every syntactically usable submission key is
-- serialized before quota, so concurrent response-loss retries cannot consume
-- two units. A mismatch returns NULL and therefore reaches quota before any
-- profile/doll/telemetry/score/flag work in the core.
create or replace function public.bp_probe_score_write_replay(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score integer,
  p_weapon text,
  p_duration_ms integer,
  p_max_combo integer,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_submission_text text;
  v_submission_id uuid;
  v_submission_fingerprint text;
  v_migrated_source_text text;
  v_submission_origin_owner uuid;
  v_existing public.scores%rowtype;
  v_end_reason text :=
    case when p_end_reason in ('time_limit', 'score_limit')
      then p_end_reason else 'normal' end;
  v_max_combo integer := greatest(coalesce(p_max_combo, 0), 0);
begin
  if p_owner_id is null
     or pg_catalog.jsonb_typeof(v_evidence) <> 'object'
     or pg_catalog.pg_column_size(v_evidence) > 32768 then
    return null;
  end if;

  v_submission_text := v_evidence->>'submissionId';
  v_submission_fingerprint := v_evidence->>'submissionFingerprint';
  if v_submission_text is null
     and v_submission_fingerprint is null
     and public.bp_rollout_compatibility_enabled(
       'legacy_score_submission'
     )
  then
    if p_telemetry_session_id is null then return null; end if;
    v_submission_id := pg_catalog.md5(
      'legacy-score:' || p_owner_id::text || ':' ||
      p_telemetry_session_id::text
    )::uuid;
    v_submission_fingerprint := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'ownerId', p_owner_id,
            'dollId', p_doll_id,
            'score', p_score,
            'weapon', p_weapon,
            'durationMs', p_duration_ms,
            'maxCombo', v_max_combo,
            'endReason', v_end_reason,
            'telemetrySessionId', p_telemetry_session_id
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
  elsif v_submission_text is not null
        and v_submission_text ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        and v_submission_fingerprint is not null
        and v_submission_fingerprint ~ '^[0-9a-f]{64}$'
  then
    v_submission_id := v_submission_text::uuid;
  else
    return null;
  end if;

  v_migrated_source_text :=
    case
      when v_evidence->>'migratedSourceOwnerId' = '' then null
      else v_evidence->>'migratedSourceOwnerId'
    end;
  if v_migrated_source_text is null then
    v_submission_origin_owner := p_owner_id;
  elsif v_migrated_source_text ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    v_submission_origin_owner := v_migrated_source_text::uuid;
    if v_submission_origin_owner = p_owner_id
       or not exists (
         select 1
           from public.anon_data_reassignments r
          where r.source_user_id = v_submission_origin_owner
            and r.target_user_id = p_owner_id
            and r.result->>'ok' = 'true'
       ) then
      return null;
    end if;
  else
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'score-submission:' || v_submission_origin_owner::text || ':' ||
        v_submission_id::text,
      0
    )
  );

  select s.*
    into v_existing
    from public.scores s
   where s.submission_origin_owner_id = v_submission_origin_owner
     and s.submission_id = v_submission_id
     and s.owner_id = p_owner_id;
  if not found
     or v_existing.submission_fingerprint is distinct from
          v_submission_fingerprint
     or v_existing.score is distinct from p_score
     or v_existing.weapon is distinct from p_weapon
     or v_existing.duration_ms is distinct from p_duration_ms
     or v_existing.max_combo is distinct from v_max_combo
     or v_existing.end_reason is distinct from v_end_reason then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'scoreId', v_existing.id,
    'reviewStatus', v_existing.review_status,
    'duplicate', true
  );
end;
$$;
revoke all on function public.bp_probe_score_write_replay(
  uuid, uuid, integer, text, integer, integer, text, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.bp_score_write_attempt_identity(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score integer,
  p_weapon text,
  p_duration_ms integer,
  p_max_combo integer,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_submission_text text;
  v_submission_id uuid;
  v_submission_fingerprint text;
  v_origin_text text;
  v_origin_owner uuid;
  v_max_combo integer := greatest(coalesce(p_max_combo, 0), 0);
  v_end_reason text :=
    case when p_end_reason in ('time_limit', 'score_limit')
      then p_end_reason else 'normal' end;
begin
  if p_owner_id is null
     or pg_catalog.jsonb_typeof(v_evidence) <> 'object'
     or pg_catalog.pg_column_size(v_evidence) > 32768 then
    return null;
  end if;
  v_submission_text := v_evidence->>'submissionId';
  v_submission_fingerprint := v_evidence->>'submissionFingerprint';
  if v_submission_text is null
     and v_submission_fingerprint is null
     and public.bp_rollout_compatibility_enabled(
       'legacy_score_submission'
     )
  then
    if p_telemetry_session_id is null then return null; end if;
    v_submission_id := pg_catalog.md5(
      'legacy-score:' || p_owner_id::text || ':' ||
      p_telemetry_session_id::text
    )::uuid;
    v_submission_fingerprint := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'ownerId', p_owner_id,
            'dollId', p_doll_id,
            'score', p_score,
            'weapon', p_weapon,
            'durationMs', p_duration_ms,
            'maxCombo', v_max_combo,
            'endReason', v_end_reason,
            'telemetrySessionId', p_telemetry_session_id
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
  elsif v_submission_text is not null
        and v_submission_text ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        and v_submission_fingerprint is not null
        and v_submission_fingerprint ~ '^[0-9a-f]{64}$'
  then
    v_submission_id := v_submission_text::uuid;
  else
    return null;
  end if;

  v_origin_text := nullif(v_evidence->>'migratedSourceOwnerId', '');
  if v_origin_text is null then
    v_origin_owner := p_owner_id;
  elsif v_origin_text ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    v_origin_owner := v_origin_text::uuid;
  else
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'operationKey',
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          'score-attempt:' || p_owner_id::text || ':' ||
          v_origin_owner::text || ':' || v_submission_id::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    'requestFingerprint',
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'ownerId', p_owner_id,
            'originOwnerId', v_origin_owner,
            'submissionId', v_submission_id,
            'submissionFingerprint', v_submission_fingerprint
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  );
end;
$$;
revoke all on function public.bp_score_write_attempt_identity(
  uuid, uuid, integer, text, integer, integer, text, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.reserve_score_write_attempt(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score integer,
  p_weapon text,
  p_duration_ms integer,
  p_max_combo integer,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_evidence jsonb,
  p_network_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_identity jsonb;
  v_operation_key text;
  v_request_fingerprint text;
  v_attempt public.public_write_attempts%rowtype;
  v_replay jsonb;
  v_quota text;
begin
  v_identity := public.bp_score_write_attempt_identity(
    p_owner_id, p_doll_id, p_score, p_weapon, p_duration_ms,
    p_max_combo, p_end_reason, p_telemetry_session_id, p_evidence
  );
  if v_identity is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'failed',
      'error_code', 'invalid_submission_id'
    );
  end if;
  v_operation_key := v_identity->>'operationKey';
  v_request_fingerprint := v_identity->>'requestFingerprint';

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'score-write-attempt:' || v_operation_key,
      0::bigint
    )
  );

  v_replay := public.bp_probe_score_write_replay(
    p_owner_id, p_doll_id, p_score, p_weapon, p_duration_ms,
    p_max_combo, p_end_reason, p_telemetry_session_id, p_evidence
  );
  if v_replay is not null then
    update public.public_write_attempts a
       set state = 'succeeded',
           error_code = null,
           updated_at = pg_catalog.clock_timestamp()
     where a.endpoint = 'score'
       and a.operation_key = v_operation_key;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'replay',
      'result', v_replay
    );
  end if;

  select *
    into v_attempt
    from public.public_write_attempts a
   where a.endpoint = 'score'
     and a.operation_key = v_operation_key
   for update;
  if found then
    if v_attempt.request_fingerprint <> v_request_fingerprint then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', 'submission_id_conflict'
      );
    end if;
    if v_attempt.state = 'failed' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', v_attempt.error_code
      );
    end if;
    if v_attempt.state = 'succeeded' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', 'score_receipt_missing'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'reserved'
    );
  end if;

  v_quota := public.bp_consume_score_write_quota(
    p_network_actor_key,
    p_owner_id
  );
  if v_quota <> 'accepted' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'quota',
      'error_code', 'score_write_' || v_quota
    );
  end if;

  insert into public.public_write_attempts(
    endpoint,
    operation_key,
    request_fingerprint,
    day_kst
  )
  values (
    'score',
    v_operation_key,
    v_request_fingerprint,
    v_today
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'reserved'
  );
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'busy',
      'error_code', 'score_write_quota_busy'
    );
end;
$$;
revoke all on function public.reserve_score_write_attempt(
  uuid, uuid, integer, text, integer, integer, text, uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.reserve_score_write_attempt(
  uuid, uuid, integer, text, integer, integer, text, uuid, jsonb, text
) to service_role;

create or replace function public.submit_score_with_review(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score integer,
  p_weapon text,
  p_duration_ms integer,
  p_max_combo integer,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_review_status text,
  p_signals jsonb,
  p_evidence jsonb,
  p_abuse_score integer,
  p_rules_version text,
  p_network_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_reservation jsonb;
  v_identity jsonb;
  v_operation_key text;
  v_request_fingerprint text;
  v_attempt public.public_write_attempts%rowtype;
  v_result jsonb;
  v_error_code text;
  v_error_message text;
begin
  v_reservation := public.reserve_score_write_attempt(
    p_owner_id,
    p_doll_id,
    p_score,
    p_weapon,
    p_duration_ms,
    p_max_combo,
    p_end_reason,
    p_telemetry_session_id,
    p_evidence,
    p_network_actor_key
  );
  if v_reservation->>'outcome' = 'replay' then
    return v_reservation->'result';
  elsif v_reservation->>'outcome' = 'quota' then
    raise exception '%', v_reservation->>'error_code'
      using errcode = 'P0001';
  elsif v_reservation->>'outcome' = 'busy' then
    raise exception 'score_write_quota_busy' using errcode = 'P0001';
  elsif v_reservation->>'outcome' = 'failed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', v_reservation->>'error_code'
    );
  elsif v_reservation->>'outcome' <> 'reserved' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'internal_error'
    );
  end if;

  v_identity := public.bp_score_write_attempt_identity(
    p_owner_id, p_doll_id, p_score, p_weapon, p_duration_ms,
    p_max_combo, p_end_reason, p_telemetry_session_id, p_evidence
  );
  if v_identity is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'invalid_submission_id'
    );
  end if;
  v_operation_key := v_identity->>'operationKey';
  v_request_fingerprint := v_identity->>'requestFingerprint';
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'score-write-attempt:' || v_operation_key,
      0::bigint
    )
  );

  select *
    into strict v_attempt
    from public.public_write_attempts a
   where a.endpoint = 'score'
     and a.operation_key = v_operation_key
   for update;
  if v_attempt.request_fingerprint <> v_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'submission_id_conflict'
    );
  end if;
  if v_attempt.state = 'failed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', v_attempt.error_code
    );
  end if;

  begin
    v_result := public.bp_submit_score_with_review_core(
      p_owner_id,
      p_doll_id,
      p_score,
      p_weapon,
      p_duration_ms,
      p_max_combo,
      p_end_reason,
      p_telemetry_session_id,
      p_review_status,
      p_signals,
      p_evidence,
      p_abuse_score,
      p_rules_version
    );
  exception
    -- Lock pressure is retryable. Keep the already quota-counted reservation
    -- open so the exact same operation can try the core again later.
    when lock_not_available
      or query_canceled
      or serialization_failure
      or deadlock_detected then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'writeAttemptError', 'score_write_quota_busy'
      );
    when others then
      get stacked diagnostics v_error_message = message_text;
      v_error_code := case
        when v_error_message in (
          'telemetry_session_conflict',
          'submission_id_conflict',
          'telemetry_session_owner_mismatch',
          'doll_ownership_mismatch',
          'migrated_replay_not_authorized',
          'migrated_score_replay_mismatch',
          'account_deleted',
          'account_migrated',
          'account_not_found',
          'client_upgrade_required',
          'invalid_migrated_replay_source',
          'invalid_owner',
          'invalid_review_status',
          'invalid_score_protocol',
          'invalid_submission_id',
          'invalid_submission_fingerprint',
          'invalid_review_payload',
          'review_payload_mismatch'
        ) then v_error_message
        else 'internal_error'
      end;
      update public.public_write_attempts a
         set state = 'failed',
             error_code = v_error_code,
             updated_at = pg_catalog.clock_timestamp()
       where a.endpoint = 'score'
         and a.operation_key = v_operation_key;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'writeAttemptError', v_error_code
      );
  end;

  update public.public_write_attempts a
     set state = 'succeeded',
         error_code = null,
         updated_at = pg_catalog.clock_timestamp()
   where a.endpoint = 'score'
     and a.operation_key = v_operation_key;
  return v_result;
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    raise exception 'score_write_quota_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid,
  text, jsonb, jsonb, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid,
  text, jsonb, jsonb, integer, text, text
) to service_role;

-- Expand-only old app compatibility is bounded by owner+global quota. Its
-- missing network evidence cannot bypass the cap; 0092 removes service access.
create or replace function public.submit_score_with_review(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score integer,
  p_weapon text,
  p_duration_ms integer,
  p_max_combo integer,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_review_status text,
  p_signals jsonb,
  p_evidence jsonb,
  p_abuse_score integer,
  p_rules_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_replay jsonb;
  v_quota text;
  v_legacy_network_key text;
begin
  v_replay := public.bp_probe_score_write_replay(
    p_owner_id,
    p_doll_id,
    p_score,
    p_weapon,
    p_duration_ms,
    p_max_combo,
    p_end_reason,
    p_telemetry_session_id,
    p_evidence
  );
  if v_replay is not null then return v_replay; end if;
  v_legacy_network_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'legacy-score-network:' || coalesce(p_owner_id::text, 'unbound'),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_quota := public.bp_consume_score_write_quota(
    v_legacy_network_key,
    p_owner_id
  );
  if v_quota <> 'accepted' then
    raise exception 'score_write_%', v_quota using errcode = 'P0001';
  end if;
  return public.bp_submit_score_with_review_core(
    p_owner_id,
    p_doll_id,
    p_score,
    p_weapon,
    p_duration_ms,
    p_max_combo,
    p_end_reason,
    p_telemetry_session_id,
    p_review_status,
    p_signals,
    p_evidence,
    p_abuse_score,
    p_rules_version
  );
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    raise exception 'score_write_quota_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid,
  text, jsonb, jsonb, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid,
  text, jsonb, jsonb, integer, text
) to service_role;

create or replace function public.bp_consume_report_write_quota(
  p_network_actor_key text
)
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  c_global_limit integer := 500;
  c_network_limit integer := 20;
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_network_key text;
  v_global_count integer;
  v_network_count integer;
begin
  if p_network_actor_key is null
     or p_network_actor_key !~ '^[0-9a-f]{64}$' then
    return 'invalid_actor';
  end if;
  v_network_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'report-network:' || p_network_actor_key,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values ('report', v_today, 'global')
  on conflict (endpoint, day_kst, actor_key) do nothing;
  select q.request_count
    into strict v_global_count
    from public.public_write_quota_buckets q
   where q.endpoint = 'report'
     and q.day_kst = v_today
     and q.actor_key = 'global'
   for update;
  if v_global_count >= c_global_limit then
    return 'global_request_quota';
  end if;

  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values ('report', v_today, v_network_key)
  on conflict (endpoint, day_kst, actor_key) do nothing;
  select q.request_count
    into strict v_network_count
    from public.public_write_quota_buckets q
   where q.endpoint = 'report'
     and q.day_kst = v_today
     and q.actor_key = v_network_key
   for update;
  if v_network_count >= c_network_limit then
    return 'network_request_quota';
  end if;

  update public.public_write_quota_buckets q
     set request_count = q.request_count + 1,
         updated_at = pg_catalog.clock_timestamp()
   where q.endpoint = 'report'
     and q.day_kst = v_today
     and q.actor_key in ('global', v_network_key);
  return 'accepted';
end;
$$;
revoke all on function public.bp_consume_report_write_quota(text)
  from public, anon, authenticated, service_role;

-- Rolling-old report calls have no trustworthy network actor. Keep them under
-- the same 500/day global authority without collapsing all unauthenticated
-- users into the new protocol's 20/day network bucket.
create or replace function public.bp_consume_report_legacy_write_quota()
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  c_global_limit integer := 500;
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_global_count integer;
begin
  insert into public.public_write_quota_buckets(
    endpoint, day_kst, actor_key
  )
  values ('report', v_today, 'global')
  on conflict (endpoint, day_kst, actor_key) do nothing;
  select q.request_count
    into strict v_global_count
    from public.public_write_quota_buckets q
   where q.endpoint = 'report'
     and q.day_kst = v_today
     and q.actor_key = 'global'
   for update;
  if v_global_count >= c_global_limit then
    return 'global_request_quota';
  end if;
  update public.public_write_quota_buckets q
     set request_count = q.request_count + 1,
         updated_at = pg_catalog.clock_timestamp()
   where q.endpoint = 'report'
     and q.day_kst = v_today
     and q.actor_key = 'global';
  return 'accepted';
end;
$$;
revoke all on function public.bp_consume_report_legacy_write_quota()
  from public, anon, authenticated, service_role;

drop function if exists public.bp_refund_report_write_quota(text);

do $$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_submit_content_report_core(uuid,uuid,text,text,uuid,text,boolean)'
     ) is null then
    if pg_catalog.to_regprocedure(
         'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)'
       ) is null then
      raise exception '008900 preflight: content report core missing';
    end if;
    alter function public.submit_content_report(
      uuid, uuid, text, text, uuid, text, boolean
    ) rename to bp_submit_content_report_core;
  end if;
end;
$$;
revoke all on function public.bp_submit_content_report_core(
  uuid, uuid, text, text, uuid, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.reserve_report_write_attempt(
  p_submission_id uuid,
  p_target_id uuid,
  p_reason text,
  p_detail text,
  p_reporter_contact text,
  p_network_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_detail text := nullif(pg_catalog.btrim(p_detail), '');
  v_contact text := nullif(pg_catalog.btrim(p_reporter_contact), '');
  v_operation_key text;
  v_request_fingerprint text;
  v_attempt public.public_write_attempts%rowtype;
  v_receipt public.content_report_submission_receipts%rowtype;
  v_quota text;
begin
  if p_submission_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'failed',
      'error_code', 'submission_id_required'
    );
  end if;
  v_operation_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'report-attempt:' || p_submission_id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'targetId', p_target_id,
          'reason', p_reason,
          'detail', v_detail,
          'reporterContact', v_contact
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-write-attempt:' || v_operation_key,
      0::bigint
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'content-report:submission:' || p_submission_id::text,
      0::bigint
    )
  );

  select *
    into v_receipt
    from public.content_report_submission_receipts r
   where r.submission_id = p_submission_id;
  if found then
    if v_receipt.target_id is distinct from p_target_id
       or v_receipt.reason is distinct from p_reason
       or v_receipt.detail is distinct from v_detail
       or v_receipt.reporter_contact is distinct from v_contact then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', 'submission_conflict'
      );
    end if;
    update public.public_write_attempts a
       set state = 'succeeded',
           error_code = null,
           updated_at = pg_catalog.clock_timestamp()
     where a.endpoint = 'report'
       and a.operation_key = v_operation_key;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'replay',
      'result', pg_catalog.jsonb_build_object(
        'ok', true,
        'inserted', v_receipt.outcome = 'inserted',
        'already_removed', v_receipt.outcome = 'already_removed',
        'was_first', v_receipt.was_first,
        'report_id', v_receipt.report_id,
        'duplicate', true
      )
    );
  end if;

  select *
    into v_attempt
    from public.public_write_attempts a
   where a.endpoint = 'report'
     and a.operation_key = v_operation_key
   for update;
  if found then
    if v_attempt.request_fingerprint <> v_request_fingerprint then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', 'submission_conflict'
      );
    end if;
    if v_attempt.state = 'failed' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', v_attempt.error_code
      );
    end if;
    if v_attempt.state = 'succeeded' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', 'failed',
        'error_code', 'report_receipt_missing'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'reserved'
    );
  end if;

  v_quota := public.bp_consume_report_write_quota(
    p_network_actor_key
  );
  if v_quota <> 'accepted' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'quota',
      'error_code', 'report_write_' || v_quota
    );
  end if;

  insert into public.public_write_attempts(
    endpoint,
    operation_key,
    request_fingerprint,
    day_kst
  )
  values (
    'report',
    v_operation_key,
    v_request_fingerprint,
    v_today
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'reserved'
  );
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'outcome', 'busy',
      'error_code', 'report_write_quota_busy'
    );
end;
$$;
revoke all on function public.reserve_report_write_attempt(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.reserve_report_write_attempt(
  uuid, uuid, text, text, text, text
) to service_role;

create or replace function public.submit_content_report(
  p_submission_id uuid,
  p_target_id uuid,
  p_reason text,
  p_detail text,
  p_reporter_user_id uuid,
  p_reporter_contact text,
  p_rate_allowed boolean,
  p_network_actor_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_reservation jsonb;
  v_operation_key text;
  v_request_fingerprint text;
  v_attempt public.public_write_attempts%rowtype;
  v_result jsonb;
  v_error_code text;
  v_error_message text;
begin
  v_reservation := public.reserve_report_write_attempt(
    p_submission_id,
    p_target_id,
    p_reason,
    p_detail,
    p_reporter_contact,
    p_network_actor_key
  );
  if v_reservation->>'outcome' = 'replay' then
    return v_reservation->'result';
  elsif v_reservation->>'outcome' = 'quota' then
    raise exception 'rate_limited' using errcode = 'P0001';
  elsif v_reservation->>'outcome' = 'busy' then
    raise exception 'report_write_quota_busy' using errcode = 'P0001';
  elsif v_reservation->>'outcome' = 'failed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', v_reservation->>'error_code'
    );
  elsif v_reservation->>'outcome' <> 'reserved' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'internal_error'
    );
  end if;

  v_operation_key := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        'report-attempt:' || p_submission_id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'targetId', p_target_id,
          'reason', p_reason,
          'detail', nullif(pg_catalog.btrim(p_detail), ''),
          'reporterContact',
            nullif(pg_catalog.btrim(p_reporter_contact), '')
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'report-write-attempt:' || v_operation_key,
      0::bigint
    )
  );
  select *
    into strict v_attempt
    from public.public_write_attempts a
   where a.endpoint = 'report'
     and a.operation_key = v_operation_key
   for update;
  if v_attempt.request_fingerprint <> v_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'submission_conflict'
    );
  end if;
  if v_attempt.state = 'failed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', v_attempt.error_code
    );
  end if;

  begin
    v_result := public.bp_submit_content_report_core(
      p_submission_id,
      p_target_id,
      p_reason,
      p_detail,
      p_reporter_user_id,
      p_reporter_contact,
      p_rate_allowed
    );
  exception
    -- Lock pressure is retryable. Keep the already quota-counted reservation
    -- open so the exact same operation can try the core again later.
    when lock_not_available
      or query_canceled
      or serialization_failure
      or deadlock_detected then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'writeAttemptError', 'report_write_quota_busy'
      );
    when others then
      get stacked diagnostics v_error_message = message_text;
      v_error_code := case
        when v_error_message in (
          'target_not_found',
          'rate_limited',
          'submission_conflict',
          'submission_id_required',
          'reason_invalid',
          'detail_invalid',
          'contact_invalid',
          'rate_decision_required'
        ) then v_error_message
        else 'internal_error'
      end;
      update public.public_write_attempts a
         set state = 'failed',
             error_code = v_error_code,
             updated_at = pg_catalog.clock_timestamp()
       where a.endpoint = 'report'
         and a.operation_key = v_operation_key;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'writeAttemptError', v_error_code
      );
  end;

  update public.public_write_attempts a
     set state = 'succeeded',
         error_code = null,
         updated_at = pg_catalog.clock_timestamp()
   where a.endpoint = 'report'
     and a.operation_key = v_operation_key;
  return v_result;
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    raise exception 'report_write_quota_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean, text
) to service_role;

-- Rolling old route uses the seven-argument RPC. It remains globally bounded
-- even without a network key and loses Data API execute in 0092.
create or replace function public.submit_content_report(
  p_submission_id uuid,
  p_target_id uuid,
  p_reason text,
  p_detail text,
  p_reporter_user_id uuid,
  p_reporter_contact text,
  p_rate_allowed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_quota text;
  v_exact_replay boolean := false;
begin
  if p_submission_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'content-report:submission:' || p_submission_id::text,
        0::bigint
      )
    );
    select exists (
      select 1
        from public.content_report_submission_receipts r
       where r.submission_id = p_submission_id
         and r.target_id is not distinct from p_target_id
         and r.reason is not distinct from p_reason
         and r.detail is not distinct from
               nullif(pg_catalog.btrim(p_detail), '')
         and r.reporter_contact is not distinct from
               nullif(pg_catalog.btrim(p_reporter_contact), '')
    )
      into v_exact_replay;
  end if;
  if not v_exact_replay then
    v_quota := public.bp_consume_report_legacy_write_quota();
    if v_quota <> 'accepted' then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
  end if;
  return public.bp_submit_content_report_core(
    p_submission_id,
    p_target_id,
    p_reason,
    p_detail,
    p_reporter_user_id,
    p_reporter_contact,
    p_rate_allowed
  );
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    raise exception 'report_write_quota_busy' using errcode = 'P0001';
end;
$$;
revoke all on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.submit_content_report(
  uuid, uuid, text, text, uuid, text, boolean
) to service_role;

-- The old direct-insert route was best-effort and must not bypass either RPC.
revoke insert on table public.content_reports from service_role;

create or replace function public.record_public_analytics_event(
  p_actor_key text,
  p_member_state text,
  p_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  v_kind text;
  v_quota text;
  v_score_tier smallint;
begin
  if p_member_state not in ('anon', 'member')
     or p_event is null
     or pg_catalog.jsonb_typeof(p_event) <> 'object' then
    raise exception 'invalid_public_analytics_event'
      using errcode = 'P0001';
  end if;
  v_kind := p_event->>'kind';
  if v_kind not in ('visit', 'share', 'conversion') then
    raise exception 'invalid_public_analytics_event'
      using errcode = 'P0001';
  end if;

  v_quota := public.bp_consume_public_write_quota(
    'track', p_actor_key, false
  );
  if v_quota <> 'accepted' then
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'reason', v_quota
    );
  end if;

  if v_kind = 'visit' then
    insert into public.analytics_events(
      kind,
      member_state,
      source_scope,
      source_kind,
      source_value,
      referrer_domain,
      utm_source,
      utm_medium,
      utm_campaign,
      viral_type
    )
    values (
      'visit',
      p_member_state,
      p_event->>'source_scope',
      p_event->>'source_kind',
      p_event->>'source_value',
      p_event->>'referrer_domain',
      p_event->>'utm_source',
      p_event->>'utm_medium',
      p_event->>'utm_campaign',
      p_event->>'viral_type'
    );
  elsif v_kind = 'share' then
    if pg_catalog.jsonb_typeof(p_event->'score_tier') = 'number' then
      v_score_tier := (p_event->>'score_tier')::smallint;
    end if;
    insert into public.analytics_events(
      kind,
      member_state,
      surface,
      target,
      score_tier,
      result
    )
    values (
      'share',
      p_member_state,
      p_event->>'surface',
      p_event->>'target',
      v_score_tier,
      p_event->>'result'
    );
  else
    if p_event->>'conversion_step' not in ('play', 'signup') then
      raise exception 'invalid_public_analytics_event'
        using errcode = 'P0001';
    end if;
    insert into public.analytics_events(
      kind,
      member_state,
      source_scope,
      source_kind,
      source_value,
      referrer_domain,
      utm_source,
      utm_medium,
      utm_campaign,
      viral_type,
      conversion_step
    )
    values (
      'conversion',
      p_member_state,
      p_event->>'source_scope',
      p_event->>'source_kind',
      p_event->>'source_value',
      p_event->>'referrer_domain',
      p_event->>'utm_source',
      p_event->>'utm_medium',
      p_event->>'utm_campaign',
      p_event->>'viral_type',
      p_event->>'conversion_step'
    );
  end if;

  return pg_catalog.jsonb_build_object('accepted', true);
exception
  when lock_not_available or query_canceled then
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'reason', 'quota_busy'
    );
end;
$$;
revoke all on function public.record_public_analytics_event(
  text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_public_analytics_event(
  text, text, jsonb
) to service_role;

-- Old app versions used direct service-role INSERT for track/conversion. The
-- writes were always best-effort, so denying that bypass during expand is
-- rollout-safe; only the bounded SECURITY DEFINER RPC above may insert.
revoke insert on table public.analytics_events from service_role;

-- Daily cron authority for the privacy-retention target. Opportunistic pruning
-- above reduces ordinary backlog, while this bounded RPC removes stale opaque
-- actors even when both public endpoints receive zero traffic. A non-done ack
-- is deliberately visible to the scheduler as retryable backlog.
create or replace function public.prune_public_write_quota_buckets(
  p_limit integer default 2000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
  v_cutoff date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date - 2;
  v_deleted integer := 0;
  v_attempt_deleted integer := 0;
  v_bucket_deleted integer := 0;
  v_done boolean;
begin
  if p_limit is null or p_limit < 1 or p_limit > 80000 then
    raise exception 'invalid_public_write_quota_prune_limit'
      using errcode = '22023';
  end if;

  delete from public.public_write_attempts a
   where (a.endpoint, a.operation_key) in (
     select stale.endpoint, stale.operation_key
       from public.public_write_attempts stale
      where stale.day_kst < v_cutoff
      order by stale.day_kst, stale.endpoint, stale.operation_key
      for update skip locked
      limit p_limit
   );
  get diagnostics v_attempt_deleted = row_count;

  delete from public.public_write_quota_buckets q
   where q.ctid in (
     select stale.ctid
       from public.public_write_quota_buckets stale
      where stale.day_kst < v_cutoff
      order by stale.day_kst, stale.endpoint, stale.actor_key
      for update skip locked
      limit greatest(p_limit - v_attempt_deleted, 0)
   );
  get diagnostics v_bucket_deleted = row_count;
  v_deleted := v_attempt_deleted + v_bucket_deleted;

  select not exists (
    select 1
      from public.public_write_quota_buckets q
     where q.day_kst < v_cutoff
  ) and not exists (
    select 1
      from public.public_write_attempts a
     where a.day_kst < v_cutoff
  )
    into v_done;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'deleted', v_deleted,
    'done', v_done,
    'cutoff', v_cutoff
  );
end;
$$;
revoke all on function public.prune_public_write_quota_buckets(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_public_write_quota_buckets(integer)
  to service_role;

do $$
begin
  if not exists (
       select 1
         from pg_catalog.pg_class c
        where c.oid = 'public.public_write_quota_buckets'::regclass
          and c.relrowsecurity
     )
     or not exists (
       select 1
         from pg_catalog.pg_class c
        where c.oid = 'public.public_write_attempts'::regclass
          and c.relrowsecurity
     )
     or pg_catalog.to_regprocedure(
          'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.record_public_analytics_event(text,text,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.prune_public_write_quota_buckets(integer)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_probe_score_write_replay(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_consume_report_legacy_write_quota()'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)'
        ) is null
     or pg_catalog.to_regclass(
          'public.public_write_quota_retention_idx'
        ) is null
     or not pg_catalog.has_function_privilege(
          'service_role',
          'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
          'EXECUTE'
        )
     or not pg_catalog.has_function_privilege(
          'service_role',
          'public.record_public_analytics_event(text,text,jsonb)',
          'EXECUTE'
        )
     or not pg_catalog.has_function_privilege(
          'service_role',
          'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)',
          'EXECUTE'
        )
     or not pg_catalog.has_function_privilege(
          'service_role',
          'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)',
          'EXECUTE'
        )
     or not pg_catalog.has_function_privilege(
          'service_role',
          'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)',
          'EXECUTE'
        )
     or not pg_catalog.has_function_privilege(
          'service_role',
          'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)',
          'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'service_role',
          'public.bp_probe_score_write_replay(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb)',
          'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'service_role',
          'public.bp_consume_report_legacy_write_quota()',
          'EXECUTE'
        )
     or pg_catalog.has_table_privilege(
          'service_role',
          'public.analytics_events',
          'INSERT'
        )
     or pg_catalog.has_table_privilege(
          'service_role',
          'public.content_reports',
          'INSERT'
        )
     or pg_catalog.has_table_privilege(
          'service_role',
          'public.public_write_attempts',
          'SELECT,INSERT,UPDATE,DELETE'
        ) then
    raise exception '008900 postflight: bounded public write surface missing';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('008900_public_write_quotas', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
