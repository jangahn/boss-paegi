-- 0074: score submission / telemetry ownership integrity.
--
-- Security and consistency invariants:
--   * scores is SELECT-only to every PostgREST role. All writes go through
--     SECURITY DEFINER RPCs; the legacy owner INSERT policy is removed.
--   * a telemetry UUID is not a bearer capability. A session-scoped SHA-256
--     binding proves the exact Auth subject without storing an anonymous user id.
--   * profile deletion, member ban, score submit, score report and manual review
--     share explicit locks, so no stale registered score/badge can win a race.
--   * doll ownership and telemetry ownership are checked again in the same
--     transaction that inserts the score.
--   * score stats + badge grants commit atomically and are retryable after a
--     response/network failure.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- ── 1. Session-local submitter binding (no raw anonymous subject at rest) ─────

alter table public.telemetry_sessions
  add column if not exists submitter_binding text;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.telemetry_sessions'::regclass
       and conname = 'telemetry_sessions_submitter_binding_check'
  ) then
    alter table public.telemetry_sessions
      add constraint telemetry_sessions_submitter_binding_check
      check (
        submitter_binding is null
        or submitter_binding ~ '^[0-9a-f]{64}$'
      );
  end if;
end;
$$;

create or replace function public.bp_telemetry_submitter_binding(
  p_session_id uuid,
  p_submitter_id uuid
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        p_session_id::text || ':' || p_submitter_id::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function public.bp_telemetry_submitter_binding(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Existing member sessions are recoverable from their stored owner. Historical
-- anonymous subjects were deliberately never stored, so those rows stay
-- unbound and cannot later be claimed by somebody who only knows the UUID.
update public.telemetry_sessions
   set submitter_binding =
       public.bp_telemetry_submitter_binding(id, owner_id)
 where owner_id is not null
   and is_anon = false
   and submitter_binding is null;

-- A durable winner receipt makes anonymous→member reassignment replay-safe.
-- The source UUID intentionally has no FK: Auth deletes the anonymous subject
-- only after this transaction commits, while the receipt must survive it.
create table if not exists public.anon_data_reassignments (
  source_user_id uuid primary key,
  target_user_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.now()
);
alter table public.anon_data_reassignments enable row level security;
revoke all privileges on table public.anon_data_reassignments
  from public, anon, authenticated, service_role;

create or replace function public.reassign_anon_data(
  p_old uuid,
  p_new uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim_target uuid;
  v_claim_result jsonb;
  v_source_deleted_at timestamptz;
  v_target_deleted_at timestamptz;
  v_scores int := 0;
  v_badges int := 0;
  v_tel int := 0;
  v_result jsonb;
begin
  if p_old is null or p_new is null or p_old = p_new then
    raise exception 'invalid_args' using errcode = 'P0001';
  end if;

  -- Every contender for one signed anonymous source crosses this lock. The
  -- separate target lock serializes badge merges from different sources.
  perform pg_catalog.pg_advisory_xact_lock(
    7401,
    pg_catalog.hashtext(p_old::text)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    7402,
    pg_catalog.hashtext(p_new::text)
  );

  select r.target_user_id, r.result
    into v_claim_target, v_claim_result
    from public.anon_data_reassignments r
   where r.source_user_id = p_old
   for update;
  if found then
    if v_claim_target is distinct from p_new then
      raise exception 'anon_reassignment_conflict'
        using errcode = 'P0001';
    end if;
    return v_claim_result;
  end if;

  -- Lock both lifecycle rows in UUID order. A completed soft delete cannot be
  -- migrated, and a concurrent delete waits until all child ownership moves.
  perform 1
    from public.profiles p
   where p.id in (p_old, p_new)
   order by p.id
   for key share;

  select p.deleted_at
    into v_source_deleted_at
    from public.profiles p
   where p.id = p_old;
  if not found or v_source_deleted_at is not null then
    raise exception 'source_account_unavailable' using errcode = 'P0001';
  end if;
  select p.deleted_at
    into v_target_deleted_at
    from public.profiles p
   where p.id = p_new;
  if not found or v_target_deleted_at is not null then
    raise exception 'target_account_unavailable' using errcode = 'P0001';
  end if;

  -- Share the exact per-user lock namespace with score/report/ban/telemetry.
  -- UUID ordering prevents opposite-direction migrations from deadlocking.
  if p_old::text < p_new::text then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('member:' || p_old::text)::bigint
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('member:' || p_new::text)::bigint
    );
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('member:' || p_new::text)::bigint
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('member:' || p_old::text)::bigint
    );
  end if;

  update public.scores
     set owner_id = p_new
   where owner_id = p_old;
  get diagnostics v_scores = row_count;

  update public.user_badges ub
     set owner_id = p_new
   where ub.owner_id = p_old
     and not exists (
       select 1
         from public.user_badges x
        where x.owner_id = p_new
          and x.badge_id = ub.badge_id
     );
  get diagnostics v_badges = row_count;
  delete from public.user_badges where owner_id = p_old;

  -- 0031 stored anonymous ownership in owner_id. 0074 intentionally stores no
  -- raw anonymous subject, so both the legacy owner and exact session binding
  -- paths are migrated. Unbound/unrelated NULL-owner rows cannot be claimed.
  update public.telemetry_sessions t
     set owner_id = p_new,
         is_anon = false,
         submitter_binding =
           public.bp_telemetry_submitter_binding(t.id, p_new)
   where t.owner_id = p_old
      or (
        t.owner_id is null
        and t.is_anon = true
        and t.submitter_binding =
          public.bp_telemetry_submitter_binding(t.id, p_old)
      );
  get diagnostics v_tel = row_count;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'scores', v_scores,
    'badges', v_badges,
    'telemetry', v_tel
  );
  insert into public.anon_data_reassignments (
    source_user_id,
    target_user_id,
    result
  )
  values (p_old, p_new, v_result);
  return v_result;
end;
$$;

revoke all on function public.reassign_anon_data(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reassign_anon_data(uuid, uuid)
  to service_role;

-- NOT VALID preserves any historical orphan while enforcing the FK for every
-- new/updated score immediately. Telemetry pruning already excludes linked rows.
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.scores'::regclass
       and conname = 'scores_telemetry_session_fk'
  ) then
    alter table public.scores
      add constraint scores_telemetry_session_fk
      foreign key (telemetry_session_id)
      references public.telemetry_sessions(id)
      on delete set null
      not valid;
  end if;
end;
$$;

alter table public.scores
  add column if not exists submission_id uuid,
  add column if not exists submission_fingerprint text,
  add column if not exists submission_origin_owner_id uuid;
update public.scores
   set submission_origin_owner_id = owner_id
 where submission_id is not null
   and submission_origin_owner_id is null;
drop index if exists public.uq_scores_owner_submission;
create unique index if not exists uq_scores_origin_submission
  on public.scores(submission_origin_owner_id, submission_id)
  where submission_id is not null;
comment on column public.scores.submission_id is
  'Per-game client idempotency UUID, independent of optional telemetry.';
comment on column public.scores.submission_fingerprint is
  'SHA-256 of the server-canonical immutable score and gameplay report inputs.';
comment on column public.scores.submission_origin_owner_id is
  'Auth owner namespace that minted submission_id; remains stable across anonymous reassignment.';
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.scores'::regclass
       and conname = 'scores_submission_fingerprint_shape'
  ) then
    alter table public.scores
      add constraint scores_submission_fingerprint_shape
      check (
        submission_fingerprint is null
        or submission_fingerprint ~ '^[0-9a-f]{64}$'
      );
  end if;
end;
$$;
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.scores'::regclass
       and conname = 'scores_submission_identity_complete'
  ) then
    alter table public.scores
      add constraint scores_submission_identity_complete
      check (
        (
          submission_id is null
          and submission_fingerprint is null
          and submission_origin_owner_id is null
        )
        or (
          submission_id is not null
          and submission_fingerprint is not null
          and submission_origin_owner_id is not null
        )
      );
  end if;
end;
$$;

comment on column public.telemetry_sessions.submitter_binding is
  'sha256(lower session UUID || colon || lower Auth subject UUID); anonymous owner_id remains NULL';

-- ── 2. Exact scores ACL: raw rows are server-only, writes are RPC-only ───────

drop policy if exists "scores: owner insert" on public.scores;

-- Supabase project defaults had drifted to ALL for anon/authenticated in prod.
-- Revoke the entire table surface, including TRUNCATE/TRIGGER/REFERENCES, then
-- add back only server SELECT. Public reads use server routes that enforce the
-- visible-state projection; raw Data API SELECT would expose pending/voided
-- rows and linked moderation/report metadata.
revoke all privileges on table public.scores
  from public, anon, authenticated, service_role;
grant select on table public.scores to service_role;

-- Table-level REVOKE does not remove independently granted column privileges.
do $$
declare
  v_columns text;
  v_grantee text;
begin
  select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ')
    into v_columns
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.scores'::regclass
     and a.attnum > 0
     and not a.attisdropped;

  foreach v_grantee in array array['PUBLIC', 'anon', 'authenticated', 'service_role']
  loop
    execute
      'revoke insert (' || v_columns || '), update (' || v_columns ||
      '), references (' || v_columns || ') on table public.scores from ' ||
      case when v_grantee = 'PUBLIC'
        then 'PUBLIC'
        else pg_catalog.quote_ident(v_grantee)
      end;
  end loop;
end;
$$;

-- Rolling expand stage: the atomic RPC is available immediately, while the
-- currently deployed server can still finish its direct score report writes.
-- 0092 removes these three DML grants after the new server is live.
revoke insert, update, delete, truncate, trigger, references
  on table public.score_stats, public.user_badges
  from service_role;
grant select, insert, update, delete
  on table public.score_stats, public.user_badges
  to service_role;

-- ── 3. Bounded, deterministic visible leaderboard ───────────────────────────

create or replace function public.get_leaderboard(
  period text default 'daily',
  max_limit int default 10
)
returns table (
  id uuid,
  owner_id uuid,
  score int,
  weapon text,
  duration_ms int,
  created_at timestamptz,
  display_name text,
  avatar_url text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with windowed as (
    select s.*
      from public.scores s
     where s.review_status in ('registered', 'cleared')
       and s.created_at >= case
         when period = 'weekly'
           then (
             pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'Asia/Seoul')
             at time zone 'Asia/Seoul'
           )
         when period = 'monthly'
           then (
             pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'Asia/Seoul')
             at time zone 'Asia/Seoul'
           )
         else (
           pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'Asia/Seoul')
           at time zone 'Asia/Seoul'
         )
       end
  ),
  best as (
    select distinct on (s.owner_id) s.*
      from windowed s
     order by s.owner_id, s.score desc, s.created_at desc, s.id desc
  )
  select b.id, b.owner_id, b.score, b.weapon, b.duration_ms, b.created_at,
         p.display_name, p.avatar_url
    from best b
    left join public.profiles p on p.id = b.owner_id
   order by b.score desc, b.created_at desc, b.id desc
   limit least(
     greatest(coalesce(max_limit, 10), 0),
     100
   );
$$;

revoke all on function public.get_leaderboard(text, int)
  from public, anon, authenticated, service_role;
grant execute on function public.get_leaderboard(text, int)
  to service_role;
revoke all on function public.get_score_percentile(int)
  from public, anon, authenticated, service_role;
grant execute on function public.get_score_percentile(int)
  to service_role;

-- Private rolling-deploy switch. The old server does not mint the per-game
-- submission identity added by this migration. Keep that exact legacy shape
-- alive only until the new server has replaced every old invocation; 0092
-- changes this function to false without rewriting the score RPC.
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
    'legacy_checkout_reuse'
  );
$$;
revoke all on function public.bp_rollout_compatibility_enabled(text)
  from public, anon, authenticated, service_role;

-- ── 4. Score insert: lifecycle/owner/ban checks in the insert transaction ────

create or replace function public.submit_score_with_review(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score int,
  p_weapon text,
  p_duration_ms int,
  p_max_combo int,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_review_status text,
  p_signals jsonb,
  p_evidence jsonb,
  p_abuse_score int,
  p_rules_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_deleted_at timestamptz;
  v_member public.member_accounts%rowtype;
  v_is_member boolean := false;
  v_banned boolean := false;
  v_doll_owner uuid;
  v_doll_deleted_at timestamptz;
  v_tel_owner uuid;
  v_tel_is_anon boolean;
  v_tel_binding text;
  v_expected_binding text;
  v_submission_text text;
  v_submission_id uuid;
  v_submission_fingerprint text;
  v_legacy_rollout boolean := false;
  v_migrated_source_text text;
  v_migrated_source uuid;
  v_submission_origin_owner uuid;
  v_id uuid;
  v_existing public.scores%rowtype;
  v_review_status text := p_review_status;
  v_signals jsonb := coalesce(p_signals, '[]'::jsonb);
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_abuse_score int := coalesce(p_abuse_score, 0);
  v_has_banned_signal boolean := false;
  v_flagged boolean;
  v_end_reason text :=
    case when p_end_reason in ('time_limit', 'score_limit')
      then p_end_reason else 'normal' end;
  v_max_combo int := greatest(coalesce(p_max_combo, 0), 0);
begin
  if p_owner_id is null then
    raise exception 'invalid_owner' using errcode = 'P0001';
  end if;

  -- Lock order is shared with account deletion: profile first. delete-first
  -- waits then fails closed; submit-first completes before deletion snapshots.
  select p.deleted_at
    into v_profile_deleted_at
    from public.profiles p
   where p.id = p_owner_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_profile_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  -- Same advisory key/order as admin_ban_member. No registered score can commit
  -- from a stale pre-ban route read.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || p_owner_id::text)::bigint
  );
  if exists (
    select 1
      from public.anon_data_reassignments r
     where r.source_user_id = p_owner_id
  ) then
    raise exception 'account_migrated' using errcode = 'P0001';
  end if;
  select *
    into v_member
    from public.member_accounts m
   where m.user_id = p_owner_id
   for key share;
  v_is_member := found;
  v_banned := v_is_member and v_member.abuse_status = 'banned';

  if p_score is null
     or p_score < 0
     or p_score > least(
       pg_catalog.ceil(p_duration_ms / 1000.0 * 2000)::int,
       5000000
     )
     or p_duration_ms is null
     or p_duration_ms <= 0
     or p_duration_ms > 1800000
     or v_max_combo >= 100000
     or p_weapon is null
     or p_weapon not in (
       'fist', 'hammer', 'slap', 'book', 'keyboard',
       'paper', 'gun', 'grab', 'pen'
     )
  then
    raise exception 'invalid_score_protocol' using errcode = 'P0001';
  end if;

  if pg_catalog.jsonb_typeof(v_signals) <> 'array'
     or pg_catalog.jsonb_array_length(v_signals) > 32
     or pg_catalog.jsonb_typeof(v_evidence) <> 'object'
     or pg_catalog.pg_column_size(v_evidence) > 32768
     or v_abuse_score < 0
     or v_abuse_score > 1000
     or p_rules_version is null
     or pg_catalog.length(p_rules_version) > 100
  then
    raise exception 'invalid_review_payload' using errcode = 'P0001';
  end if;

  if p_review_status not in ('registered', 'pending', 'voided') then
    raise exception 'invalid_review_status' using errcode = 'P0001';
  end if;

  -- New clients embed the per-game key in the already-versioned evidence
  -- payload, preserving the RPC signature. During the bounded DB-first rolling
  -- window only, synthesize a deterministic identity for the exact old-server
  -- shape (both fields absent). One-field/malformed shapes still fail closed.
  v_submission_text := v_evidence->>'submissionId';
  v_submission_fingerprint := v_evidence->>'submissionFingerprint';
  if v_submission_text is null
     and v_submission_fingerprint is null
     and public.bp_rollout_compatibility_enabled(
       'legacy_score_submission'
     )
  then
    v_legacy_rollout := true;
    -- With no stable client nonce, a response-loss retry and a second
    -- identical game are information-theoretically indistinguishable. Refuse
    -- that unsafe old shape rather than minting a duplicate-prone random UUID.
    if p_telemetry_session_id is null then
      raise exception 'client_upgrade_required' using errcode = 'P0001';
    end if;
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
    v_evidence := v_evidence || pg_catalog.jsonb_build_object(
      'legacyRollingSubmission', true
    );
  else
    if v_submission_text is null
       or v_submission_text !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    then
      raise exception 'invalid_submission_id' using errcode = 'P0001';
    end if;
    v_submission_id := v_submission_text::uuid;
    if v_submission_fingerprint is null
       or v_submission_fingerprint !~ '^[0-9a-f]{64}$'
    then
      raise exception 'invalid_submission_fingerprint' using errcode = 'P0001';
    end if;
  end if;
  v_migrated_source_text :=
    case
      when v_evidence->>'migratedSourceOwnerId' = '' then null
      else v_evidence->>'migratedSourceOwnerId'
    end;
  if v_migrated_source_text is not null then
    if v_migrated_source_text !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then
      raise exception 'invalid_migrated_replay_source'
        using errcode = 'P0001';
    end if;
    v_migrated_source := v_migrated_source_text::uuid;
    if v_migrated_source = p_owner_id
       or not exists (
         select 1
           from public.anon_data_reassignments r
          where r.source_user_id = v_migrated_source
            and r.target_user_id = p_owner_id
            and r.result->>'ok' = 'true'
       )
    then
      raise exception 'migrated_replay_not_authorized'
        using errcode = 'P0001';
    end if;
    v_submission_origin_owner := v_migrated_source;
    select *
      into v_existing
      from public.scores s
     where s.owner_id = p_owner_id
       and s.submission_origin_owner_id = v_submission_origin_owner
       and s.submission_id = v_submission_id
       and s.submission_fingerprint = v_submission_fingerprint
     for update;
    if not found then
      raise exception 'migrated_score_replay_mismatch'
        using errcode = 'P0001';
    end if;
  else
    v_submission_origin_owner := p_owner_id;
  end if;

  if p_doll_id is not null then
    select d.owner_id, d.deleted_at
      into v_doll_owner, v_doll_deleted_at
      from public.dolls d
     where d.id = p_doll_id
     for key share;
    if not found
       or v_doll_owner is distinct from p_owner_id
       or v_doll_deleted_at is not null
    then
      raise exception 'doll_ownership_mismatch' using errcode = 'P0001';
    end if;
  end if;

  if p_telemetry_session_id is not null then
    select t.owner_id, t.is_anon, t.submitter_binding
      into v_tel_owner, v_tel_is_anon, v_tel_binding
      from public.telemetry_sessions t
     where t.id = p_telemetry_session_id
     for key share;
    if not found then
      raise exception 'telemetry_session_owner_mismatch' using errcode = 'P0001';
    end if;

    v_expected_binding :=
      public.bp_telemetry_submitter_binding(
        p_telemetry_session_id,
        p_owner_id
      );
    -- The old telemetry route intentionally stored anonymous owner_id=NULL and
    -- had no submitter binding input. The same authenticated old score request
    -- may claim that exact unbound row once during the rolling window.
    if v_legacy_rollout
       and not v_is_member
       and v_tel_is_anon is true
       and v_tel_owner is null
       and v_tel_binding is null
    then
      update public.telemetry_sessions
         set submitter_binding = v_expected_binding
       where id = p_telemetry_session_id
         and owner_id is null
         and is_anon = true
         and submitter_binding is null
      returning submitter_binding into v_tel_binding;
    end if;
    if v_tel_binding is distinct from v_expected_binding
       or (
         v_is_member
         and (v_tel_is_anon is distinct from false
              or v_tel_owner is distinct from p_owner_id)
       )
       or (
         not v_is_member
         and (v_tel_is_anon is distinct from true
              or v_tel_owner is not null)
       )
    then
      raise exception 'telemetry_session_owner_mismatch' using errcode = 'P0001';
    end if;
  end if;

  -- DB-observed ban is authoritative. Append the signal/evidence even if a
  -- stale route computed registered before it waited on the member lock.
  if v_banned then
    select exists(
      select 1
        from pg_catalog.jsonb_array_elements(v_signals) e
       where e->>'id' = 'BANNED_MEMBER'
    ) into v_has_banned_signal;
    if not v_has_banned_signal then
      v_signals := v_signals || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id', 'BANNED_MEMBER',
          'value', null,
          'threshold', null,
          'source', 'submit'
        )
      );
      v_abuse_score := least(v_abuse_score + 3, 1000);
    end if;
    v_evidence := v_evidence ||
      pg_catalog.jsonb_build_object('dbBannedAtSubmit', true);
    v_review_status := 'voided';
  end if;

  v_flagged := v_review_status in ('pending', 'voided');
  if (v_review_status = 'registered'
      and (pg_catalog.jsonb_array_length(v_signals) <> 0 or v_abuse_score <> 0))
     or (v_flagged
         and (pg_catalog.jsonb_array_length(v_signals) = 0
              or v_abuse_score <= 0))
  then
    raise exception 'review_payload_mismatch' using errcode = 'P0001';
  end if;

  begin
    insert into public.scores (
      owner_id,
      doll_id,
      score,
      weapon,
      duration_ms,
      max_combo,
      end_reason,
      telemetry_session_id,
      submission_id,
      submission_fingerprint,
      submission_origin_owner_id,
      review_status
    )
    values (
      p_owner_id,
      p_doll_id,
      p_score,
      p_weapon,
      p_duration_ms,
      v_max_combo,
      v_end_reason,
      p_telemetry_session_id,
      v_submission_id,
      v_submission_fingerprint,
      v_submission_origin_owner,
      v_review_status
    )
    returning id into v_id;
  exception
    when unique_violation then
      select *
       into v_existing
        from public.scores s
       where s.submission_origin_owner_id =
             v_submission_origin_owner
         and s.submission_id = v_submission_id
       for update;
      if not found then
        if p_telemetry_session_id is null then
          raise;
        end if;
        select *
          into v_existing
          from public.scores s
         where s.telemetry_session_id = p_telemetry_session_id
         for update;
        if not found then
          raise;
        end if;
      end if;
      -- The fingerprint binds the normalized requested doll/telemetry UUIDs.
      -- The accepted links themselves are DB-observation dependent: an ingest
      -- or owner row may become visible between response-loss retries. Keep
      -- the first committed links and converge when the immutable request
      -- fingerprint/core are identical.
      if v_existing.owner_id is distinct from p_owner_id
         or v_existing.submission_origin_owner_id is distinct from
            v_submission_origin_owner
         or v_existing.submission_id is distinct from v_submission_id
         or v_existing.submission_fingerprint is distinct from
            v_submission_fingerprint
         or v_existing.score is distinct from p_score
         or v_existing.weapon is distinct from p_weapon
         or v_existing.duration_ms is distinct from p_duration_ms
         or v_existing.max_combo is distinct from v_max_combo
         or v_existing.end_reason is distinct from v_end_reason
      then
        if v_existing.owner_id = p_owner_id
           and v_existing.submission_id = v_submission_id
        then
          raise exception 'submission_id_conflict' using errcode = 'P0001';
        end if;
        raise exception 'telemetry_session_conflict'
          using errcode = 'P0001';
      end if;
      return pg_catalog.jsonb_build_object(
        'scoreId', v_existing.id,
        'reviewStatus', v_existing.review_status,
        'duplicate', true
      );
  end;

  if v_flagged then
    insert into public.score_flags (
      score_id,
      signals,
      evidence,
      abuse_score,
      rules_version,
      status
    )
    values (
      v_id,
      v_signals,
      v_evidence,
      v_abuse_score,
      p_rules_version,
      v_review_status
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'scoreId', v_id,
    'reviewStatus', v_review_status,
    'duplicate', false
  );
end;
$$;

revoke all on function public.submit_score_with_review(
  uuid, uuid, int, text, int, int, text, uuid, text, jsonb, jsonb, int, text
) from public, anon, authenticated, service_role;
grant execute on function public.submit_score_with_review(
  uuid, uuid, int, text, int, int, text, uuid, text, jsonb, jsonb, int, text
) to service_role;

-- ── 5. Retryable all-or-nothing score report / badge grant ───────────────────

create or replace function public.commit_score_report(
  p_score_id uuid,
  p_owner_id uuid,
  p_gameplay_stats jsonb,
  p_persona_id text,
  p_badge_ids text[],
  p_percentile int,
  p_known_badge_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_score public.scores%rowtype;
  v_abuse_status text;
  v_badge_ids text[];
  v_known_badge_ids text[];
  v_new_badges text[];
  v_collected int := 0;
  v_stats public.score_stats%rowtype;
begin
  if p_score_id is null
     or p_owner_id is null
     or p_gameplay_stats is null
     or pg_catalog.jsonb_typeof(p_gameplay_stats) <> 'object'
     or pg_catalog.pg_column_size(p_gameplay_stats) > 65536
     or p_persona_id is null
     or pg_catalog.length(p_persona_id) > 100
     or p_percentile is not null
        and (p_percentile < 1 or p_percentile > 100)
  then
    raise exception 'invalid_score_report' using errcode = 'P0001';
  end if;

  -- The account lifecycle fence must be the first stateful boundary. Account
  -- deletion takes this same canonical member namespace before locking the
  -- profile row. Taking profile KEY SHARE first would invert that order and,
  -- after a delete-first wait, leave this function acting on a stale
  -- deleted_at snapshot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || p_owner_id::text)::bigint
  );
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_owner_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  select m.abuse_status
    into v_abuse_status
    from public.member_accounts m
   where m.user_id = p_owner_id
   for key share;
  if found and v_abuse_status = 'banned' then
    raise exception 'member_banned' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('score:' || p_score_id::text)::bigint
  );
  select *
    into v_score
    from public.scores s
   where s.id = p_score_id
   for update;
  if not found or v_score.owner_id is distinct from p_owner_id then
    raise exception 'score_owner_mismatch' using errcode = 'P0001';
  end if;
  if v_score.review_status not in ('registered', 'cleared') then
    raise exception 'score_not_publishable' using errcode = 'P0001';
  end if;

  select coalesce(
           pg_catalog.array_agg(x.badge_id order by x.badge_id),
           array[]::text[]
         )
    into v_badge_ids
    from (
      select distinct pg_catalog.left(b.badge_id, 40) as badge_id
        from pg_catalog.unnest(
          coalesce(p_badge_ids, array[]::text[])
        ) b(badge_id)
       where b.badge_id is not null
         and pg_catalog.length(b.badge_id) between 1 and 40
       limit 120
    ) x;

  select coalesce(
           pg_catalog.array_agg(x.badge_id order by x.badge_id),
           array[]::text[]
         )
    into v_known_badge_ids
    from (
      select distinct pg_catalog.left(b.badge_id, 40) as badge_id
        from pg_catalog.unnest(
          coalesce(p_known_badge_ids, array[]::text[])
        ) b(badge_id)
       where b.badge_id is not null
         and pg_catalog.length(b.badge_id) between 1 and 40
       limit 120
    ) x;

  insert into public.score_stats (
    score_id,
    gameplay_stats,
    persona_id,
    badge_ids,
    percentile
  )
  values (
    p_score_id,
    p_gameplay_stats,
    p_persona_id,
    v_badge_ids,
    p_percentile
  )
  on conflict (score_id) do nothing;

  select *
    into v_stats
    from public.score_stats st
   where st.score_id = p_score_id;

  -- The first report snapshot is immutable. A retry after config drift must not
  -- grant badges that are absent from the persisted score_stats.badge_ids.
  v_badge_ids := coalesce(v_stats.badge_ids, array[]::text[]);

  insert into public.user_badges(owner_id, badge_id, first_score_id)
  select p_owner_id, b.badge_id, p_score_id
    from pg_catalog.unnest(v_badge_ids) b(badge_id)
  on conflict (owner_id, badge_id) do nothing;

  -- `RETURNING` alone loses this UX fact after a committed response is lost:
  -- the retry inserts zero rows even though this exact score first earned them.
  -- first_score_id is the durable receipt, and excludes badges owned earlier.
  select coalesce(
           pg_catalog.array_agg(ub.badge_id order by ub.badge_id),
           array[]::text[]
         )
    into v_new_badges
    from public.user_badges ub
   where ub.owner_id = p_owner_id
     and ub.first_score_id = p_score_id
     and ub.badge_id = any(v_badge_ids);

  select pg_catalog.count(*)::int
    into v_collected
    from public.user_badges ub
   where ub.owner_id = p_owner_id
     and ub.badge_id = any(v_known_badge_ids);

  return pg_catalog.jsonb_build_object(
    'personaId', v_stats.persona_id,
    'percentile', v_stats.percentile,
    'newBadges', pg_catalog.to_jsonb(v_new_badges),
    'collectedCount', v_collected
  );
end;
$$;

revoke all on function public.commit_score_report(
  uuid, uuid, jsonb, text, text[], int, text[]
) from public, anon, authenticated, service_role;
grant execute on function public.commit_score_report(
  uuid, uuid, jsonb, text, text[], int, text[]
) to service_role;

-- ── 6. Telemetry ingest with exact subject binding ───────────────────────────

create or replace function public.ingest_telemetry_delta(
  p_session_id uuid,
  p_owner_id uuid,
  p_is_member boolean,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_daily_cap int := 5000;
  c_max_timeline int := 2000;
  c_max_write int := 400;
  c_max_duration int := 1804000;
  c_max_score bigint := 5000000;
  c_max_avg_per_sec int := 2000;
  c_weapon_count int := 9;
  c_map_count int := 6;

  v_budget public.telemetry_budget;
  v_today date := (pg_catalog.now() at time zone 'Asia/Seoul')::date;
  v_mode text;
  v_sess public.telemetry_sessions;
  v_exists boolean;
  v_actual_member boolean := false;
  v_is_anon boolean;
  v_owner uuid;
  v_binding text;
  v_profile_deleted_at timestamptz;
  v_device text;
  v_summary jsonb := coalesce(p_payload->'summary', '{}'::jsonb);
  v_events jsonb := coalesce(p_payload->'events', '[]'::jsonb);
  v_seq_high int :=
    coalesce(nullif(v_summary->>'seqHigh', '')::int, 0);
  v_end_reason text := nullif(v_summary->>'endReason', '');
  v_allow_timeline boolean;
  v_filtered jsonb;
  v_max_new_seq int;
  v_cnt_new int;
  v_min_new_seq int;
  v_new_timeline jsonb;
  v_timeline_dropped boolean;
  v_has_gap boolean;
  v_last_seq int;
  v_dur int;
  v_score bigint;
  v_hit int;
  v_wsum numeric;
  v_suspicious boolean;
begin
  if p_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'mode', 'off', 'reason', 'no_session'
    );
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'mode', 'off', 'reason', 'invalid_payload'
    );
  end if;

  -- Authenticated subjects, including anonymous/pre-consent subjects, lock the
  -- lifecycle row. The raw subject is used only as a hash input below.
  if p_owner_id is not null then
    -- Keep the canonical user advisory ahead of every profile/member/session
    -- read. A delete-first transaction therefore commits before this SELECT
    -- takes its snapshot, so a stale active account can never create or mutate
    -- telemetry after deletion.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('member:' || p_owner_id::text)::bigint
    );
    select p.deleted_at
      into v_profile_deleted_at
      from public.profiles p
     where p.id = p_owner_id
     for key share;
    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'account_not_found'
      );
    end if;
    if v_profile_deleted_at is not null then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'account_deleted'
      );
    end if;
    if exists (
      select 1
        from public.anon_data_reassignments r
       where r.source_user_id = p_owner_id
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'account_migrated'
      );
    end if;
    select exists(
      select 1
        from public.member_accounts m
       where m.user_id = p_owner_id
    ) into v_actual_member;
    v_binding :=
      public.bp_telemetry_submitter_binding(p_session_id, p_owner_id);
  end if;

  if coalesce(p_is_member, false) is distinct from v_actual_member then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'mode', 'off', 'reason', 'member_mismatch'
    );
  end if;
  v_is_anon := not v_actual_member;
  v_owner := case when v_actual_member then p_owner_id else null end;

  -- 1) budget lock + day rollover + mode.
  select *
    into v_budget
    from public.telemetry_budget
   where id = true
   for update;
  if not found then
    insert into public.telemetry_budget(id)
    values (true)
    on conflict (id) do nothing;
    select *
      into v_budget
      from public.telemetry_budget
     where id = true
     for update;
  end if;
  if v_budget.day_kst is distinct from v_today then
    update public.telemetry_budget
       set day_kst = v_today,
           new_sessions_today = 0,
           updated_at = pg_catalog.now()
     where id = true;
    v_budget.day_kst := v_today;
    v_budget.new_sessions_today := 0;
  end if;
  v_mode := case
    when v_budget.degrade_mode = 'off' then 'off'
    when v_budget.over_budget then 'summary'
    when v_budget.new_sessions_today >= c_daily_cap then 'summary'
    else 'full'
  end;

  v_device := coalesce(p_payload->>'deviceClass', 'other');
  if v_device not in (
    'mobile-touch', 'mobile-pointer', 'desktop-touch',
    'desktop-pointer', 'other'
  ) then
    v_device := 'other';
  end if;

  -- 2) session lock/create. owner shape and binding are immutable.
  select *
    into v_sess
    from public.telemetry_sessions
   where id = p_session_id
   for update;
  v_exists := found;

  if not v_exists then
    if v_mode = 'off' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'budget'
      );
    end if;
    insert into public.telemetry_sessions(
      id,
      owner_id,
      is_anon,
      submitter_binding,
      device_class,
      started_at
    )
    values (
      p_session_id,
      v_owner,
      v_is_anon,
      v_binding,
      v_device,
      coalesce(
        nullif(p_payload->>'startedAt', '')::timestamptz,
        pg_catalog.now()
      )
    );
    update public.telemetry_budget
       set new_sessions_today = new_sessions_today + 1,
           updated_at = pg_catalog.now()
     where id = true;
    select *
      into v_sess
      from public.telemetry_sessions
     where id = p_session_id
     for update;
  else
    if v_sess.owner_id is distinct from v_owner
       or v_sess.is_anon is distinct from v_is_anon
       or v_sess.submitter_binding is distinct from v_binding
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', v_mode, 'reason', 'owner_mismatch'
      );
    end if;
  end if;

  -- off + existing session permits only one final session_end.
  if v_mode = 'off' and v_exists then
    if v_sess.ended_at is not null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'mode', 'off',
        'reason', 'already_finalized',
        'lastSeq', v_sess.last_seq
      );
    end if;
    if v_end_reason is null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'mode', 'off',
        'reason', 'pending',
        'lastSeq', v_sess.last_seq
      );
    end if;
  end if;

  -- 3) Anonymous/pre-consent sessions are summary-only.
  v_allow_timeline :=
    v_mode = 'full'
    and not v_is_anon
    and not v_sess.timeline_dropped
    and v_sess.write_count < c_max_write;

  -- 4) summary clamp + latest-wins.
  if v_seq_high >= v_sess.last_seq then
    v_dur := least(
      greatest(
        coalesce(
          nullif(v_summary->>'durationMs', '')::int,
          0
        ),
        0
      ),
      c_max_duration
    );
    v_score := least(
      greatest(
        coalesce(
          nullif(v_summary#>>'{totals,score}', '')::bigint,
          0
        ),
        0
      ),
      c_max_score
    );
    v_hit := greatest(
      coalesce(
        nullif(v_summary#>>'{totals,hitCount}', '')::int,
        0
      ),
      0
    );
    select coalesce(
             pg_catalog.sum(
               greatest(
                 coalesce(
                   nullif(e.value->>'hits', '')::numeric,
                   0
                 ),
                 0
               )
             ),
             0
           )
      into v_wsum
      from pg_catalog.jsonb_each(
        coalesce(v_summary->'weaponSummary', '{}'::jsonb)
      ) e;
    v_suspicious :=
      v_score > (
        greatest(1, pg_catalog.ceil(v_dur / 1000.0))
        * c_max_avg_per_sec
      )
      or pg_catalog.abs(v_wsum - v_hit) >
         greatest(10, v_hit * 0.2);

    update public.telemetry_sessions
       set ended_at = coalesce(
             nullif(v_summary->>'endedAt', '')::timestamptz,
             ended_at
           ),
           end_reason = case
             when v_end_reason in (
               'normal', 'time_limit', 'score_limit',
               'abandon', 'reload', 'hidden_timeout'
             )
             then v_end_reason
             else end_reason
           end,
           duration_ms = v_dur,
           score = v_score,
           hit_count = v_hit,
           max_combo = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,maxCombo}', ''
                 )::int,
                 0
               ),
               0
             ),
             999999
           ),
           ult_fire_count = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,ultFireCount}', ''
                 )::int,
                 0
               ),
               0
             ),
             100000
           ),
           distinct_weapons = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,distinctWeapons}', ''
                 )::int,
                 0
               ),
               0
             ),
             c_weapon_count
           ),
           distinct_maps = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,distinctMaps}', ''
                 )::int,
                 0
               ),
               0
             ),
             c_map_count
           ),
           apm = least(
             greatest(
               coalesce(
                 nullif(v_summary#>>'{totals,apm}', '')::int,
                 0
               ),
               0
             ),
             100000
           ),
           tap_share = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,tapShare}', ''
                 )::numeric,
                 0
               ),
               0
             ),
             1
           ),
           max_touch = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,maxTouch}', ''
                 )::int,
                 0
               ),
               0
             ),
             20
           ),
           dpr = least(
             greatest(
               coalesce(
                 nullif(v_summary#>>'{totals,dpr}', '')::numeric,
                 0
               ),
               0
             ),
             8
           ),
           refresh_hz = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,refreshHz}', ''
                 )::int,
                 0
               ),
               0
             ),
             360
           ),
           avg_frame_ms = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,avgFrameMs}', ''
                 )::numeric,
                 0
               ),
               0
             ),
             10000
           ),
           p95_frame_ms = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,p95FrameMs}', ''
                 )::numeric,
                 0
               ),
               0
             ),
             10000
           ),
           start_map = coalesce(
             pg_catalog.left(
               nullif(v_summary->>'startMap', ''),
               40
             ),
             start_map
           ),
           start_weapon = coalesce(
             pg_catalog.left(
               nullif(v_summary->>'startWeapon', ''),
               40
             ),
             start_weapon
           ),
           weapon_summary =
             coalesce(v_summary->'weaponSummary', weapon_summary),
           map_summary =
             coalesce(v_summary->'mapSummary', map_summary),
           first_hit_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,firstHitMs}', ''
             )::int,
             first_hit_ms
           ),
           first_switch_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,firstSwitchMs}', ''
             )::int,
             first_switch_ms
           ),
           first_ult_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,firstUltMs}', ''
             )::int,
             first_ult_ms
           ),
           abandon_at_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,abandonAtMs}', ''
             )::int,
             abandon_at_ms
           ),
           suspicious = suspicious or v_suspicious,
           updated_at = pg_catalog.now()
     where id = p_session_id;
  end if;

  -- 5) Full-mode member timeline append with seq dedup/gap tracking.
  v_last_seq := v_sess.last_seq;
  v_has_gap := v_sess.has_gap;
  v_timeline_dropped := v_sess.timeline_dropped;
  if v_allow_timeline and pg_catalog.jsonb_array_length(v_events) > 0 then
    select pg_catalog.jsonb_agg(e order by (e->>'seq')::int),
           pg_catalog.max((e->>'seq')::int),
           pg_catalog.min((e->>'seq')::int),
           pg_catalog.count(*)
      into v_filtered, v_max_new_seq, v_min_new_seq, v_cnt_new
      from pg_catalog.jsonb_array_elements(v_events) e
     where coalesce(
       nullif(e->>'seq', '')::int,
       -1
     ) > v_sess.last_seq;
    if coalesce(v_cnt_new, 0) > 0 then
      if v_min_new_seq > v_sess.last_seq + 1 then
        v_has_gap := true;
      end if;
      if v_max_new_seq - v_sess.last_seq <> v_cnt_new then
        v_has_gap := true;
      end if;
      v_new_timeline :=
        coalesce(v_sess.timeline, '[]'::jsonb) || v_filtered;
      if pg_catalog.jsonb_array_length(v_new_timeline) > c_max_timeline then
        v_timeline_dropped := true;
      else
        update public.telemetry_sessions
           set timeline = v_new_timeline
         where id = p_session_id;
      end if;
      v_last_seq := greatest(v_last_seq, v_max_new_seq);
    end if;
  end if;

  -- 6) Unified sequence/write state.
  v_last_seq := greatest(v_last_seq, v_seq_high);
  update public.telemetry_sessions
     set last_seq = v_last_seq,
         has_gap = v_has_gap,
         timeline_dropped = v_timeline_dropped,
         write_count = write_count + 1,
         updated_at = pg_catalog.now()
   where id = p_session_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'lastSeq', v_last_seq
  );
end;
$$;

revoke all on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.ingest_telemetry_delta(
  uuid, uuid, boolean, jsonb
) to service_role;

-- ── 6b. Deleted-owner child-write backstops ──────────────────────────────────
-- The RPC lifecycle checks above are the fail-fast authority. These triggers
-- are the last DB boundary for future/internal direct writes and guarantee
-- that score report artifacts and member telemetry cannot be committed after
-- profiles.deleted_at becomes durable.

create or replace function public.bp_reject_deleted_score_report_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
begin
  select p.deleted_at
    into v_deleted_at
    from public.scores s
    join public.profiles p on p.id = s.owner_id
   where s.id = new.score_id
   for key share of s, p;
  if not found then
    raise exception 'score_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_reject_deleted_score_report_insert()
  from public, anon, authenticated, service_role;

create or replace function public.bp_reject_deleted_telemetry_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
begin
  -- Anonymous telemetry deliberately stores owner_id=NULL. A non-NULL owner is
  -- a durable member child and must share the profile lifecycle fence.
  if new.owner_id is null then
    return new;
  end if;
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = new.owner_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_reject_deleted_telemetry_write()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_score_stats_reject_deleted_owner_insert
  on public.score_stats;
create trigger trg_score_stats_reject_deleted_owner_insert
  before insert on public.score_stats
  for each row
  execute function public.bp_reject_deleted_score_report_insert();

drop trigger if exists trg_user_badges_reject_deleted_owner_insert
  on public.user_badges;
create trigger trg_user_badges_reject_deleted_owner_insert
  before insert on public.user_badges
  for each row execute function public.bp_reject_deleted_owner_insert();

drop trigger if exists trg_telemetry_reject_deleted_owner_insert
  on public.telemetry_sessions;
create trigger trg_telemetry_reject_deleted_owner_insert
  before insert on public.telemetry_sessions
  for each row execute function public.bp_reject_deleted_telemetry_write();

drop trigger if exists trg_telemetry_reject_deleted_owner_ingest_update
  on public.telemetry_sessions;
create trigger trg_telemetry_reject_deleted_owner_ingest_update
  before update of write_count on public.telemetry_sessions
  for each row execute function public.bp_reject_deleted_telemetry_write();

-- ── 7. Review/ban serialization and re-entrant integrity scan ────────────────

-- A banned account cannot be made public one score at a time. Unban first, then
-- explicitly clear the desired scores.
create or replace function public.admin_clear_score(
  p_admin_id uuid,
  p_score_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_hint uuid;
  v_owner_id uuid;
  v_prev text;
  v_abuse_status text;
begin
  if not exists (
    select 1
      from public.member_accounts m
     where m.user_id = p_admin_id
       and m.is_admin = true
  ) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  select s.owner_id
    into v_owner_hint
    from public.scores s
   where s.id = p_score_id;
  if not found then
    raise exception 'score_not_found' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || v_owner_hint::text)::bigint
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('score:' || p_score_id::text)::bigint
  );

  select s.review_status, s.owner_id
    into v_prev, v_owner_id
    from public.scores s
   where s.id = p_score_id
   for update;
  if not found then
    raise exception 'score_not_found' using errcode = 'P0001';
  end if;
  if v_owner_id is distinct from v_owner_hint then
    raise exception 'score_owner_changed_retry' using errcode = '40001';
  end if;
  select m.abuse_status
    into v_abuse_status
    from public.member_accounts m
   where m.user_id = v_owner_id
   for key share;
  if found and v_abuse_status = 'banned' then
    raise exception 'member_banned' using errcode = 'P0001';
  end if;

  update public.scores
     set review_status = 'cleared'
   where id = p_score_id;
  insert into public.score_flags (
    score_id,
    status,
    action,
    reviewed_by,
    reviewed_at,
    reason
  )
  values (
    p_score_id,
    'cleared',
    'clear',
    p_admin_id,
    pg_catalog.now(),
    p_reason
  )
  on conflict (score_id) do update
    set status = 'cleared',
        action = 'clear',
        reviewed_by = p_admin_id,
        reviewed_at = pg_catalog.now(),
        reason = p_reason;
  insert into public.integrity_actions_ledger (
    admin_user_id,
    action_type,
    target_type,
    target_id,
    reason,
    meta
  )
  values (
    p_admin_id,
    'score_clear',
    'score',
    p_score_id,
    p_reason,
    pg_catalog.jsonb_build_object(
      'previous_status', v_prev,
      'next_status', 'cleared'
    )
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'previousStatus', v_prev,
    'nextStatus', 'cleared'
  );
end;
$$;

revoke all on function public.admin_clear_score(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_clear_score(uuid, uuid, text)
  to service_role;

-- Ban and every affected score/flag/badge now change in one transaction. The
-- member advisory lock is shared by submit/report/clear.
create or replace function public.admin_ban_member(
  p_admin_id uuid,
  p_member_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scores int := 0;
  v_badges int := 0;
begin
  if not exists (
    select 1
      from public.member_accounts m
     where m.user_id = p_admin_id
       and m.is_admin = true
  ) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || p_member_id::text)::bigint
  );

  update public.member_accounts
     set abuse_status = 'banned'
   where user_id = p_member_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  update public.scores
     set review_status = 'voided'
   where owner_id = p_member_id
     and review_status <> 'voided';
  get diagnostics v_scores = row_count;

  -- Never materialize every score id into one backend-memory uuid[]. The
  -- member advisory lock prevents a new score commit while this set-based
  -- owner/status scan streams through the flag upsert. Already-voided scores
  -- also receive the ban evidence, so score and flag visibility converge.
  insert into public.score_flags (
    score_id,
    signals,
    evidence,
    abuse_score,
    rules_version,
    status,
    action,
    reviewed_by,
    reviewed_at,
    reason
  )
  select s.id,
         '[{"id":"BANNED_MEMBER","value":null,"threshold":null,"source":"admin"}]'::jsonb,
         pg_catalog.jsonb_build_object('dbBanAction', true),
         3,
         '2026-07-anti-abuse-v6',
         'voided',
         'void',
         p_admin_id,
         pg_catalog.now(),
         p_reason
    from public.scores s
   where s.owner_id = p_member_id
     and s.review_status = 'voided'
  on conflict (score_id) do update
    set signals = case
          when exists (
            select 1
              from pg_catalog.jsonb_array_elements(score_flags.signals) e
             where e->>'id' = 'BANNED_MEMBER'
          )
          then score_flags.signals
          else score_flags.signals ||
            '[{"id":"BANNED_MEMBER","value":null,"threshold":null,"source":"admin"}]'::jsonb
        end,
        evidence = score_flags.evidence ||
          pg_catalog.jsonb_build_object('dbBanAction', true),
        abuse_score = greatest(score_flags.abuse_score, 3),
        status = 'voided',
        action = 'void',
        reviewed_by = p_admin_id,
        reviewed_at = pg_catalog.now(),
        reason = p_reason;

  delete from public.user_badges
   where owner_id = p_member_id;
  get diagnostics v_badges = row_count;

  insert into public.integrity_actions_ledger (
    admin_user_id,
    action_type,
    target_type,
    target_id,
    reason,
    meta
  )
  values (
    p_admin_id,
    'member_ban',
    'member',
    p_member_id,
    p_reason,
    pg_catalog.jsonb_build_object(
      'scores_voided', v_scores,
      'badges_removed', v_badges
    )
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'scoresVoided', v_scores,
    'badgesRemoved', v_badges
  );
end;
$$;

revoke all on function public.admin_ban_member(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_ban_member(uuid, uuid, text)
  to service_role;

-- The prior ON COMMIT DROP temp table survived until transaction end, so a
-- second call in one transaction failed with relation_exists. Explicit pg_temp
-- names plus drop/recreate make the function re-entrant and remove search_path
-- temp-table shadowing.
create or replace function public.integrity_scan_recent(
  p_hours int default 6,
  p_rules text default '2026-07-anti-abuse-v6'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scanned int := 0;
  v_flagged int := 0;
begin
  drop table if exists pg_temp._bp_iscan;
  create temporary table pg_temp._bp_iscan
  on commit drop
  as
  with cand as (
    select s.id,
           s.score,
           s.duration_ms,
           ts.score as tscore,
           ts.duration_ms as tdur,
           ts.suspicious,
           ts.apm,
           ts.end_reason as tend_reason
      from public.scores s
      join public.telemetry_sessions ts
        on ts.id = s.telemetry_session_id
     where s.review_status = 'registered'
       and s.created_at >
           pg_catalog.now() -
           pg_catalog.make_interval(
             hours => least(
               greatest(coalesce(p_hours, 6), 0),
               24 * 30
             )
           )
  ),
  scored as (
    select id,
           tend_reason in ('normal', 'time_limit', 'score_limit')
             as tel_complete,
           (
             coalesce(tscore, 0) > 0
             and score > 0
             and (score - tscore)::numeric /
                 greatest(score, 1) > 0.2
           ) as c1_raw,
           (
             coalesce(tscore, 0) > 0
             and coalesce(tdur, 0) > 0
             and pg_catalog.abs(duration_ms - tdur)::numeric /
                 greatest(tdur, 1) > 0.2
           ) as c1b_raw,
           (
             coalesce(apm, 0) > 1200
             and duration_ms >= 60000
           ) as c2,
           coalesce(suspicious, false) as c8,
           tscore,
           tdur,
           apm,
           suspicious
      from cand
  ),
  gated as (
    select id,
           tel_complete and c1_raw as c1,
           tel_complete and c1b_raw as c1b,
           c2,
           c8,
           tscore,
           tdur,
           apm,
           suspicious
      from scored
  )
  select id,
         (
           case when c1 then
             pg_catalog.jsonb_build_array(
               pg_catalog.jsonb_build_object(
                 'id', 'C1_SCORE_MISMATCH',
                 'value', tscore,
                 'source', 'cron'
               )
             )
           else '[]'::jsonb end
           ||
           case when c1b then
             pg_catalog.jsonb_build_array(
               pg_catalog.jsonb_build_object(
                 'id', 'C1B_DURATION_MISMATCH',
                 'value', tdur,
                 'source', 'cron'
               )
             )
           else '[]'::jsonb end
           ||
           case when c2 then
             pg_catalog.jsonb_build_array(
               pg_catalog.jsonb_build_object(
                 'id', 'C2_SESSION_APM',
                 'value', apm,
                 'threshold', 1200,
                 'source', 'cron'
               )
             )
           else '[]'::jsonb end
           ||
           case when c8 then
             pg_catalog.jsonb_build_array(
               pg_catalog.jsonb_build_object(
                 'id', 'C8_TELEMETRY_SUSPICIOUS',
                 'value', 1,
                 'source', 'cron'
               )
             )
           else '[]'::jsonb end
         ) as signals,
         (c1::int * 3 + c1b::int * 3 + c2::int + c8::int * 3)
           as abuse_score,
         false as applied
    from gated
   where c1 or c1b or c2 or c8;

  select pg_catalog.count(*)::int
    into v_scanned
    from public.scores s
   where s.review_status = 'registered'
     and s.created_at >
         pg_catalog.now() -
         pg_catalog.make_interval(
           hours => least(
             greatest(coalesce(p_hours, 6), 0),
             24 * 30
           )
         )
     and s.telemetry_session_id is not null;

  with changed as (
    update public.scores s
       set review_status = 'pending'
      from pg_temp._bp_iscan i
     where s.id = i.id
       and s.review_status = 'registered'
    returning s.id
  )
  update pg_temp._bp_iscan i
     set applied = true
    from changed c
   where i.id = c.id;

  delete from pg_temp._bp_iscan where not applied;
  select pg_catalog.count(*)::int
    into v_flagged
    from pg_temp._bp_iscan;

  insert into public.score_flags (
    score_id,
    signals,
    abuse_score,
    rules_version,
    status
  )
  select i.id,
         i.signals,
         i.abuse_score,
         coalesce(p_rules, '2026-07-anti-abuse-v6'),
         'pending'
    from pg_temp._bp_iscan i
  on conflict (score_id) do update
    set signals = excluded.signals,
        abuse_score = excluded.abuse_score,
        rules_version = excluded.rules_version,
        status = 'pending',
        action = null,
        reviewed_by = null,
        reviewed_at = null,
        reason = null;

  insert into public.integrity_actions_ledger (
    admin_user_id,
    action_type,
    target_type,
    target_id,
    reason,
    meta
  )
  select null,
         'cron_flag',
         'score',
         i.id,
         'cron integrity-scan',
         pg_catalog.jsonb_build_object(
           'next_status', 'pending',
           'rules_version',
           coalesce(p_rules, '2026-07-anti-abuse-v6')
         )
    from pg_temp._bp_iscan i;

  return pg_catalog.jsonb_build_object(
    'scanned', v_scanned,
    'flagged', v_flagged
  );
end;
$$;

revoke all on function public.integrity_scan_recent(int, text)
  from public, anon, authenticated, service_role;
grant execute on function public.integrity_scan_recent(int, text)
  to service_role;

-- ── 8. Postflight: exact ACL/shape checks, then atomic journal marker ─────────

do $$
declare
  v_role text;
  v_priv text;
begin
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.telemetry_sessions'::regclass
       and a.attname = 'submitter_binding'
       and a.attnum > 0
       and not a.attisdropped
  ) then
    raise exception '0074 postflight: submitter_binding missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.scores'::regclass
       and a.attname = 'submission_id'
       and a.attnum > 0
       and not a.attisdropped
  )
     or pg_catalog.to_regclass('public.uq_scores_origin_submission') is null
     or not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.scores'::regclass
          and a.attname = 'submission_fingerprint'
          and a.attnum > 0
          and not a.attisdropped
     )
     or not exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.scores'::regclass
          and a.attname = 'submission_origin_owner_id'
          and a.attnum > 0
          and not a.attisdropped
     )
  then
    raise exception
      '0074 postflight: score submission origin/key/fingerprint missing';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.scores'::regclass
       and c.conname = 'scores_telemetry_session_fk'
  ) then
    raise exception '0074 postflight: telemetry FK missing';
  end if;
  if pg_catalog.to_regclass('public.anon_data_reassignments') is null
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.reassign_anon_data(uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.reassign_anon_data(uuid,uuid)',
       'EXECUTE'
     )
  then
    raise exception '0074 postflight: anon reassignment fencing missing';
  end if;
  if exists (
    select 1
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.scores'::regclass
       and p.polcmd in ('a', '*')
  ) then
    raise exception '0074 postflight: scores INSERT policy remains';
  end if;
  if pg_catalog.has_function_privilege(
       'anon', 'public.get_leaderboard(text,integer)', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.get_score_percentile(integer)', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', 'public.get_leaderboard(text,integer)', 'EXECUTE'
     )
  then
    raise exception '0074 postflight: ranking RPC ACL drift';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    if v_role = 'service_role'
       and not pg_catalog.has_table_privilege(
         v_role, 'public.scores', 'SELECT'
       )
    then
      raise exception '0074 postflight: service scores SELECT missing';
    end if;
    if v_role <> 'service_role'
       and pg_catalog.has_table_privilege(
         v_role, 'public.scores', 'SELECT'
       )
    then
      raise exception '0074 postflight: % raw scores SELECT remains', v_role;
    end if;
    foreach v_priv in array array[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'
    ]
    loop
      if pg_catalog.has_table_privilege(
        v_role, 'public.scores', v_priv
      ) then
        raise exception
          '0074 postflight: % scores % privilege remains',
          v_role, v_priv;
      end if;
    end loop;
  end loop;

  if exists (
    select 1
      from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.table_name = 'scores'
       and g.grantee = 'PUBLIC'
  ) then
    raise exception '0074 postflight: PUBLIC scores privilege remains';
  end if;

  if exists (
    select 1
      from information_schema.role_column_grants g
     where g.table_schema = 'public'
       and g.table_name = 'scores'
       and g.grantee in (
         'PUBLIC', 'anon', 'authenticated', 'service_role'
       )
       and g.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
  ) then
    raise exception '0074 postflight: scores column DML privilege remains';
  end if;

  if exists (
    select expected.relname, expected.tgname
      from (
        values
          ('score_stats', 'trg_score_stats_reject_deleted_owner_insert'),
          ('user_badges', 'trg_user_badges_reject_deleted_owner_insert'),
          ('telemetry_sessions', 'trg_telemetry_reject_deleted_owner_insert'),
          (
            'telemetry_sessions',
            'trg_telemetry_reject_deleted_owner_ingest_update'
          )
      ) expected(relname, tgname)
     where not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid =
              pg_catalog.to_regclass('public.' || expected.relname)
          and t.tgname = expected.tgname
          and not t.tgisinternal
          and t.tgenabled <> 'D'
     )
  )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_score_report_insert()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bp_reject_deleted_telemetry_write()',
       'EXECUTE'
     )
  then
    raise exception '0074 postflight: deleted-owner report/telemetry fence missing';
  end if;

  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.integrity_scan_recent(integer,text)',
       'EXECUTE'
     )
  then
    raise exception '0074 postflight: service RPC grant missing';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.bp_telemetry_submitter_binding(uuid,uuid)',
       'EXECUTE'
     )
  then
    raise exception '0074 postflight: client RPC boundary open';
  end if;

  if not pg_catalog.has_table_privilege(
       'service_role', 'public.score_stats', 'INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.user_badges', 'INSERT,UPDATE,DELETE'
     )
  then
    raise exception '0074 postflight: rolling report DML compatibility missing';
  end if;

  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.integrity_scan_recent(integer,text)'::regprocedure
       ),
       'pg_temp._bp_iscan'
     ) = 0
  then
    raise exception '0074 postflight: integrity temp relation is not qualified';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version,
  migration_hash,
  manifest_hash,
  app_commit
)
values ('0074_score_submission_integrity', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
