-- 008903_bounded_asset_cleanup_sagas.sql
--
-- Replace the account-deletion and moderation-purge whole-history JSON
-- manifests with lossless, fixed-size Storage batches. Account cleanup also
-- drains generation PII in fixed-size tombstone batches while retaining only
-- anonymous financial/cost receipts.
--
-- Rolling order:
--   1. apply this expand migration while the old app is live; legacy claim
--      entry points become idle stubs, so already-durable jobs wait safely;
--   2. deploy the v2 workers;
--   3. drain old requests/workers and apply 0092, which removes the stubs.
--
-- Each v2 claim returns at most 100 deterministic Storage targets and at most
-- 100 deterministic generation receipts. A fenced finish re-reads
-- storage.objects, generation ownership, upload-intent state, and the full
-- signed-token horizon before it can mark a job completed. No LIMIT ever
-- discards a target: remaining rows simply produce another pending claim.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $$
begin
  if pg_catalog.to_regprocedure(
       'public.bp_0084_admin_soft_delete_account_impl(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
          'public.admin_begin_doll_purge(uuid,uuid,text)'
        ) is null
     or pg_catalog.to_regprocedure(
          'public.bp_user_mutation_lock(uuid)'
        ) is null
     or pg_catalog.to_regclass(
          'public.account_deletion_cleanup_jobs'
        ) is null
     or pg_catalog.to_regclass(
          'public.moderation_purge_jobs'
        ) is null
     or pg_catalog.to_regclass(
          'public.storage_upload_intents'
        ) is null
     or pg_catalog.to_regclass('public.ai_generations') is null
     or pg_catalog.to_regclass(
          'public.generation_preflight_reservations'
        ) is null
     or pg_catalog.to_regclass(
          'public.generation_face_check_intents'
        ) is null
     or pg_catalog.to_regclass(
          'public.generation_face_check_cost_attempts'
        ) is null
     or pg_catalog.to_regclass(
          'public.generation_submit_intents'
        ) is null
     or pg_catalog.to_regclass(
          'public.generation_pick_intents'
        ) is null
     or pg_catalog.to_regclass(
          'public.generation_pick_cost_attempts'
        ) is null
     or pg_catalog.to_regclass(
          'public.generation_cost_reconciliation_issues'
        ) is null
     or pg_catalog.to_regclass('storage.objects') is null then
    raise exception '008903 preflight: cleanup authority missing';
  end if;
end;
$$;

-- ── 1. Bounded lease state ─────────────────────────────────────────────────

alter table public.account_deletion_cleanup_jobs
  add column if not exists lease_version integer not null default 0,
  add column if not exists lease_targets jsonb not null default '[]'::jsonb,
  add column if not exists lease_generation_ids jsonb not null
    default '[]'::jsonb,
  add column if not exists removed_target_count bigint not null default 0,
  add column if not exists scrubbed_generation_count bigint not null
    default 0;

alter table public.account_deletion_cleanup_jobs
  drop constraint if exists account_deletion_cleanup_lease_targets_check,
  add constraint account_deletion_cleanup_lease_targets_check check (
    pg_catalog.jsonb_typeof(lease_targets) = 'array'
    and pg_catalog.jsonb_array_length(lease_targets) <= 100
    and (status = 'leased' or lease_targets = '[]'::jsonb)
  ),
  drop constraint if exists
    account_deletion_cleanup_lease_generation_ids_check,
  add constraint account_deletion_cleanup_lease_generation_ids_check check (
    pg_catalog.jsonb_typeof(lease_generation_ids) = 'array'
    and pg_catalog.jsonb_array_length(lease_generation_ids) <= 100
    and (
      status = 'leased'
      or lease_generation_ids = '[]'::jsonb
    )
  ),
  drop constraint if exists account_deletion_cleanup_lease_version_check,
  add constraint account_deletion_cleanup_lease_version_check check (
    lease_version >= 0
    and removed_target_count >= 0
    and scrubbed_generation_count >= 0
  );

-- Generation receipts remain as financial/audit tombstones, but no
-- account-identifying or provider/input/artifact payload may survive terminal
-- account cleanup. MATCH SIMPLE keeps the existing composite lot-owner FK
-- authoritative before scrub; the single-column FK preserves lot existence
-- after owner_id becomes NULL.
alter table public.ai_generations
  alter column owner_id drop not null,
  add column if not exists privacy_scrubbed_at timestamptz;
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.ai_generations'::regclass
       and c.conname = 'ai_generations_credit_lot_fkey'
  ) then
    alter table public.ai_generations
      add constraint ai_generations_credit_lot_fkey
      foreign key (credit_lot_id)
      references public.credit_lots(id);
  end if;
end;
$$;
alter table public.ai_generations
  drop constraint if exists ai_generations_privacy_scrub_shape,
  add constraint ai_generations_privacy_scrub_shape check (
    (
      privacy_scrubbed_at is null
      and owner_id is not null
    )
    or
    (
      privacy_scrubbed_at is not null
      and owner_id is null
      and fal_request_id is null
      and candidate_urls = '[]'::jsonb
      and picked_doll_id is null
      and fal_request_ids is null
      and fail_reason is null
      and picked_index is null
      and gen_params is null
      and not cost_preflight_pending
    )
  );

alter table public.generation_preflight_reservations
  alter column owner_id drop not null,
  add column if not exists privacy_scrubbed_at timestamptz;
alter table public.generation_face_check_intents
  add column if not exists privacy_scrubbed_at timestamptz;
alter table public.generation_face_check_cost_attempts
  add column if not exists privacy_scrubbed_at timestamptz;
alter table public.generation_submit_intents
  alter column owner_id drop not null,
  add column if not exists privacy_scrubbed_at timestamptz;
alter table public.generation_pick_intents
  alter column owner_id drop not null,
  add column if not exists privacy_scrubbed_at timestamptz;
alter table public.generation_pick_cost_attempts
  alter column owner_id drop not null,
  add column if not exists privacy_scrubbed_at timestamptz;
alter table public.generation_cost_reconciliation_issues
  alter column owner_id drop not null,
  add column if not exists privacy_scrubbed_at timestamptz;

-- Every unsanitized generation child must belong to the same account as its
-- parent. Without these composite references, a constraint-valid mismatched
-- child could escape an owner-based cleanup scan forever. MATCH SIMPLE makes
-- the reference intentionally dormant only after the child's owner is NULL
-- in the privacy tombstone.
alter table public.generation_preflight_reservations
  drop constraint if exists
    generation_preflight_generation_owner_fkey;
alter table public.generation_submit_intents
  drop constraint if exists generation_submit_generation_owner_fkey;
alter table public.generation_pick_intents
  drop constraint if exists generation_pick_generation_owner_fkey;
alter table public.generation_pick_cost_attempts
  drop constraint if exists generation_pick_cost_generation_owner_fkey;
alter table public.generation_cost_reconciliation_issues
  drop constraint if exists
    generation_reconciliation_generation_owner_fkey;
alter table public.ai_generations
  drop constraint if exists ai_generations_id_owner_key,
  add constraint ai_generations_id_owner_key unique (id, owner_id);
alter table public.generation_preflight_reservations
  add constraint generation_preflight_generation_owner_fkey
  foreign key (generation_id, owner_id)
  references public.ai_generations(id, owner_id);
alter table public.generation_submit_intents
  add constraint generation_submit_generation_owner_fkey
  foreign key (generation_id, owner_id)
  references public.ai_generations(id, owner_id);
alter table public.generation_pick_intents
  add constraint generation_pick_generation_owner_fkey
  foreign key (generation_id, owner_id)
  references public.ai_generations(id, owner_id);
alter table public.generation_pick_cost_attempts
  add constraint generation_pick_cost_generation_owner_fkey
  foreign key (generation_id, owner_id)
  references public.ai_generations(id, owner_id);
alter table public.generation_cost_reconciliation_issues
  add constraint generation_reconciliation_generation_owner_fkey
  foreign key (generation_id, owner_id)
  references public.ai_generations(id, owner_id);

alter table public.generation_cost_reconciliation_issues
  drop constraint if exists generation_cost_reconciliation_identity,
  add constraint generation_cost_reconciliation_identity check (
    (
      privacy_scrubbed_at is not null
      and owner_id is null
      and generation_id is null
      and reservation_id is null
      and candidate_index is null
    )
    or
    (
      privacy_scrubbed_at is null
      and (
        (
          issue_kind = 'face_submit'
          and reservation_id is not null
          and generation_id is not null
          and candidate_index is null
        )
        or
        (
          issue_kind = 'flux_submit'
          and reservation_id is null
          and generation_id is not null
          and candidate_index is not null
        )
        or
        (
          issue_kind in ('pick_submit', 'pick_materialization')
          and reservation_id is null
          and generation_id is not null
          and candidate_index is not null
        )
      )
    )
  );

alter table public.generation_preflight_reservations
  drop constraint if exists generation_preflight_privacy_scrub_shape,
  add constraint generation_preflight_privacy_scrub_shape check (
    privacy_scrubbed_at is null
    or (
      owner_id is null
      and image_digest = pg_catalog.repeat('0', 64)
      and analysis_result is null
      and analysis_lease_token is null
      and analysis_leased_until is null
      and generation_config is null
      and generation_plan is null
      and config_source is null
      and config_version is null
      and config_invalid is null
      and continuation_state = 'pending'
      and continuation_lease_token is null
      and continuation_leased_until is null
    )
  );
alter table public.generation_face_check_intents
  drop constraint if exists generation_face_check_privacy_scrub_shape,
  add constraint generation_face_check_privacy_scrub_shape check (
    privacy_scrubbed_at is null
    or (
      state = 'rejected'
      and input_payload = '{}'::jsonb
      and payload_hash = pg_catalog.repeat('0', 64)
      and callback_token_hash = pg_catalog.repeat('0', 64)
      and external_request_id is null
      and http_status is null
      and raw_output is null
    )
  );
alter table public.generation_face_check_cost_attempts
  drop constraint if exists generation_face_cost_privacy_scrub_shape,
  add constraint generation_face_cost_privacy_scrub_shape check (
    privacy_scrubbed_at is null
    or payload_hash = pg_catalog.repeat('0', 64)
  );
alter table public.generation_submit_intents
  drop constraint if exists generation_submit_privacy_scrub_shape,
  add constraint generation_submit_privacy_scrub_shape check (
    privacy_scrubbed_at is null
    or (
      owner_id is null
      and state = 'rejected'
      and input_payload is null
      and provider_output is null
      and request_id is null
      and conflict_request_id is null
      and http_status is null
      and webhook_status is null
    )
  );
alter table public.generation_pick_intents
  drop constraint if exists generation_pick_privacy_scrub_shape,
  add constraint generation_pick_privacy_scrub_shape check (
    privacy_scrubbed_at is null
    or (
      owner_id is null
      and state = 'expired'
      and input_payload is null
      and payload_hash is null
      and callback_token_hash is null
      and external_request_id is null
      and provider_result_url is null
      and rejection_status is null
      and external_started_at is null
      and provider_done_at is null
      and materialization_lease_token is null
      and materialization_leased_until is null
      and committed_at is null
    )
  );
alter table public.generation_pick_cost_attempts
  drop constraint if exists generation_pick_cost_privacy_scrub_shape,
  add constraint generation_pick_cost_privacy_scrub_shape check (
    privacy_scrubbed_at is null or owner_id is null
  );
alter table public.generation_cost_reconciliation_issues
  drop constraint if exists
    generation_cost_reconciliation_privacy_scrub_shape,
  add constraint generation_cost_reconciliation_privacy_scrub_shape check (
    privacy_scrubbed_at is null
    or (
      owner_id is null
      and generation_id is null
      and reservation_id is null
      and candidate_index is null
      and external_request_id is null
      and payload_hash = pg_catalog.repeat('0', 64)
      and object_key =
            'privacy:' || pg_catalog.replace(id::text, '-', '')
    )
  );

alter table public.moderation_purge_jobs
  add column if not exists final_sweep_after timestamptz,
  add column if not exists purged_target_count bigint not null default 0;
update public.moderation_purge_jobs
   set final_sweep_after = greatest(
         coalesce(final_sweep_after, created_at + interval '2 hours 5 minutes'),
         created_at + interval '2 hours 5 minutes'
       )
 where final_sweep_after is null
    or final_sweep_after < created_at + interval '2 hours 5 minutes';
alter table public.moderation_purge_jobs
  alter column final_sweep_after set not null,
  alter column final_sweep_after set default (
    pg_catalog.clock_timestamp() + interval '2 hours 5 minutes'
  ),
  drop constraint if exists moderation_purge_bounded_manifest_check,
  add constraint moderation_purge_bounded_manifest_check check (
    pg_catalog.jsonb_typeof(manifest) = 'array'
    and pg_catalog.jsonb_array_length(manifest) <= 100
    and (status = 'leased' or manifest = '[]'::jsonb)
    and purged_target_count >= 0
  );

-- Invalidate any old whole-manifest lease. The new selectors derive every
-- target from retained DB ownership plus storage.objects, so scrubbing these
-- payloads loses no deletion authority.
update public.account_deletion_cleanup_jobs
   set status = 'pending',
       manifest = pg_catalog.jsonb_build_object(
         'dolls', '[]'::jsonb,
         'highlights', '[]'::jsonb,
         'avatar', null
       ),
       lease_targets = '[]'::jsonb,
       lease_generation_ids = '[]'::jsonb,
       lease_token = null,
       leased_until = null,
       next_attempt_at = pg_catalog.clock_timestamp(),
       updated_at = pg_catalog.clock_timestamp()
 where status in ('pending', 'leased');

update public.moderation_purge_jobs
   set status = 'pending',
       manifest = '[]'::jsonb,
       lease_token = null,
       leased_until = null,
       next_attempt_at = pg_catalog.clock_timestamp(),
       updated_at = pg_catalog.clock_timestamp()
 where status in ('pending', 'leased');

create index if not exists storage_upload_intents_owner_cleanup_idx
  on public.storage_upload_intents(
    owner_user_id, purpose, status,
    coalesce(last_token_horizon, expires_at)
  );
create index if not exists storage_upload_intents_subject_cleanup_idx
  on public.storage_upload_intents(
    subject_id, purpose, status,
    coalesce(last_token_horizon, expires_at)
  );
create index if not exists ai_generations_owner_privacy_cleanup_idx
  on public.ai_generations(owner_id, created_at, id)
  where privacy_scrubbed_at is null;
create index if not exists generation_preflight_generation_cleanup_idx
  on public.generation_preflight_reservations(generation_id)
  where privacy_scrubbed_at is null;
create index if not exists generation_preflight_generation_owner_fk_idx
  on public.generation_preflight_reservations(generation_id, owner_id);
create index if not exists generation_pick_cost_generation_cleanup_idx
  on public.generation_pick_cost_attempts(generation_id)
  where privacy_scrubbed_at is null;
create index if not exists generation_pick_cost_generation_owner_fk_idx
  on public.generation_pick_cost_attempts(generation_id, owner_id);
create index if not exists generation_reconciliation_generation_cleanup_idx
  on public.generation_cost_reconciliation_issues(
    generation_id, status
  );
create index if not exists generation_reconciliation_reservation_cleanup_idx
  on public.generation_cost_reconciliation_issues(
    reservation_id, status
  );

-- ── 2. DB-authoritative bounded target/intents helpers ─────────────────────

create or replace function public.bp_account_cleanup_targets(
  p_user_id uuid,
  p_limit integer
)
returns table(bucket text, path text)
language sql
stable
security definer
set search_path = ''
rows 100
as $$
  select o.bucket_id::text, o.name::text
    from storage.objects o
   where (
     o.bucket_id = 'dolls'
     and (
       o.name like p_user_id::text || '/%'
       or o.name like 'tmp/face/' || p_user_id::text || '/%'
     )
   )
   or (
     o.bucket_id = 'avatars'
     and o.name like p_user_id::text || '/%'
   )
   or (
     o.bucket_id = 'highlights'
     and exists (
       select 1
         from public.scores s
        where s.owner_id = p_user_id
          and s.id::text = pg_catalog.split_part(o.name, '/', 1)
     )
   )
   order by o.bucket_id, o.name, o.id
   limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;
revoke all on function public.bp_account_cleanup_targets(uuid, integer)
  from public, anon, authenticated, service_role;

create or replace function public.bp_account_cleanup_generation_targets(
  p_user_id uuid,
  p_limit integer
)
returns table(generation_id uuid)
language sql
stable
security definer
set search_path = ''
rows 100
as $$
  select g.id
    from public.ai_generations g
   where g.owner_id = p_user_id
     and g.privacy_scrubbed_at is null
   order by g.created_at, g.id
   limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;
revoke all on function
  public.bp_account_cleanup_generation_targets(uuid, integer)
  from public, anon, authenticated, service_role;

create or replace function
  public.bp_account_cleanup_has_open_generation_reconciliation(
    p_user_id uuid
  )
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.generation_cost_reconciliation_issues q
     where q.status = 'open'
       and (
         exists (
           select 1
             from public.ai_generations g
            where g.id = q.generation_id
              and g.owner_id = p_user_id
              and g.privacy_scrubbed_at is null
         )
         or exists (
           select 1
             from public.generation_preflight_reservations r
            where r.id = q.reservation_id
              and r.owner_id = p_user_id
              and r.privacy_scrubbed_at is null
         )
       )
  );
$$;
revoke all on function
  public.bp_account_cleanup_has_open_generation_reconciliation(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_moderation_cleanup_targets(
  p_doll_id uuid,
  p_limit integer
)
returns table(bucket text, path text)
language sql
stable
security definer
set search_path = ''
rows 100
as $$
  select o.bucket_id::text, o.name::text
    from public.dolls d
    join storage.objects o on (
      (
        o.bucket_id = 'dolls'
        and o.name = d.owner_id::text || '/' || d.id::text || '.png'
      )
      or (
        o.bucket_id = 'highlights'
        and exists (
          select 1
            from public.scores s
           where s.doll_id = d.id
             and s.id::text = pg_catalog.split_part(o.name, '/', 1)
        )
      )
    )
   where d.id = p_doll_id
   order by o.bucket_id, o.name, o.id
   limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;
revoke all on function public.bp_moderation_cleanup_targets(uuid, integer)
  from public, anon, authenticated, service_role;

create or replace function public.bp_account_cleanup_intent_horizon(
  p_user_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.max(
           coalesce(i.last_token_horizon, i.expires_at)
         )
    from public.storage_upload_intents i
   where i.owner_user_id = p_user_id
     and i.purpose in (
       'avatar_upload', 'highlight_upload', 'doll_upload'
     );
$$;
revoke all on function public.bp_account_cleanup_intent_horizon(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_account_cleanup_has_open_intent(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.storage_upload_intents i
     where i.owner_user_id = p_user_id
       and i.purpose in (
         'avatar_upload', 'highlight_upload', 'doll_upload'
       )
       and i.status in ('issued', 'confirmed', 'pending', 'leased')
  );
$$;
revoke all on function public.bp_account_cleanup_has_open_intent(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_moderation_cleanup_intent_horizon(
  p_doll_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.max(
           coalesce(i.last_token_horizon, i.expires_at)
         )
    from public.storage_upload_intents i
   where (
     i.purpose = 'doll_upload'
     and i.subject_id = p_doll_id
   )
   or (
     i.purpose = 'highlight_upload'
     and exists (
       select 1
         from public.scores s
        where s.doll_id = p_doll_id
          and s.id = i.subject_id
     )
   );
$$;
revoke all on function public.bp_moderation_cleanup_intent_horizon(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_moderation_cleanup_has_open_intent(
  p_doll_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.storage_upload_intents i
     where i.status in ('issued', 'confirmed', 'pending', 'leased')
       and (
         (
           i.purpose = 'doll_upload'
           and i.subject_id = p_doll_id
         )
         or (
           i.purpose = 'highlight_upload'
           and exists (
             select 1
               from public.scores s
              where s.doll_id = p_doll_id
                and s.id = i.subject_id
           )
         )
       )
  );
$$;
revoke all on function public.bp_moderation_cleanup_has_open_intent(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.bp_scrub_account_generation_batch(
  p_user_id uuid,
  p_generation_ids jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_batch_size integer;
  v_distinct_size integer;
  v_locked_size integer := 0;
  v_scrubbed integer;
  v_generation_id uuid;
begin
  if pg_catalog.jsonb_typeof(p_generation_ids) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_generation_ids) > 100 then
    raise exception 'cleanup_generation_batch_invalid'
      using errcode = 'P0001';
  end if;
  v_batch_size := pg_catalog.jsonb_array_length(p_generation_ids);
  select pg_catalog.count(distinct value)::integer
    into v_distinct_size
    from pg_catalog.jsonb_array_elements_text(p_generation_ids);
  if v_distinct_size <> v_batch_size then
    raise exception 'cleanup_generation_batch_invalid'
      using errcode = 'P0001';
  end if;

  for v_generation_id in
    select g.id
      from public.ai_generations g
     where g.id in (
       select value::uuid
         from pg_catalog.jsonb_array_elements_text(p_generation_ids)
     )
       and g.owner_id = p_user_id
       and g.privacy_scrubbed_at is null
     order by g.id
     for update
  loop
    v_locked_size := v_locked_size + 1;
  end loop;
  if v_locked_size <> v_batch_size then
    raise exception 'cleanup_generation_target_changed'
      using errcode = 'P0001';
  end if;
  update public.generation_cost_reconciliation_issues q
     set owner_id = null,
         generation_id = null,
         reservation_id = null,
         candidate_index = null,
         object_key =
           'privacy:' ||
           pg_catalog.replace(q.id::text, '-', ''),
         payload_hash = pg_catalog.repeat('0', 64),
         external_request_id = null,
         resolution_note =
           case
             when q.status = 'resolved' then 'account_deleted'
             else null
           end,
         privacy_scrubbed_at = coalesce(q.privacy_scrubbed_at, v_now),
         last_seen_at = greatest(q.last_seen_at, v_now)
   where (
       q.generation_id in (
         select value::uuid
           from pg_catalog.jsonb_array_elements_text(p_generation_ids)
       )
       or q.reservation_id in (
         select r.id
           from public.generation_preflight_reservations r
          where r.generation_id in (
            select value::uuid
              from pg_catalog.jsonb_array_elements_text(p_generation_ids)
          )
       )
     );

  update public.generation_face_check_cost_attempts a
     set payload_hash = pg_catalog.repeat('0', 64),
         privacy_scrubbed_at = coalesce(a.privacy_scrubbed_at, v_now)
    from public.generation_preflight_reservations r
   where a.reservation_id = r.id
     and r.generation_id in (
       select value::uuid
         from pg_catalog.jsonb_array_elements_text(p_generation_ids)
     );
  update public.generation_face_check_intents i
     set state = 'rejected',
         input_payload = '{}'::jsonb,
         payload_hash = pg_catalog.repeat('0', 64),
         callback_token_hash = pg_catalog.repeat('0', 64),
         external_request_id = null,
         http_status = null,
         raw_output = null,
         claimed_at = coalesce(i.claimed_at, i.created_at),
         completed_at = coalesce(i.completed_at, v_now),
         privacy_scrubbed_at = coalesce(i.privacy_scrubbed_at, v_now),
         updated_at = v_now
    from public.generation_preflight_reservations r
   where i.reservation_id = r.id
     and r.generation_id in (
       select value::uuid
         from pg_catalog.jsonb_array_elements_text(p_generation_ids)
     );
  update public.generation_preflight_reservations r
     set owner_id = null,
         image_digest = pg_catalog.repeat('0', 64),
         state = 'expired',
         analysis_result = null,
         terminal_reason = 'account_deleted',
         analysis_lease_token = null,
         analysis_leased_until = null,
         generation_config = null,
         generation_plan = null,
         config_source = null,
         config_version = null,
         config_invalid = null,
         expires_at = least(r.expires_at, v_now),
         finalized_at = coalesce(r.finalized_at, v_now),
         continuation_state = 'pending',
         continuation_lease_token = null,
         continuation_leased_until = null,
         privacy_scrubbed_at = coalesce(r.privacy_scrubbed_at, v_now),
         updated_at = v_now
   where r.generation_id in (
     select value::uuid
       from pg_catalog.jsonb_array_elements_text(p_generation_ids)
   );

  update public.generation_submit_intents i
     set owner_id = null,
         payload_hash = pg_catalog.repeat('0', 64),
         callback_token_hash = pg_catalog.encode(
           extensions.digest(
             'account-deleted:' || i.generation_id::text || ':' ||
               i.candidate_index::text,
             'sha256'
           ),
           'hex'
         ),
         state = 'rejected',
         attempt_count = 1,
         request_id = null,
         conflict_request_id = null,
         http_status = null,
         webhook_status = null,
         submit_started_at = coalesce(i.submit_started_at, i.created_at),
         acknowledged_at = null,
         last_webhook_at = null,
         input_payload = null,
         provider_output = null,
         provider_output_at = null,
         provider_output_scrubbed_at =
           coalesce(i.provider_output_scrubbed_at, v_now),
         privacy_scrubbed_at = coalesce(i.privacy_scrubbed_at, v_now),
         updated_at = v_now
   where i.generation_id in (
     select value::uuid
       from pg_catalog.jsonb_array_elements_text(p_generation_ids)
   );

  update public.generation_pick_cost_attempts a
     set owner_id = null,
         privacy_scrubbed_at = coalesce(a.privacy_scrubbed_at, v_now)
   where a.generation_id in (
     select value::uuid
       from pg_catalog.jsonb_array_elements_text(p_generation_ids)
   );
  update public.generation_pick_intents i
     set owner_id = null,
         state = 'expired',
         input_payload = null,
         payload_hash = null,
         callback_token_hash = null,
         external_request_id = null,
         provider_result_url = null,
         rejection_status = null,
         expires_at = least(i.expires_at, v_now),
         external_started_at = null,
         provider_done_at = null,
         materialization_lease_token = null,
         materialization_leased_until = null,
         committed_at = null,
         privacy_scrubbed_at = coalesce(i.privacy_scrubbed_at, v_now),
         updated_at = v_now
   where i.generation_id in (
     select value::uuid
       from pg_catalog.jsonb_array_elements_text(p_generation_ids)
   );

  delete from public.generation_artifact_write_leases l
   where l.generation_id in (
     select value::uuid
       from pg_catalog.jsonb_array_elements_text(p_generation_ids)
   );

  update public.ai_generations g
     set owner_id = null,
         fal_request_id = null,
         candidate_urls = '[]'::jsonb,
         picked_doll_id = null,
         fal_request_ids = null,
         fail_reason = null,
         picked_index = null,
         gen_params = null,
         artifacts_cleaned_at = coalesce(g.artifacts_cleaned_at, v_now),
         cost_preflight_pending = false,
         privacy_scrubbed_at = coalesce(g.privacy_scrubbed_at, v_now),
         updated_at = v_now
   where g.id in (
     select value::uuid
       from pg_catalog.jsonb_array_elements_text(p_generation_ids)
   )
     and g.owner_id = p_user_id
     and g.privacy_scrubbed_at is null;
  get diagnostics v_scrubbed = row_count;
  if v_scrubbed <> v_batch_size then
    raise exception 'cleanup_generation_target_changed'
      using errcode = 'P0001';
  end if;
  return v_scrubbed;
exception
  when invalid_text_representation then
    raise exception 'cleanup_generation_batch_invalid'
      using errcode = 'P0001';
end;
$$;
revoke all on function
  public.bp_scrub_account_generation_batch(uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.bp_fence_ai_generation_privacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.privacy_scrubbed_at is not null
     and (
       new.privacy_scrubbed_at is distinct from old.privacy_scrubbed_at
       or new.owner_id is not null
       or new.fal_request_id is not null
       or new.candidate_urls <> '[]'::jsonb
       or new.picked_doll_id is not null
       or new.fal_request_ids is not null
       or new.fail_reason is not null
       or new.picked_index is not null
       or new.gen_params is not null
       or new.cost_preflight_pending
     ) then
    raise exception 'generation_privacy_scrubbed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.bp_fence_ai_generation_privacy()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_ai_generations_fence_privacy_scrub
  on public.ai_generations;
create trigger trg_ai_generations_fence_privacy_scrub
  before update on public.ai_generations
  for each row execute function public.bp_fence_ai_generation_privacy();

create or replace function
  public.bp_reject_scrubbed_generation_child_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scrubbed_at timestamptz;
begin
  select g.privacy_scrubbed_at
    into v_scrubbed_at
    from public.ai_generations g
   where g.id = new.generation_id
   for key share;
  if not found or v_scrubbed_at is not null then
    raise exception 'generation_privacy_scrubbed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function
  public.bp_reject_scrubbed_generation_child_write()
  from public, anon, authenticated, service_role;
do $$
declare
  v_table regclass;
  v_name text;
begin
  for v_table, v_name in
    select *
      from (
        values
          (
            'public.generation_preflight_reservations'::regclass,
            'trg_generation_preflight_fence_privacy'
          ),
          (
            'public.generation_submit_intents'::regclass,
            'trg_generation_submit_fence_privacy'
          ),
          (
            'public.generation_pick_intents'::regclass,
            'trg_generation_pick_fence_privacy'
          ),
          (
            'public.generation_pick_cost_attempts'::regclass,
            'trg_generation_pick_cost_fence_privacy'
          )
      ) target(table_oid, trigger_name)
  loop
    execute pg_catalog.format(
      'drop trigger if exists %I on %s',
      v_name,
      v_table
    );
    execute pg_catalog.format(
      'create trigger %I before insert or update on %s ' ||
      'for each row execute function ' ||
      'public.bp_reject_scrubbed_generation_child_write()',
      v_name,
      v_table
    );
  end loop;
end;
$$;

create or replace function
  public.bp_fence_generation_reconciliation_privacy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scrubbed_at timestamptz;
  v_generation_id uuid := new.generation_id;
begin
  if tg_op = 'UPDATE' and old.privacy_scrubbed_at is not null then
    if new.privacy_scrubbed_at is distinct from old.privacy_scrubbed_at
       or new.owner_id is not null
       or new.generation_id is not null
       or new.reservation_id is not null
       or new.candidate_index is not null
       or new.object_key is distinct from old.object_key
       or new.payload_hash is distinct from old.payload_hash
       or new.external_request_id is not null
       or not (
         new.status = old.status
         or (old.status = 'open' and new.status = 'resolved')
       ) then
      raise exception 'generation_privacy_scrubbed'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if v_generation_id is null and tg_op = 'UPDATE' then
    v_generation_id := old.generation_id;
  end if;
  select g.privacy_scrubbed_at
    into v_scrubbed_at
    from public.ai_generations g
   where g.id = v_generation_id
   for key share;
  if not found or v_scrubbed_at is not null then
    raise exception 'generation_privacy_scrubbed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function
  public.bp_fence_generation_reconciliation_privacy()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_generation_reconciliation_fence_privacy
  on public.generation_cost_reconciliation_issues;
create trigger trg_generation_reconciliation_fence_privacy
  before insert or update
  on public.generation_cost_reconciliation_issues
  for each row execute function
    public.bp_fence_generation_reconciliation_privacy();

create or replace function
  public.bp_reject_scrubbed_reservation_child_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scrubbed_at timestamptz;
begin
  select r.privacy_scrubbed_at
    into v_scrubbed_at
    from public.generation_preflight_reservations r
   where r.id = new.reservation_id
   for key share;
  if not found or v_scrubbed_at is not null then
    raise exception 'generation_privacy_scrubbed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function
  public.bp_reject_scrubbed_reservation_child_write()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_generation_face_intent_fence_privacy
  on public.generation_face_check_intents;
create trigger trg_generation_face_intent_fence_privacy
  before insert or update on public.generation_face_check_intents
  for each row execute function
    public.bp_reject_scrubbed_reservation_child_write();
drop trigger if exists trg_generation_face_cost_fence_privacy
  on public.generation_face_check_cost_attempts;
create trigger trg_generation_face_cost_fence_privacy
  before insert or update on public.generation_face_check_cost_attempts
  for each row execute function
    public.bp_reject_scrubbed_reservation_child_write();

create or replace function
  public.bp_credit_ledger_scrubbed_generation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scrubbed_at timestamptz;
  v_lot_id uuid;
  v_owner_id uuid;
begin
  if new.ref_gen_id is null then
    return new;
  end if;
  select g.privacy_scrubbed_at, g.credit_lot_id
    into v_scrubbed_at, v_lot_id
    from public.ai_generations g
   where g.id = new.ref_gen_id
   for key share;
  if v_scrubbed_at is null then
    return new;
  end if;
  if v_lot_id is null then
    raise exception 'credit_ledger_scrubbed_generation_owner_unknown'
      using errcode = 'P0001';
  end if;
  select l.user_id
    into v_owner_id
    from public.credit_lots l
   where l.id = v_lot_id;
  if v_owner_id is distinct from new.user_id then
    raise exception 'credit_ledger_owner_mismatch'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function
  public.bp_credit_ledger_scrubbed_generation_guard()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_credit_ledger_scrubbed_generation_guard
  on public.credit_ledger;
create trigger trg_credit_ledger_scrubbed_generation_guard
  before insert on public.credit_ledger
  for each row execute function
    public.bp_credit_ledger_scrubbed_generation_guard();

create or replace function public.bp_account_cleanup_auth_is_scrubbed(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.users u
     where u.id = p_user_id
       and pg_catalog.lower(pg_catalog.btrim(u.email)) =
             pg_catalog.lower(
               'deleted+' || p_user_id::text || '@deleted.invalid'
             )
       and coalesce(u.raw_user_meta_data, '{}'::jsonb) = '{}'::jsonb
  );
$$;
revoke all on function public.bp_account_cleanup_auth_is_scrubbed(uuid)
  from public, anon, authenticated, service_role;

create or replace function
  public.arm_account_deletion_cleanup_auth_fence(
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
  v_job public.account_deletion_cleanup_jobs%rowtype;
  v_auth_meta jsonb;
begin
  if p_user_id is not null then
    perform public.bp_user_mutation_lock(p_user_id);
  end if;
  perform 1
    from public.profiles p
   where p.id = p_user_id
     and p.deleted_at is not null
   for update;
  if not found then
    raise exception 'cleanup_state_conflict' using errcode = 'P0001';
  end if;

  select *
    into v_job
    from public.account_deletion_cleanup_jobs j
   where j.id = p_job_id
     and j.user_id = p_user_id
     and j.status = 'leased'
     and j.lease_token = p_lease_token
     and j.lease_version = p_lease_version
     and j.leased_until > pg_catalog.clock_timestamp()
   for update;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;
  if v_job.lease_targets <> '[]'::jsonb
     or v_job.lease_generation_ids <> '[]'::jsonb
     or pg_catalog.clock_timestamp() < v_job.final_sweep_after
     or public.bp_account_cleanup_has_open_intent(v_job.user_id)
     or public.bp_account_cleanup_has_open_generation_reconciliation(
          v_job.user_id
        )
     or exists (
       select 1
         from public.bp_account_cleanup_targets(v_job.user_id, 1)
     )
     or exists (
       select 1
         from public.bp_account_cleanup_generation_targets(
           v_job.user_id,
           1
         )
     ) then
    raise exception 'cleanup_auth_not_ready' using errcode = 'P0001';
  end if;

  select u.raw_app_meta_data
    into v_auth_meta
    from auth.users u
   where u.id = v_job.user_id
   for update;
  if not found
     or pg_catalog.jsonb_typeof(coalesce(v_auth_meta, '{}'::jsonb))
          is distinct from 'object' then
    raise exception 'cleanup_auth_identity_invalid'
      using errcode = 'P0001';
  end if;

  update auth.users u
     set raw_app_meta_data =
           coalesce(u.raw_app_meta_data, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
                'bp_account_cleanup_fence',
                pg_catalog.jsonb_build_object(
                  'job_id', v_job.id,
                  'user_id', v_job.user_id,
                  'lease_token', v_job.lease_token,
                  'lease_version', v_job.lease_version,
                  'action', 'scrub'
                )
              ),
         updated_at = pg_catalog.clock_timestamp()
   where u.id = v_job.user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'action', 'scrub'
  );
end;
$$;
revoke all on function
  public.arm_account_deletion_cleanup_auth_fence(
    uuid, uuid, uuid, integer
  ) from public, anon, authenticated, service_role;
grant execute on function
  public.arm_account_deletion_cleanup_auth_fence(
    uuid, uuid, uuid, integer
  ) to service_role;

-- GoTrue updates auth.users in its own transaction after the worker RPC.
-- Revalidate the exact still-live cleanup lease at that final side-effect
-- boundary. A paused expired worker therefore cannot scrub an account after
-- a newer worker completed and the user was reactivated.
create or replace function
  public.bp_fence_account_deletion_auth_scrub()
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
      -> 'bp_account_cleanup_fence';
  v_reactivation_fence jsonb :=
    coalesce(new.raw_app_meta_data, '{}'::jsonb)
      -> 'bp_reactivation_fence';
begin
  if v_new_email is distinct from v_marker
     or v_old_email = v_marker then
    return new;
  end if;

  -- The reactivation cancellation trigger validates this branch in full.
  if v_reactivation_fence->>'action' = 'cancel' then
    return new;
  end if;

  if pg_catalog.jsonb_typeof(v_fence) is distinct from 'object'
     or coalesce(v_fence->>'action', '') <> 'scrub'
     or coalesce(v_fence->>'job_id', '') = ''
     or coalesce(v_fence->>'user_id', '') <> old.id::text
     or coalesce(v_fence->>'lease_token', '') = ''
     or coalesce(v_fence->>'lease_version', '')
          !~ '^[1-9][0-9]*$'
     or not exists (
       select 1
         from public.account_deletion_cleanup_jobs j
         join public.profiles p on p.id = j.user_id
        where j.id::text = v_fence->>'job_id'
          and j.user_id = old.id
          and j.lease_token::text = v_fence->>'lease_token'
          and j.lease_version =
                (v_fence->>'lease_version')::integer
          and j.status = 'leased'
          and j.leased_until > pg_catalog.clock_timestamp()
          and j.lease_targets = '[]'::jsonb
          and j.lease_generation_ids = '[]'::jsonb
          and pg_catalog.clock_timestamp() >= j.final_sweep_after
          and p.deleted_at is not null
          and not public.bp_account_cleanup_has_open_intent(j.user_id)
          and not
            public.bp_account_cleanup_has_open_generation_reconciliation(
              j.user_id
            )
          and not exists (
            select 1
              from public.bp_account_cleanup_targets(j.user_id, 1)
          )
          and not exists (
            select 1
              from public.bp_account_cleanup_generation_targets(
                j.user_id,
                1
              )
          )
     ) then
    raise exception 'stale_cleanup_auth_fence'
      using errcode = 'P0001';
  end if;
  return new;
exception
  when invalid_text_representation
    or numeric_value_out_of_range then
    raise exception 'stale_cleanup_auth_fence'
      using errcode = 'P0001';
end;
$$;
revoke all on function
  public.bp_fence_account_deletion_auth_scrub()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_auth_users_fence_account_deletion_scrub
  on auth.users;
create trigger trg_auth_users_fence_account_deletion_scrub
  before update of email on auth.users
  for each row
  execute function public.bp_fence_account_deletion_auth_scrub();

-- A token retry must not extend a hidden doll's horizon after purge starts.
-- The row lock makes token issuance and purge begin/finish serializable.
create or replace function
  public.bp_reject_upload_intent_during_moderation_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doll_id uuid;
  v_deleted_at timestamptz;
  v_purged_at timestamptz;
begin
  if new.purpose = 'highlight_upload' then
    select s.doll_id, d.deleted_at, d.artifacts_purged_at
      into v_doll_id, v_deleted_at, v_purged_at
      from public.scores s
      join public.dolls d on d.id = s.doll_id
     where s.id = new.subject_id
     for key share of s, d;
  elsif new.purpose = 'doll_upload' then
    v_doll_id := new.subject_id;
    select d.deleted_at, d.artifacts_purged_at
      into v_deleted_at, v_purged_at
      from public.dolls d
     where d.id = v_doll_id
     for key share;
  else
    return new;
  end if;

  if v_doll_id is not null
     and (
       v_deleted_at is not null
       or v_purged_at is not null
       or exists (
         select 1
           from public.moderation_purge_jobs j
          where j.doll_id = v_doll_id
            and j.status in ('pending', 'leased')
       )
     ) then
    raise exception 'purge_pending' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function
  public.bp_reject_upload_intent_during_moderation_purge()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_storage_upload_intent_reject_purge
  on public.storage_upload_intents;
create trigger trg_storage_upload_intent_reject_purge
  before insert or update of
    token_issue_count, last_token_horizon, expires_at
  on public.storage_upload_intents
  for each row
  execute function
    public.bp_reject_upload_intent_during_moderation_purge();

-- ── 3. Begin functions no longer materialize whole account histories ───────

create or replace function public.bp_0084_admin_soft_delete_account_impl(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_existing public.account_deletion_cleanup_jobs%rowtype;
  v_job_id uuid;
  v_manifest jsonb := pg_catalog.jsonb_build_object(
    'dolls', '[]'::jsonb,
    'highlights', '[]'::jsonb,
    'avatar', null
  );
  v_pending_order uuid;
  v_horizon timestamptz;
  lot record;
begin
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_existing
    from public.account_deletion_cleanup_jobs
   where user_id = p_user_id
     and status in ('pending', 'leased')
   order by created_at desc, id desc
   limit 1
   for update;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_existing.id,
      'user_id', p_user_id,
      'cleanup_status', v_existing.status,
      'manifest', v_existing.manifest
    );
  end if;

  if v_profile.deleted_at is not null then
    select *
      into v_existing
      from public.account_deletion_cleanup_jobs
     where user_id = p_user_id
       and status = 'completed'
     order by completed_at desc, id desc
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'job_id', v_existing.id,
        'user_id', p_user_id,
        'cleanup_status', 'completed',
        'manifest', '{}'::jsonb
      );
    end if;
    raise exception 'account_deleted_without_cleanup_job'
      using errcode = 'P0001';
  end if;

  perform 1 from public.orders where user_id = p_user_id for update;
  select order_uuid
    into v_pending_order
    from public.orders
   where user_id = p_user_id
     and status = 'pending'
     and created_at > pg_catalog.now() - interval '30 minutes'
   order by created_at desc
   limit 1
   for update;
  if found then
    raise exception 'payment_pending' using errcode = 'P0001';
  end if;

  perform 1
    from public.order_refund_attempts
   where user_id = p_user_id
   for update;
  perform 1
    from public.refund_requests
   where user_id = p_user_id
   for update;
  perform 1
    from public.reconciliation_issues
   where user_id = p_user_id
   for update;

  if exists (
    select 1
      from public.order_refund_attempts
     where user_id = p_user_id
       and state in (
         'prepared', 'pg_requested', 'pg_pending', 'pg_succeeded',
         'manual_pending', 'manual_review'
       )
  ) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.refund_requests
     where user_id = p_user_id
       and state in ('building', 'prepared', 'processing', 'blocked')
  ) then
    raise exception 'open_refund_blocks_delete' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.reconciliation_issues i
     where i.user_id = p_user_id
       and i.state = 'open'
       and i.type in (
         'economic_over_refund', 'manual_pg_cancel', 'unmatched_cancellation'
       )
  ) then
    raise exception 'open_issue_blocks_delete' using errcode = 'P0001';
  end if;

  v_horizon := public.bp_account_cleanup_intent_horizon(p_user_id);
  insert into public.account_deletion_cleanup_jobs(
    user_id,
    manifest,
    final_sweep_after
  )
  values (
    p_user_id,
    v_manifest,
    greatest(
      pg_catalog.clock_timestamp() + interval '2 hours 5 minutes',
      coalesce(
        v_horizon,
        pg_catalog.clock_timestamp() + interval '2 hours 5 minutes'
      )
    )
  )
  returning id into v_job_id;

  for lot in
    select id, (qty - consumed - refunded - refund_reserved) as avail
      from public.credit_lots
     where user_id = p_user_id
       and expired_at is null
     for update
  loop
    update public.credit_lots
       set expired_at = pg_catalog.now(),
           expiration_reason = 'account_deleted'
     where id = lot.id;
    if lot.avail > 0 then
      update public.member_accounts
         set gen_credits = gen_credits - lot.avail
       where user_id = p_user_id;
    end if;
    perform public.bp_credit_ledger_write(
      p_user_id, -lot.avail, 'expire',
      null, null, lot.id, null, null, null, 'account_deleted'
    );
  end loop;

  update public.score_highlights sh
     set highlight_deleted_at =
           coalesce(sh.highlight_deleted_at, pg_catalog.now())
    from public.scores s
   where sh.score_id = s.id
     and s.owner_id = p_user_id;

  update public.content_reports
     set status = 'actioned',
         resolved_at = pg_catalog.now(),
         resolved_by = null
   where target_type = 'doll'
     and status = 'pending'
     and target_id in (
       select id from public.dolls where owner_id = p_user_id
     );

  update public.profiles
     set deleted_at = coalesce(deleted_at, pg_catalog.now()),
         display_name = '탈퇴한 사용자',
         avatar_url = null
   where id = p_user_id;
  update public.member_accounts
     set email = null,
         gen_credits = 0
   where user_id = p_user_id;

  delete from public.dolls where owner_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'user_id', p_user_id,
    'cleanup_status', 'pending',
    'manifest', v_manifest
  );
end;
$$;
revoke all on function
  public.bp_0084_admin_soft_delete_account_impl(uuid)
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
  v_job_id uuid;
  v_horizon timestamptz;
begin
  if pg_catalog.char_length(
       pg_catalog.btrim(coalesce(p_reason, ''))
     ) not between 5 and 500 then
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
    return pg_catalog.jsonb_build_object(
      'ok', true, 'already_purged', true, 'job_id', null
    );
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

  v_horizon := public.bp_moderation_cleanup_intent_horizon(p_doll_id);
  insert into public.moderation_purge_jobs(
    doll_id,
    admin_user_id,
    reason,
    manifest,
    final_sweep_after
  )
  values (
    p_doll_id,
    p_admin_id,
    pg_catalog.btrim(p_reason),
    '[]'::jsonb,
    greatest(
      pg_catalog.clock_timestamp() + interval '2 hours 5 minutes',
      coalesce(
        v_horizon,
        pg_catalog.clock_timestamp() + interval '2 hours 5 minutes'
      )
    )
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

-- ── 4. Account cleanup v2: bounded claim + fenced convergence ──────────────

create or replace function public.claim_account_deletion_cleanup_v2(
  p_job_id uuid,
  p_lease_seconds integer,
  p_target_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_deletion_cleanup_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds integer :=
    greatest(15, least(coalesce(p_lease_seconds, 120), 600));
  v_limit integer :=
    greatest(1, least(coalesce(p_target_limit, 100), 100));
  v_targets jsonb;
  v_generation_ids jsonb;
  v_horizon timestamptz;
  v_scrub_auth boolean;
begin
  with candidate as (
    select j.id
      from public.account_deletion_cleanup_jobs j
     where (p_job_id is null or j.id = p_job_id)
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
  update public.account_deletion_cleanup_jobs j
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

  v_horizon :=
    public.bp_account_cleanup_intent_horizon(v_job.user_id);
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'bucket', t.bucket,
               'path', t.path
             )
             order by t.bucket, t.path
           ),
           '[]'::jsonb
         )
    into v_targets
    from public.bp_account_cleanup_targets(
      v_job.user_id,
      v_limit
    ) t;
  select coalesce(
           pg_catalog.jsonb_agg(t.generation_id order by t.generation_id),
           '[]'::jsonb
         )
    into v_generation_ids
    from public.bp_account_cleanup_generation_targets(
      v_job.user_id,
      v_limit
    ) t;

  update public.account_deletion_cleanup_jobs
     set lease_targets = v_targets,
         lease_generation_ids = v_generation_ids,
         final_sweep_after = greatest(
           final_sweep_after,
           coalesce(v_horizon, final_sweep_after)
         ),
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id
  returning * into v_job;

  v_scrub_auth :=
    pg_catalog.jsonb_array_length(v_targets) = 0
    and pg_catalog.jsonb_array_length(v_generation_ids) = 0
    and pg_catalog.clock_timestamp() >= v_job.final_sweep_after
    and not public.bp_account_cleanup_has_open_intent(v_job.user_id)
    and not
      public.bp_account_cleanup_has_open_generation_reconciliation(
        v_job.user_id
      )
    and not public.bp_account_cleanup_auth_is_scrubbed(v_job.user_id);

  return pg_catalog.jsonb_build_object(
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'targets', v_targets,
    'generation_ids', v_generation_ids,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count,
    'scrub_auth', v_scrub_auth,
    'final_sweep_after', v_job.final_sweep_after
  );
end;
$$;
revoke all on function public.claim_account_deletion_cleanup_v2(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.claim_account_deletion_cleanup_v2(
  uuid, integer, integer
) to service_role;

create or replace function public.finish_account_deletion_cleanup_v2(
  p_job_id uuid,
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
  v_job public.account_deletion_cleanup_jobs%rowtype;
  v_user_id uuid;
  v_batch_size integer;
  v_generation_batch_size integer;
  v_existing_count integer;
  v_removed_count integer;
  v_scrubbed_generations integer;
  v_delay integer;
  v_horizon timestamptz;
  v_has_target boolean;
  v_has_generation boolean;
  v_has_open_intent boolean;
  v_has_open_generation_reconciliation boolean;
  v_auth_scrubbed boolean;
  v_status text;
  v_next_attempt_at timestamptz;
begin
  select j.user_id
    into v_user_id
    from public.account_deletion_cleanup_jobs j
   where j.id = p_job_id;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  perform public.bp_user_mutation_lock(v_user_id);
  perform 1
    from public.profiles p
   where p.id = v_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_job
    from public.account_deletion_cleanup_jobs j
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_token = p_lease_token
     and j.lease_version = p_lease_version
     and j.leased_until > pg_catalog.clock_timestamp()
   for update;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  v_batch_size := pg_catalog.jsonb_array_length(v_job.lease_targets);
  v_generation_batch_size :=
    pg_catalog.jsonb_array_length(v_job.lease_generation_ids);
  select count(*)::integer
    into v_existing_count
    from pg_catalog.jsonb_array_elements(v_job.lease_targets) target
   where exists (
     select 1
       from storage.objects o
      where o.bucket_id = target->>'bucket'
        and o.name = target->>'path'
   );
  v_removed_count := v_batch_size - v_existing_count;

  if not coalesce(p_success, false) then
    v_delay := least(
      3600,
      (
        30 * pg_catalog.power(
          2::numeric,
          least(greatest(v_job.attempt_count - 1, 0), 7)
        )
      )::integer
    );
    update public.account_deletion_cleanup_jobs
       set status = 'pending',
           lease_targets = '[]'::jsonb,
           lease_generation_ids = '[]'::jsonb,
           removed_target_count =
             removed_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = pg_catalog.left(
             coalesce(
               nullif(pg_catalog.btrim(p_error), ''),
               'cleanup_failed'
             ),
             1000
           ),
           next_attempt_at =
             pg_catalog.clock_timestamp()
               + pg_catalog.make_interval(secs => v_delay),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'user_id', v_job.user_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending',
      'retry_in_seconds', v_delay
    );
  end if;

  if v_existing_count > 0 then
    update public.account_deletion_cleanup_jobs
       set status = 'pending',
           lease_targets = '[]'::jsonb,
           lease_generation_ids = '[]'::jsonb,
           removed_target_count =
             removed_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = 'cleanup_target_remains',
           next_attempt_at =
             pg_catalog.clock_timestamp() + interval '5 seconds',
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'user_id', v_job.user_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending_target_remains',
      'remaining_targets', v_existing_count
    );
  end if;

  v_scrubbed_generations :=
    public.bp_scrub_account_generation_batch(
      v_job.user_id,
      v_job.lease_generation_ids
    );
  if v_scrubbed_generations <> v_generation_batch_size then
    raise exception 'cleanup_generation_target_changed'
      using errcode = 'P0001';
  end if;

  v_horizon :=
    public.bp_account_cleanup_intent_horizon(v_job.user_id);
  update public.account_deletion_cleanup_jobs
     set removed_target_count =
           removed_target_count + v_removed_count,
         scrubbed_generation_count =
           scrubbed_generation_count + v_scrubbed_generations,
         final_sweep_after = greatest(
           final_sweep_after,
           coalesce(v_horizon, final_sweep_after)
         )
   where id = v_job.id
  returning * into v_job;

  select exists (
    select 1
      from public.bp_account_cleanup_targets(v_job.user_id, 1)
  ) into v_has_target;
  select exists (
    select 1
      from public.bp_account_cleanup_generation_targets(
        v_job.user_id,
        1
      )
  ) into v_has_generation;
  v_has_open_intent :=
    public.bp_account_cleanup_has_open_intent(v_job.user_id);
  v_has_open_generation_reconciliation :=
    public.bp_account_cleanup_has_open_generation_reconciliation(
      v_job.user_id
    );
  v_auth_scrubbed :=
    public.bp_account_cleanup_auth_is_scrubbed(v_job.user_id);

  if v_has_target or v_has_generation then
    v_status := 'pending_batch';
    v_next_attempt_at := pg_catalog.clock_timestamp();
  elsif pg_catalog.clock_timestamp() < v_job.final_sweep_after then
    v_status := 'pending_final_sweep';
    v_next_attempt_at := v_job.final_sweep_after;
  elsif v_has_open_generation_reconciliation then
    v_status := 'pending_generation_reconciliation';
    v_next_attempt_at := pg_catalog.clock_timestamp() + interval '5 minutes';
  elsif v_has_open_intent then
    v_status := 'pending_intent_drain';
    v_next_attempt_at := pg_catalog.clock_timestamp() + interval '30 seconds';
  elsif not v_auth_scrubbed then
    v_status := 'pending_auth_scrub';
    v_next_attempt_at := pg_catalog.clock_timestamp();
  else
    update auth.users u
       set raw_app_meta_data =
             case
               when pg_catalog.jsonb_typeof(u.raw_app_meta_data) = 'object'
                 then u.raw_app_meta_data - 'bp_account_cleanup_fence'
               else u.raw_app_meta_data
             end,
           updated_at = pg_catalog.clock_timestamp()
     where u.id = v_job.user_id
       and u.raw_app_meta_data
             ->'bp_account_cleanup_fence'->>'job_id' =
               v_job.id::text
       and u.raw_app_meta_data
             ->'bp_account_cleanup_fence'->>'user_id' =
               v_job.user_id::text
       and u.raw_app_meta_data
             ->'bp_account_cleanup_fence'->>'action' = 'scrub';

    update public.account_deletion_cleanup_jobs
       set status = 'completed',
           manifest = '{}'::jsonb,
           lease_targets = '[]'::jsonb,
           lease_generation_ids = '[]'::jsonb,
           lease_token = null,
           leased_until = null,
           last_error = null,
           completed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'user_id', v_job.user_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'completed',
      'removed_targets', v_job.removed_target_count,
      'scrubbed_generations', v_job.scrubbed_generation_count
    );
  end if;

  update public.account_deletion_cleanup_jobs
     set status = 'pending',
         lease_targets = '[]'::jsonb,
         lease_generation_ids = '[]'::jsonb,
         lease_token = null,
         leased_until = null,
         last_error = null,
         next_attempt_at = v_next_attempt_at,
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', v_status,
    'final_sweep_after', v_job.final_sweep_after
  );
end;
$$;
revoke all on function public.finish_account_deletion_cleanup_v2(
  uuid, uuid, integer, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_account_deletion_cleanup_v2(
  uuid, uuid, integer, boolean, text
) to service_role;

-- Old workers must never claim a v2 job whose bounded targets they do not
-- understand. Existing leases were invalidated above before this stub lands.
create or replace function public.claim_account_deletion_cleanup(
  p_job_id uuid default null,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return null;
end;
$$;
revoke all on function public.claim_account_deletion_cleanup(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_account_deletion_cleanup(uuid, integer)
  to service_role;

create or replace function public.finish_account_deletion_cleanup(
  p_job_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'cleanup_worker_upgrade_required'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.finish_account_deletion_cleanup(
  uuid, uuid, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_account_deletion_cleanup(
  uuid, uuid, boolean, text
) to service_role;

-- ── 5. Moderation purge v2: same bounded/fenced convergence ────────────────

create or replace function public.claim_moderation_purge_v2(
  p_job_id uuid,
  p_lease_seconds integer,
  p_target_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.moderation_purge_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds integer :=
    greatest(15, least(coalesce(p_lease_seconds, 120), 600));
  v_limit integer :=
    greatest(1, least(coalesce(p_target_limit, 100), 100));
  v_targets jsonb;
  v_horizon timestamptz;
begin
  with candidate as (
    select j.id
      from public.moderation_purge_jobs j
     where (p_job_id is null or j.id = p_job_id)
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
  update public.moderation_purge_jobs j
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

  v_horizon :=
    public.bp_moderation_cleanup_intent_horizon(v_job.doll_id);
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'bucket', t.bucket,
               'path', t.path
             )
             order by t.bucket, t.path
           ),
           '[]'::jsonb
         )
    into v_targets
    from public.bp_moderation_cleanup_targets(
      v_job.doll_id,
      v_limit
    ) t;

  update public.moderation_purge_jobs
     set manifest = v_targets,
         final_sweep_after = greatest(
           final_sweep_after,
           coalesce(v_horizon, final_sweep_after)
         ),
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id
  returning * into v_job;

  return pg_catalog.jsonb_build_object(
    'job_id', v_job.id,
    'doll_id', v_job.doll_id,
    'manifest', v_job.manifest,
    'lease_token', v_job.lease_token,
    'lease_version', v_job.lease_version,
    'attempt_count', v_job.attempt_count,
    'final_sweep_after', v_job.final_sweep_after
  );
end;
$$;
revoke all on function public.claim_moderation_purge_v2(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.claim_moderation_purge_v2(
  uuid, integer, integer
) to service_role;

create or replace function public.finish_moderation_purge_v2(
  p_job_id uuid,
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
  v_job public.moderation_purge_jobs%rowtype;
  v_doll public.dolls%rowtype;
  v_doll_id uuid;
  v_batch_size integer;
  v_existing_count integer;
  v_removed_count integer;
  v_delay integer;
  v_horizon timestamptz;
  v_has_target boolean;
  v_has_open_intent boolean;
  v_status text;
  v_next_attempt_at timestamptz;
begin
  select j.doll_id
    into v_doll_id
    from public.moderation_purge_jobs j
   where j.id = p_job_id;
  if not found then
    raise exception 'purge_lease_lost' using errcode = 'P0001';
  end if;

  select *
    into v_doll
    from public.dolls d
   where d.id = v_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;

  select *
    into v_job
    from public.moderation_purge_jobs j
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_token = p_lease_token
     and j.lease_version = p_lease_version
     and j.leased_until > pg_catalog.clock_timestamp()
   for update;
  if not found then
    raise exception 'purge_lease_lost' using errcode = 'P0001';
  end if;
  if v_doll.deleted_at is null then
    raise exception 'purge_state_conflict' using errcode = 'P0001';
  end if;

  v_batch_size := pg_catalog.jsonb_array_length(v_job.manifest);
  select count(*)::integer
    into v_existing_count
    from pg_catalog.jsonb_array_elements(v_job.manifest) target
   where exists (
     select 1
       from storage.objects o
      where o.bucket_id = target->>'bucket'
        and o.name = target->>'path'
   );
  v_removed_count := v_batch_size - v_existing_count;

  if not coalesce(p_success, false) then
    v_delay := least(
      3600,
      (
        30 * pg_catalog.power(
          2::numeric,
          least(greatest(v_job.attempt_count - 1, 0), 7)
        )
      )::integer
    );
    update public.moderation_purge_jobs
       set status = 'pending',
           manifest = '[]'::jsonb,
           purged_target_count =
             purged_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = pg_catalog.left(
             coalesce(
               nullif(pg_catalog.btrim(p_error), ''),
               'purge_failed'
             ),
             1000
           ),
           next_attempt_at =
             pg_catalog.clock_timestamp()
               + pg_catalog.make_interval(secs => v_delay),
           updated_at = pg_catalog.clock_timestamp()
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
  end if;

  if v_existing_count > 0 then
    update public.moderation_purge_jobs
       set status = 'pending',
           manifest = '[]'::jsonb,
           purged_target_count =
             purged_target_count + v_removed_count,
           lease_token = null,
           leased_until = null,
           last_error = 'purge_target_remains',
           next_attempt_at =
             pg_catalog.clock_timestamp() + interval '5 seconds',
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'doll_id', v_job.doll_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'pending_target_remains',
      'remaining_targets', v_existing_count
    );
  end if;

  v_horizon :=
    public.bp_moderation_cleanup_intent_horizon(v_job.doll_id);
  update public.moderation_purge_jobs
     set purged_target_count =
           purged_target_count + v_removed_count,
         final_sweep_after = greatest(
           final_sweep_after,
           coalesce(v_horizon, final_sweep_after)
         )
   where id = v_job.id
  returning * into v_job;

  select exists (
    select 1
      from public.bp_moderation_cleanup_targets(v_job.doll_id, 1)
  ) into v_has_target;
  v_has_open_intent :=
    public.bp_moderation_cleanup_has_open_intent(v_job.doll_id);

  if v_has_target then
    v_status := 'pending_batch';
    v_next_attempt_at := pg_catalog.clock_timestamp();
  elsif pg_catalog.clock_timestamp() < v_job.final_sweep_after then
    v_status := 'pending_final_sweep';
    v_next_attempt_at := v_job.final_sweep_after;
  elsif v_has_open_intent then
    v_status := 'pending_intent_drain';
    v_next_attempt_at := pg_catalog.clock_timestamp() + interval '30 seconds';
  else
    update public.dolls
       set artifacts_purged_at =
             coalesce(artifacts_purged_at, pg_catalog.clock_timestamp())
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
        'purged_targets', v_job.purged_target_count,
        'lease_version', v_job.lease_version
      )
    );

    update public.moderation_purge_jobs
       set status = 'completed',
           manifest = '[]'::jsonb,
           lease_token = null,
           leased_until = null,
           last_error = null,
           completed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', v_job.id,
      'doll_id', v_job.doll_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'completed',
      'purged_targets', v_job.purged_target_count
    );
  end if;

  update public.moderation_purge_jobs
     set status = 'pending',
         manifest = '[]'::jsonb,
         lease_token = null,
         leased_until = null,
         last_error = null,
         next_attempt_at = v_next_attempt_at,
         updated_at = pg_catalog.clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'doll_id', v_job.doll_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', v_status,
    'final_sweep_after', v_job.final_sweep_after
  );
end;
$$;
revoke all on function public.finish_moderation_purge_v2(
  uuid, uuid, integer, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_moderation_purge_v2(
  uuid, uuid, integer, boolean, text
) to service_role;

create or replace function public.claim_moderation_purge(
  p_job_id uuid default null,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return null;
end;
$$;
revoke all on function public.claim_moderation_purge(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_moderation_purge(uuid, integer)
  to service_role;

create or replace function public.finish_moderation_purge(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_version integer,
  p_success boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'purge_worker_upgrade_required'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.finish_moderation_purge(
  uuid, uuid, integer, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_moderation_purge(
  uuid, uuid, integer, boolean, text
) to service_role;

-- ── 6. Postflight ─────────────────────────────────────────────────────────

do $$
declare
  v_account_claim regprocedure :=
    'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)'::regprocedure;
  v_account_finish regprocedure :=
    'public.finish_account_deletion_cleanup_v2(uuid,uuid,integer,boolean,text)'::regprocedure;
  v_account_arm regprocedure :=
    'public.arm_account_deletion_cleanup_auth_fence(uuid,uuid,uuid,integer)'::regprocedure;
  v_generation_scrub regprocedure :=
    'public.bp_scrub_account_generation_batch(uuid,jsonb)'::regprocedure;
  v_purge_claim regprocedure :=
    'public.claim_moderation_purge_v2(uuid,integer,integer)'::regprocedure;
  v_purge_finish regprocedure :=
    'public.finish_moderation_purge_v2(uuid,uuid,integer,boolean,text)'::regprocedure;
  v_definition text;
begin
  if not pg_catalog.has_function_privilege(
       'service_role', v_account_claim, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_account_finish, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_account_arm, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_purge_claim, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_purge_finish, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', v_account_claim, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', v_account_arm, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', v_purge_claim, 'EXECUTE'
     ) then
    raise exception '008903 postflight: cleanup RPC ACL drift';
  end if;

  select pg_catalog.pg_get_functiondef(v_account_claim)
    into v_definition;
  if pg_catalog.strpos(v_definition, 'least(coalesce(p_target_limit, 100), 100)')
       = 0
     or pg_catalog.strpos(v_definition, 'bp_account_cleanup_targets') = 0
     or pg_catalog.strpos(
          v_definition,
          'bp_account_cleanup_generation_targets'
        ) = 0
     or pg_catalog.strpos(v_definition, 'lease_generation_ids') = 0 then
    raise exception '008903 postflight: account bound drift';
  end if;
  select pg_catalog.pg_get_functiondef(v_purge_claim)
    into v_definition;
  if pg_catalog.strpos(v_definition, 'least(coalesce(p_target_limit, 100), 100)')
       = 0
     or pg_catalog.strpos(v_definition, 'bp_moderation_cleanup_targets') = 0 then
    raise exception '008903 postflight: purge bound drift';
  end if;
  select pg_catalog.pg_get_functiondef(v_account_finish)
    into v_definition;
  if pg_catalog.strpos(v_definition, 'storage.objects') = 0
     or pg_catalog.strpos(v_definition, 'pending_intent_drain') = 0
     or pg_catalog.strpos(v_definition, 'pending_auth_scrub') = 0
     or pg_catalog.strpos(
          v_definition,
          'bp_scrub_account_generation_batch'
        ) = 0
     or pg_catalog.strpos(v_definition, 'scrubbed_generation_count') = 0 then
    raise exception '008903 postflight: account terminal fence drift';
  end if;
  select pg_catalog.pg_get_functiondef(v_generation_scrub)
    into v_definition;
  if pg_catalog.strpos(
       v_definition,
       'update public.generation_cost_reconciliation_issues'
     ) = 0
     or pg_catalog.strpos(
          v_definition,
          'update public.generation_preflight_reservations'
        ) = 0
     or pg_catalog.strpos(
          v_definition,
          'update public.generation_pick_cost_attempts'
        ) = 0
     or pg_catalog.strpos(v_definition, 'update public.ai_generations') = 0
     or pg_catalog.strpos(v_definition, 'owner_id = null') = 0
     or pg_catalog.strpos(v_definition, 'privacy_scrubbed_at') = 0
     or pg_catalog.has_function_privilege(
          'service_role',
          v_generation_scrub,
          'EXECUTE'
        )
     or pg_catalog.has_function_privilege(
          'authenticated',
          v_generation_scrub,
          'EXECUTE'
  ) then
    raise exception '008903 postflight: generation privacy scrub drift';
  end if;
  if (
       select pg_catalog.count(*)
         from pg_catalog.pg_constraint c
        where c.conname in (
                'generation_preflight_generation_owner_fkey',
                'generation_submit_generation_owner_fkey',
                'generation_pick_generation_owner_fkey',
                'generation_pick_cost_generation_owner_fkey',
                'generation_reconciliation_generation_owner_fkey'
              )
          and c.contype = 'f'
          and c.convalidated
          and pg_catalog.lower(
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_constraintdef(c.oid),
                  '[[:space:]]',
                  '',
                  'g'
                )
              ) =
                'foreignkey(generation_id,owner_id)' ||
                'referencesai_generations(id,owner_id)'
     ) <> 5
     or not exists (
       select 1
         from pg_catalog.pg_constraint c
        where c.conrelid = 'public.ai_generations'::regclass
          and c.conname = 'ai_generations_id_owner_key'
          and c.contype = 'u'
          and c.convalidated
          and pg_catalog.lower(
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_constraintdef(c.oid),
                  '[[:space:]]',
                  '',
                  'g'
                )
              ) = 'unique(id,owner_id)'
     )
     or not exists (
       select 1
         from pg_catalog.pg_index i
         join pg_catalog.pg_class idx on idx.oid = i.indexrelid
        where i.indrelid =
                'public.generation_preflight_reservations'::regclass
          and idx.relname =
                'generation_preflight_generation_owner_fk_idx'
          and i.indisvalid
          and i.indisready
     )
     or not exists (
       select 1
         from pg_catalog.pg_index i
         join pg_catalog.pg_class idx on idx.oid = i.indexrelid
        where i.indrelid =
                'public.generation_pick_cost_attempts'::regclass
          and idx.relname =
                'generation_pick_cost_generation_owner_fk_idx'
          and i.indisvalid
          and i.indisready
     ) then
    raise exception '008903 postflight: generation owner fence drift';
  end if;
  if not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'auth.users'::regclass
          and t.tgname =
                'trg_auth_users_fence_account_deletion_scrub'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgfoid =
                'public.bp_fence_account_deletion_auth_scrub()'::regprocedure
     )
     or pg_catalog.has_function_privilege(
          'service_role',
          'public.bp_fence_account_deletion_auth_scrub()',
          'EXECUTE'
  ) then
    raise exception '008903 postflight: account Auth fence drift';
  end if;
  if not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid = 'public.ai_generations'::regclass
          and t.tgname = 'trg_ai_generations_fence_privacy_scrub'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgfoid =
                'public.bp_fence_ai_generation_privacy()'::regprocedure
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger t
        where t.tgrelid =
                'public.generation_cost_reconciliation_issues'::regclass
          and t.tgname =
                'trg_generation_reconciliation_fence_privacy'
          and not t.tgisinternal
          and t.tgenabled = 'O'
          and t.tgfoid =
                'public.bp_fence_generation_reconciliation_privacy()'
                  ::regprocedure
     ) then
    raise exception '008903 postflight: generation privacy fence drift';
  end if;
  select pg_catalog.pg_get_functiondef(v_purge_finish)
    into v_definition;
  if pg_catalog.strpos(v_definition, 'storage.objects') = 0
     or pg_catalog.strpos(v_definition, 'pending_intent_drain') = 0
     or pg_catalog.strpos(v_definition, 'artifacts_purged_at') = 0 then
    raise exception '008903 postflight: purge terminal fence drift';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values (
  '008903_bounded_asset_cleanup_sagas', null, null, null
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
