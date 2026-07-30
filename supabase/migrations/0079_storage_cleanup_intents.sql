-- 0079: durable Storage upload/delete lifecycle.
--
-- A) Admin signed uploads receive an intent before a token is issued. Confirm is
--    owner/freshness fenced; app_settings/events triggers atomically attach an
--    intent or lose to cleanup claim. Unattached objects are removed after the
--    two-hour token horizon.
-- B) Doll/avatar user deletion changes DB state and creates a cleanup outbox in
--    one transaction. Storage removal is retried with a fenced lease, eliminating
--    the old Storage-success -> DB-failure broken-reference window.
--
-- Migration-first additive rollout. Legacy paths without an intent remain
-- attachable and are never swept, preserving pre-cutover assets and old code.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- ── 1. Signed-upload intents ────────────────────────────────────────────────
create table public.storage_upload_intents (
  id uuid primary key default gen_random_uuid(),
  -- No profile FK: a deleted admin must not erase the late-upload cleanup proof.
  owner_user_id uuid not null,
  subject_id uuid,
  purpose text not null check (
    purpose in (
      'site_asset_og',
      'site_asset_logo',
      'event_image',
      'avatar_upload',
      'highlight_upload',
      'doll_upload'
    )
  ),
  bucket text not null check (
    bucket in ('site-assets', 'events', 'avatars', 'highlights', 'dolls')
  ),
  path text not null,
  status text not null default 'issued' check (
    status in ('issued', 'confirmed', 'attached', 'pending', 'leased', 'cleaned')
  ),
  expires_at timestamptz not null
    default (now() + interval '2 hours 5 minutes'),
  confirmed_at timestamptz,
  attached_at timestamptz,
  cleanup_after timestamptz not null
    default (now() + interval '2 hours 5 minutes'),
  lease_version int not null default 0 check (lease_version >= 0),
  lease_token uuid,
  leased_until timestamptz,
  attempt_count int not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null
    default (now() + interval '2 hours 5 minutes'),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cleaned_at timestamptz,
  unique (bucket, path),
  constraint storage_upload_intent_lease_check check (
    (status = 'leased') =
      (lease_token is not null and leased_until is not null)
  ),
  constraint storage_upload_intent_terminal_check check (
    (status = 'cleaned') = (cleaned_at is not null)
  )
);

alter table public.storage_upload_intents enable row level security;
revoke all on table public.storage_upload_intents
  from public, anon, authenticated, service_role;
create index idx_storage_upload_intent_cleanup
  on public.storage_upload_intents(next_attempt_at, created_at, id)
  where status in ('issued', 'confirmed', 'pending', 'leased');

-- A pre-intent app deployment can still hold a two-hour signed token while
-- this expand migration is rolling out. If that old client uploads after the
-- new DB schema exists and intent adoption then loses DB availability before
-- inserting a row, the object would otherwise be invisible to the intent
-- sweeper forever. Record the exact rollout inventory floor now; 0092 enables
-- a bounded scanner only after the new app is live and old requests are
-- drained. The window closes one signed-token horizon after contract.
create table public.storage_legacy_upload_sweep_control (
  singleton boolean primary key default true check (singleton),
  inventory_floor_at timestamptz not null,
  enabled_at timestamptz,
  window_ends_at timestamptz,
  constraint storage_legacy_upload_sweep_window_check check (
    (enabled_at is null and window_ends_at is null)
    or (
      enabled_at is not null
      and window_ends_at =
        enabled_at + interval '2 hours 5 minutes'
      and enabled_at >= inventory_floor_at
    )
  )
);
insert into public.storage_legacy_upload_sweep_control(
  singleton,
  inventory_floor_at
)
values (true, clock_timestamp());
alter table public.storage_legacy_upload_sweep_control enable row level security;
revoke all on table public.storage_legacy_upload_sweep_control
  from public, anon, authenticated, service_role;

-- Admin event/site assets intentionally survive detachment because config and
-- content audit history can roll back to them. At contract time, 0092 snapshots
-- every referenced legacy object in the finite rollout window here so the
-- orphan scanner never reclassifies it after a later detach.
create table public.storage_legacy_upload_protections (
  bucket text not null check (
    bucket in ('site-assets', 'events', 'avatars', 'highlights')
  ),
  path text not null,
  reason text not null check (
    reason in ('contract_reference_snapshot', 'scanner_reference_guard')
  ),
  protected_at timestamptz not null default now(),
  primary key (bucket, path)
);
alter table public.storage_legacy_upload_protections enable row level security;
revoke all on table public.storage_legacy_upload_protections
  from public, anon, authenticated, service_role;

create or replace function public.create_admin_storage_upload_intent(
  p_admin_id uuid,
  p_purpose text,
  p_bucket text,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_expires_at timestamptz;
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  perform public.bp_assert_active_admin(p_admin_id);

  if not (
    (
      p_purpose = 'site_asset_og'
      and p_bucket = 'site-assets'
      and p_path ~ ('^og/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$')
    )
    or
    (
      p_purpose = 'site_asset_logo'
      and p_bucket = 'site-assets'
      and p_path ~ ('^logo/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$')
    )
    or
    (
      p_purpose = 'event_image'
      and p_bucket = 'events'
      and p_path ~ ('^[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp|gif)$')
    )
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;

  insert into public.storage_upload_intents(
    owner_user_id,
    purpose,
    bucket,
    path
  )
  values (p_admin_id, p_purpose, p_bucket, p_path)
  returning id, expires_at into v_id, v_expires_at;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'intent_id', v_id,
    'expires_at', v_expires_at
  );
end;
$$;
revoke all on function public.create_admin_storage_upload_intent(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_admin_storage_upload_intent(
  uuid, text, text, text
) to service_role;

create or replace function public.confirm_admin_storage_upload_intent(
  p_admin_id uuid,
  p_bucket text,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.storage_upload_intents%rowtype;
  v_expected_purpose text;
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  perform public.bp_assert_active_admin(p_admin_id);

  -- The route cannot nominate a purpose on confirm, so derive it from the
  -- canonical bucket/path namespace. This prevents a malformed or concurrently
  -- adopted row for the same admin/path but a different purpose from being
  -- accepted merely because the unique (bucket, path) key already exists.
  v_expected_purpose := case
    when p_bucket = 'site-assets'
      and p_path ~ ('^og/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$')
      then 'site_asset_og'
    when p_bucket = 'site-assets'
      and p_path ~ ('^logo/[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp)$')
      then 'site_asset_logo'
    when p_bucket = 'events'
      and p_path ~ ('^[0-9]{6}/' || v_uuid_pattern || '\.(png|jpg|webp|gif)$')
      then 'event_image'
    else null
  end;

  select *
    into v_intent
    from public.storage_upload_intents
   where bucket = p_bucket
     and path = p_path
   for update;
  if not found
     or v_expected_purpose is null
     or v_intent.owner_user_id <> p_admin_id
     or v_intent.purpose <> v_expected_purpose then
    raise exception 'upload_intent_forbidden' using errcode = 'P0001';
  end if;
  if clock_timestamp() > v_intent.expires_at then
    raise exception 'upload_intent_expired' using errcode = 'P0001';
  end if;
  if v_intent.status = 'attached' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_attached');
  end if;
  if v_intent.status not in ('issued', 'confirmed') then
    raise exception 'upload_cleanup_in_progress' using errcode = 'P0001';
  end if;

  update public.storage_upload_intents
     set status = 'confirmed',
         confirmed_at = coalesce(confirmed_at, clock_timestamp()),
         updated_at = clock_timestamp()
   where id = v_intent.id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'confirmed');
end;
$$;
revoke all on function public.confirm_admin_storage_upload_intent(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.confirm_admin_storage_upload_intent(
  uuid, text, text
) to service_role;

create or replace function public.create_avatar_upload_intent(
  p_user_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_id uuid;
  v_expires_at timestamptz;
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  if p_path !~ (
    '^' || p_user_id::text || '/' || v_uuid_pattern || '\.(png|jpg|webp)$'
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;

  insert into public.storage_upload_intents(
    owner_user_id,
    purpose,
    bucket,
    path
  )
  values (p_user_id, 'avatar_upload', 'avatars', p_path)
  returning id, expires_at into v_id, v_expires_at;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'intent_id', v_id, 'expires_at', v_expires_at);
end;
$$;
revoke all on function public.create_avatar_upload_intent(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_avatar_upload_intent(uuid, text)
  to service_role;

create or replace function public.confirm_avatar_upload_intent(
  p_user_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_intent public.storage_upload_intents%rowtype;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select *
    into v_intent
    from public.storage_upload_intents
   where bucket = 'avatars'
     and path = p_path
   for update;
  if not found
     or v_intent.owner_user_id <> p_user_id
     or v_intent.purpose <> 'avatar_upload' then
    raise exception 'upload_intent_forbidden' using errcode = 'P0001';
  end if;
  if clock_timestamp() > v_intent.expires_at then
    raise exception 'upload_intent_expired' using errcode = 'P0001';
  end if;
  if v_intent.status = 'attached' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_attached');
  end if;
  if v_intent.status not in ('issued', 'confirmed') then
    raise exception 'upload_cleanup_in_progress' using errcode = 'P0001';
  end if;
  update public.storage_upload_intents
     set status = 'confirmed',
         confirmed_at = coalesce(confirmed_at, clock_timestamp()),
         updated_at = clock_timestamp()
   where id = v_intent.id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'confirmed');
end;
$$;
revoke all on function public.confirm_avatar_upload_intent(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_avatar_upload_intent(uuid, text)
  to service_role;

create or replace function public.create_highlight_upload_intent(
  p_user_id uuid,
  p_score_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_owner_id uuid;
  v_review_status text;
  v_id uuid;
  v_expires_at timestamptz;
  v_uuid_pattern text :=
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select s.owner_id, s.review_status
    into v_owner_id, v_review_status
    from public.scores s
   where s.id = p_score_id
   for key share;
  if not found or v_owner_id <> p_user_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if v_review_status not in ('registered', 'cleared') then
    raise exception 'score_not_publishable' using errcode = 'P0001';
  end if;
  if p_path !~ (
    '^' || p_score_id::text || '/' || v_uuid_pattern || '\.(mp4|webm)$'
  ) then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.score_highlights where score_id = p_score_id
  ) then
    raise exception 'already_set' using errcode = 'P0001';
  end if;

  insert into public.storage_upload_intents(
    owner_user_id, subject_id, purpose, bucket, path
  )
  values (
    p_user_id, p_score_id, 'highlight_upload', 'highlights', p_path
  )
  returning id, expires_at into v_id, v_expires_at;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'intent_id', v_id, 'expires_at', v_expires_at);
end;
$$;
revoke all on function public.create_highlight_upload_intent(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_highlight_upload_intent(
  uuid, uuid, text
) to service_role;

create or replace function public.confirm_highlight_upload_intent(
  p_user_id uuid,
  p_score_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_owner_id uuid;
  v_review_status text;
  v_intent public.storage_upload_intents%rowtype;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select s.owner_id, s.review_status
    into v_owner_id, v_review_status
    from public.scores s
   where s.id = p_score_id
   for key share;
  if not found or v_owner_id <> p_user_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if v_review_status not in ('registered', 'cleared') then
    raise exception 'score_not_publishable' using errcode = 'P0001';
  end if;
  select *
    into v_intent
    from public.storage_upload_intents
   where bucket = 'highlights'
     and path = p_path
   for update;
  if not found
     or v_intent.owner_user_id <> p_user_id
     or v_intent.subject_id <> p_score_id
     or v_intent.purpose <> 'highlight_upload' then
    raise exception 'upload_intent_forbidden' using errcode = 'P0001';
  end if;
  if clock_timestamp() > v_intent.expires_at then
    raise exception 'upload_intent_expired' using errcode = 'P0001';
  end if;
  if v_intent.status = 'attached' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_attached');
  end if;
  if v_intent.status not in ('issued', 'confirmed') then
    raise exception 'upload_cleanup_in_progress' using errcode = 'P0001';
  end if;
  update public.storage_upload_intents
     set status = 'confirmed',
         confirmed_at = coalesce(confirmed_at, clock_timestamp()),
         updated_at = clock_timestamp()
   where id = v_intent.id;
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'confirmed');
end;
$$;
revoke all on function public.confirm_highlight_upload_intent(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.confirm_highlight_upload_intent(
  uuid, uuid, text
) to service_role;

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
  v_id uuid;
begin
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  if p_path <> (p_user_id::text || '/' || p_doll_id::text || '.png') then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
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
    clock_timestamp()
  )
  returning id into v_id;
  return pg_catalog.jsonb_build_object('ok', true, 'intent_id', v_id);
end;
$$;
revoke all on function public.create_doll_upload_intent(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_doll_upload_intent(uuid, uuid, text)
  to service_role;

-- Called only by SECURITY DEFINER table triggers. No intent means a legacy or
-- pre-cutover asset: allow it, but never place it in the new sweeper.
create or replace function public.bp_attach_admin_storage_upload_intent(
  p_bucket text,
  p_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.storage_upload_intents%rowtype;
begin
  if p_path is null or p_path = '' then
    return;
  end if;
  select *
    into v_intent
    from public.storage_upload_intents
   where bucket = p_bucket
     and path = p_path
   for update;
  if not found then
    return;
  end if;
  if v_intent.status = 'attached' then
    return;
  end if;
  if v_intent.status <> 'confirmed' then
    if v_intent.status = 'issued' then
      raise exception 'upload_not_confirmed' using errcode = 'P0001';
    elsif v_intent.status = 'cleaned' then
      raise exception 'upload_already_cleaned' using errcode = 'P0001';
    else
      raise exception 'upload_cleanup_in_progress' using errcode = 'P0001';
    end if;
  end if;

  update public.storage_upload_intents
     set status = 'attached',
         attached_at = clock_timestamp(),
         lease_token = null,
         leased_until = null,
         last_error = null,
         updated_at = clock_timestamp()
   where id = v_intent.id;
end;
$$;
revoke all on function public.bp_attach_admin_storage_upload_intent(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.bp_app_settings_attach_upload_intents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.key = 'media_config' then
    perform public.bp_attach_admin_storage_upload_intent(
      'site-assets',
      nullif(new.value->>'ogImagePath', '')
    );
    perform public.bp_attach_admin_storage_upload_intent(
      'site-assets',
      nullif(new.value->>'logoPath', '')
    );
  end if;
  return new;
end;
$$;
revoke all on function public.bp_app_settings_attach_upload_intents()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_app_settings_attach_upload_intents
  on public.app_settings;
create trigger trg_app_settings_attach_upload_intents
  before insert or update of value on public.app_settings
  for each row execute function public.bp_app_settings_attach_upload_intents();

create or replace function public.bp_events_attach_upload_intents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match text[];
begin
  perform public.bp_attach_admin_storage_upload_intent(
    'events',
    new.cover_image_path
  );
  -- Inline markdown stores a public URL. Capture only our canonical generated
  -- path segment; legacy/external URLs have no matching intent and remain valid.
  for v_match in
    select match
      from pg_catalog.regexp_matches(
        coalesce(new.body, ''),
        '([0-9]{6}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif))',
        'g'
      ) as match
  loop
    perform public.bp_attach_admin_storage_upload_intent(
      'events',
      v_match[1]
    );
  end loop;
  return new;
end;
$$;
revoke all on function public.bp_events_attach_upload_intents()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_events_attach_upload_intents on public.events;
create trigger trg_events_attach_upload_intents
  before insert or update of cover_image_path, body on public.events
  for each row execute function public.bp_events_attach_upload_intents();

create or replace function public.claim_storage_upload_cleanup(
  p_lease_seconds int default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.storage_upload_intents%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds int := greatest(15, least(coalesce(p_lease_seconds, 120), 600));
begin
  with candidate as (
    select i.id
      from public.storage_upload_intents i
     where (
       (
         i.status in ('issued', 'confirmed')
         and i.cleanup_after <= clock_timestamp()
       )
       or (i.status = 'pending' and i.next_attempt_at <= clock_timestamp())
       or (i.status = 'leased' and i.leased_until <= clock_timestamp())
     )
     order by i.next_attempt_at, i.created_at, i.id
     limit 1
     for update skip locked
  )
  update public.storage_upload_intents i
     set status = 'leased',
         lease_version = i.lease_version + 1,
         lease_token = v_token,
         leased_until =
           clock_timestamp() + pg_catalog.make_interval(secs => v_seconds),
         attempt_count = i.attempt_count + 1,
         updated_at = clock_timestamp()
    from candidate c
   where i.id = c.id
  returning i.* into v_intent;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'job_id', v_intent.id,
    'owner_user_id', v_intent.owner_user_id,
    'subject_id', v_intent.subject_id,
    'purpose', v_intent.purpose,
    'bucket', v_intent.bucket,
    'path', v_intent.path,
    'lease_token', v_intent.lease_token,
    'lease_version', v_intent.lease_version,
    'attempt_count', v_intent.attempt_count
  );
end;
$$;
revoke all on function public.claim_storage_upload_cleanup(int)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_storage_upload_cleanup(int)
  to service_role;

create or replace function public.finish_storage_upload_cleanup(
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
  v_intent public.storage_upload_intents%rowtype;
  v_delay int;
begin
  select *
    into v_intent
    from public.storage_upload_intents
   where id = p_job_id
     and status = 'leased'
     and lease_token = p_lease_token
     and lease_version = p_lease_version
     and leased_until > clock_timestamp()
   for update;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  if p_success then
    update public.storage_upload_intents
       set status = 'cleaned',
           lease_token = null,
           leased_until = null,
           last_error = null,
           cleaned_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = v_intent.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', p_job_id,
      'lease_token', p_lease_token,
      'lease_version', p_lease_version,
      'status', 'cleaned'
    );
  end if;

  v_delay := least(
    3600,
    (
      30 * pg_catalog.power(
        2::numeric,
        least(greatest(v_intent.attempt_count - 1, 0), 7)
      )
    )::int
  );
  update public.storage_upload_intents
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         last_error = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_error), ''), 'cleanup_failed'),
           1000
         ),
         next_attempt_at =
           clock_timestamp() + pg_catalog.make_interval(secs => v_delay),
         updated_at = clock_timestamp()
   where id = v_intent.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', p_job_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', 'pending',
    'retry_in_seconds', v_delay
  );
end;
$$;
revoke all on function public.finish_storage_upload_cleanup(
  uuid, uuid, int, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_storage_upload_cleanup(
  uuid, uuid, int, boolean, text
) to service_role;

-- ── 2. Generic DB-first object cleanup outbox ────────────────────────────────
create table public.storage_object_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (
    kind in (
      'doll_delete',
      'doll_create_compensation',
      'avatar_clear',
      'avatar_replace',
      'highlight_expired'
    )
  ),
  user_id uuid,
  subject_id uuid,
  bucket text not null check (bucket in ('dolls', 'avatars', 'highlights')),
  path text not null,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed', 'canceled')),
  lease_version int not null default 0 check (lease_version >= 0),
  lease_token uuid,
  leased_until timestamptz,
  attempt_count int not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (bucket, path),
  constraint storage_object_cleanup_lease_check check (
    (status = 'leased') =
      (lease_token is not null and leased_until is not null)
  ),
  constraint storage_object_cleanup_completion_check check (
    (status = 'completed') = (completed_at is not null)
  )
);

alter table public.storage_object_cleanup_jobs enable row level security;
revoke all on table public.storage_object_cleanup_jobs
  from public, anon, authenticated, service_role;
create index idx_storage_object_cleanup_claim
  on public.storage_object_cleanup_jobs(next_attempt_at, created_at, id)
  where status in ('pending', 'leased');
create index idx_storage_object_cleanup_subject
  on public.storage_object_cleanup_jobs(kind, user_id, subject_id);

-- Rolling expand stage: the old route removes Storage before issuing this
-- owner-scoped browser DELETE. Removing the grant here would leave a public DB
-- row pointing at an already deleted image. Keep the exact self-delete surface
-- until the new outbox route is live; 0092 removes it.
revoke delete on table public.dolls
  from public, anon;
grant delete on table public.dolls to authenticated;
drop policy if exists "dolls: owner delete" on public.dolls;
create policy "dolls: owner delete"
  on public.dolls
  for delete
  to authenticated
  using (auth.uid() = owner_id and deleted_at is null);

create or replace function public.bp_storage_path_is_referenced(
  p_bucket text,
  p_path text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_bucket = 'site-assets' then
    return exists (
      select 1
        from public.app_settings a
       where a.key = 'media_config'
         and (
           a.value->>'ogImagePath' = p_path
           or a.value->>'logoPath' = p_path
         )
    );
  elsif p_bucket = 'events' then
    return exists (
      select 1
        from public.events e
       where e.cover_image_path = p_path
          or pg_catalog.strpos(coalesce(e.body, ''), p_path) > 0
    );
  elsif p_bucket = 'avatars' then
    return exists (
      select 1
        from public.profiles p
       where p.deleted_at is null
         and public.bp_account_cleanup_storage_path(
               p.avatar_url, 'avatars'
             ) = p_path
    );
  elsif p_bucket = 'dolls' then
    return exists (
      select 1
        from public.dolls d
       where public.bp_account_cleanup_storage_path(
               d.image_url, 'dolls'
             ) = p_path
    );
  elsif p_bucket = 'highlights' then
    return exists (
      select 1
        from public.score_highlights sh
       where sh.highlight_deleted_at is null
         and sh.highlight_clip_path = p_path
    );
  end if;
  return false;
end;
$$;
revoke all on function public.bp_storage_path_is_referenced(text, text)
  from public, anon, authenticated, service_role;

create or replace function public.bp_cancel_storage_cleanup_for_attach(
  p_bucket text,
  p_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.storage_object_cleanup_jobs%rowtype;
begin
  if p_path is null or p_path = '' then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-path:' || p_bucket || ':' || p_path,
      0
    )
  );
  select *
    into v_job
    from public.storage_object_cleanup_jobs
   where bucket = p_bucket
     and path = p_path
   for update;
  if not found or v_job.status = 'canceled' then
    return;
  end if;
  if v_job.status = 'pending' then
    update public.storage_object_cleanup_jobs
       set status = 'canceled',
           lease_token = null,
           leased_until = null,
           last_error = null,
           updated_at = clock_timestamp()
     where id = v_job.id;
    return;
  end if;
  if v_job.status = 'leased' then
    raise exception 'upload_cleanup_in_progress' using errcode = 'P0001';
  end if;
  raise exception 'upload_already_cleaned' using errcode = 'P0001';
end;
$$;
revoke all on function public.bp_cancel_storage_cleanup_for_attach(text, text)
  from public, anon, authenticated, service_role;

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

  insert into public.storage_object_cleanup_jobs(
    kind, user_id, subject_id, bucket, path
  )
  values (p_kind, p_user_id, p_subject_id, p_bucket, p_path)
  on conflict (bucket, path) do update
     set kind = excluded.kind,
         user_id = excluded.user_id,
         subject_id = excluded.subject_id,
         status = 'pending',
         lease_token = null,
         leased_until = null,
         next_attempt_at = clock_timestamp(),
         last_error = null,
         completed_at = null,
         updated_at = clock_timestamp()
   where public.storage_object_cleanup_jobs.status = 'canceled'
  returning id into v_id;

  if v_id is null then
    select id
      into v_id
      from public.storage_object_cleanup_jobs
     where bucket = p_bucket
       and path = p_path;
  end if;
  return v_id;
end;
$$;
revoke all on function public.bp_enqueue_detached_storage_asset(
  text, uuid, uuid, text, text
) from public, anon, authenticated, service_role;

-- Rebind attach now that the generic cleanup outbox exists. A path attach and
-- detach share an advisory lock; attach cancels pending cleanup or loses to an
-- already leased cleanup.
create or replace function public.bp_attach_admin_storage_upload_intent(
  p_bucket text,
  p_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.storage_upload_intents%rowtype;
begin
  if p_path is null or p_path = '' then
    return;
  end if;
  perform public.bp_cancel_storage_cleanup_for_attach(p_bucket, p_path);
  select *
    into v_intent
    from public.storage_upload_intents
   where bucket = p_bucket
     and path = p_path
   for update;
  if not found then
    return;
  end if;
  if v_intent.status = 'attached' then
    return;
  end if;
  if v_intent.status <> 'confirmed' then
    if v_intent.status = 'issued' then
      raise exception 'upload_not_confirmed' using errcode = 'P0001';
    elsif v_intent.status = 'cleaned' then
      raise exception 'upload_already_cleaned' using errcode = 'P0001';
    else
      raise exception 'upload_cleanup_in_progress' using errcode = 'P0001';
    end if;
  end if;
  update public.storage_upload_intents
     set status = 'attached',
         attached_at = clock_timestamp(),
         lease_token = null,
         leased_until = null,
         last_error = null,
         updated_at = clock_timestamp()
   where id = v_intent.id;
end;
$$;

create or replace function public.bp_attach_owned_storage_upload_intent(
  p_owner_user_id uuid,
  p_subject_id uuid,
  p_purpose text,
  p_bucket text,
  p_path text,
  p_require_intent boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.storage_upload_intents%rowtype;
begin
  perform public.bp_attach_admin_storage_upload_intent(p_bucket, p_path);
  select *
    into v_intent
    from public.storage_upload_intents
   where bucket = p_bucket
     and path = p_path;
  if not found then
    if p_require_intent then
      raise exception 'upload_intent_forbidden' using errcode = 'P0001';
    end if;
    return;
  end if;
  if v_intent.owner_user_id <> p_owner_user_id
     or v_intent.subject_id is distinct from p_subject_id
     or v_intent.purpose <> p_purpose
     or v_intent.status <> 'attached' then
    raise exception 'upload_intent_forbidden' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.bp_attach_owned_storage_upload_intent(
  uuid, uuid, text, text, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.bp_events_attach_upload_intents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  for v_path in
    select distinct paths.path
      from (
        select new.cover_image_path as path
        union all
        select (matches.captures)[1] as path
          from pg_catalog.regexp_matches(
            coalesce(new.body, ''),
            '([0-9]{6}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif))',
            'g'
          ) as matches(captures)
      ) paths
     where paths.path is not null
     order by paths.path
  loop
    perform public.bp_attach_admin_storage_upload_intent('events', v_path);
  end loop;
  return new;
end;
$$;

create or replace function public.bp_doll_attach_upload_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  v_path := public.bp_account_cleanup_storage_path(new.image_url, 'dolls');
  if v_path is not null then
    perform public.bp_attach_owned_storage_upload_intent(
      new.owner_id,
      new.id,
      'doll_upload',
      'dolls',
      v_path,
      false
    );
  end if;
  return new;
end;
$$;
revoke all on function public.bp_doll_attach_upload_intent()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_zz_dolls_attach_upload_intent on public.dolls;
create trigger trg_zz_dolls_attach_upload_intent
  before insert on public.dolls
  for each row execute function public.bp_doll_attach_upload_intent();

create or replace function public.bp_highlight_attach_upload_intent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  if new.highlight_clip_path is null then
    return new;
  end if;
  select s.owner_id
    into v_owner_id
    from public.scores s
   where s.id = new.score_id;
  perform public.bp_attach_owned_storage_upload_intent(
    v_owner_id,
    new.score_id,
    'highlight_upload',
    'highlights',
    new.highlight_clip_path,
    false
  );
  return new;
end;
$$;
revoke all on function public.bp_highlight_attach_upload_intent()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_zz_score_highlights_attach_upload_intent
  on public.score_highlights;
create trigger trg_zz_score_highlights_attach_upload_intent
  before insert on public.score_highlights
  for each row execute function public.bp_highlight_attach_upload_intent();

create or replace function public.request_doll_delete(
  p_user_id uuid,
  p_doll_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_deleted_at timestamptz;
  v_doll public.dolls%rowtype;
  v_existing public.storage_object_cleanup_jobs%rowtype;
  v_path text;
  v_job_id uuid;
begin
  select p.deleted_at
    into v_profile_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_profile_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  -- Lost HTTP responses are idempotent even after the doll row is gone.
  select *
    into v_existing
    from public.storage_object_cleanup_jobs
   where kind = 'doll_delete'
     and user_id = p_user_id
     and subject_id = p_doll_id
   order by created_at desc, id desc
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already_deleted', true,
      'job_id', v_existing.id,
      'cleanup_status', v_existing.status
    );
  end if;

  select *
    into v_doll
    from public.dolls
   where id = p_doll_id
   for update;
  if not found then
    -- A concurrent identical request may have deleted the row after our first
    -- idempotency probe. Read the now-committed receipt once more.
    select *
      into v_existing
      from public.storage_object_cleanup_jobs
     where kind = 'doll_delete'
       and user_id = p_user_id
       and subject_id = p_doll_id
     order by created_at desc, id desc
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'already_deleted', true,
        'job_id', v_existing.id,
        'cleanup_status', v_existing.status
      );
    end if;
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.owner_id <> p_user_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if v_doll.deleted_at is not null then
    raise exception 'doll_unavailable' using errcode = 'P0001';
  end if;

  v_path := public.bp_account_cleanup_storage_path(v_doll.image_url, 'dolls');
  if v_path is not null then
    insert into public.storage_object_cleanup_jobs(
      kind, user_id, subject_id, bucket, path
    )
    values ('doll_delete', p_user_id, p_doll_id, 'dolls', v_path)
    returning id into v_job_id;
  end if;

  -- scores.doll_id is ON DELETE SET NULL. The DB-visible object disappears in
  -- the same commit that durably records its Storage cleanup.
  delete from public.dolls where id = p_doll_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'already_deleted', false,
    'job_id', v_job_id,
    'cleanup_status', case when v_job_id is null then 'completed' else 'pending' end
  );
end;
$$;
revoke all on function public.request_doll_delete(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_doll_delete(uuid, uuid)
  to service_role;

create or replace function public.request_doll_role_update(
  p_user_id uuid,
  p_doll_id uuid,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_doll public.dolls%rowtype;
begin
  if p_role not in ('boss', 'exec', 'teamlead', 'client', 'coworker') then
    raise exception 'invalid_role' using errcode = 'P0001';
  end if;
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select *
    into v_doll
    from public.dolls
   where id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.owner_id <> p_user_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if v_doll.deleted_at is not null then
    raise exception 'doll_unavailable' using errcode = 'P0001';
  end if;
  update public.dolls set role = p_role where id = p_doll_id;
  return pg_catalog.jsonb_build_object('ok', true, 'role', p_role);
end;
$$;
revoke all on function public.request_doll_role_update(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_doll_role_update(uuid, uuid, text)
  to service_role;

create or replace function public.request_avatar_clear(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_existing public.storage_object_cleanup_jobs%rowtype;
  v_path text;
  v_job_id uuid;
begin
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_profile.deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  -- A committed first request may lose its HTTP response before the worker
  -- claims the durable cleanup receipt. Once avatar_url is NULL the detached
  -- path is no longer recoverable from profiles, so replay the still-active
  -- receipt instead of falsely reporting cleanup as completed.
  if v_profile.avatar_url is null then
    select *
      into v_existing
      from public.storage_object_cleanup_jobs j
     where j.kind = 'avatar_clear'
       and j.user_id = p_user_id
       and j.subject_id = p_user_id
       and j.status in ('pending', 'leased')
     order by j.created_at desc, j.id desc
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'job_id', v_existing.id,
        'cleanup_status', v_existing.status
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', null,
      'cleanup_status', 'completed'
    );
  end if;

  v_path := public.bp_account_cleanup_storage_path(
    v_profile.avatar_url,
    'avatars'
  );
  update public.profiles
     set avatar_url = null
   where id = p_user_id;
  if v_path is not null
     and v_path like (p_user_id::text || '/%') then
    v_job_id := public.bp_enqueue_detached_storage_asset(
      'avatar_clear',
      p_user_id,
      p_user_id,
      'avatars',
      v_path
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'cleanup_status', case when v_job_id is null then 'completed' else 'pending' end
  );
end;
$$;
revoke all on function public.request_avatar_clear(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_avatar_clear(uuid)
  to service_role;

create or replace function public.request_avatar_replace(
  p_user_id uuid,
  p_path text,
  p_public_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_existing public.storage_object_cleanup_jobs%rowtype;
  v_old_path text;
  v_job_id uuid;
begin
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_profile.deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_public_url, '')) > 2048
     or public.bp_account_cleanup_storage_path(
          p_public_url, 'avatars'
        ) is distinct from p_path then
    raise exception 'invalid_upload_intent' using errcode = 'P0001';
  end if;

  -- The upload path is the replace operation's stable identity. If the first
  -- transaction committed but its response was lost, replay the outstanding
  -- old-object receipt. Avoid a no-op profile UPDATE/version bump as well.
  if v_profile.avatar_url = p_public_url then
    select *
      into v_existing
      from public.storage_object_cleanup_jobs j
     where j.kind = 'avatar_replace'
       and j.user_id = p_user_id
       and j.subject_id = p_user_id
       and j.status in ('pending', 'leased')
     order by j.created_at desc, j.id desc
     limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'job_id', v_existing.id,
        'cleanup_status', v_existing.status
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', null,
      'cleanup_status', 'completed'
    );
  end if;

  perform public.bp_attach_owned_storage_upload_intent(
    p_user_id,
    null,
    'avatar_upload',
    'avatars',
    p_path,
    true
  );

  v_old_path := public.bp_account_cleanup_storage_path(
    v_profile.avatar_url,
    'avatars'
  );
  update public.profiles
     set avatar_url = p_public_url
   where id = p_user_id;

  if v_old_path is not null
     and v_old_path <> p_path
     and v_old_path like (p_user_id::text || '/%') then
    v_job_id := public.bp_enqueue_detached_storage_asset(
      'avatar_replace',
      p_user_id,
      p_user_id,
      'avatars',
      v_old_path
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'cleanup_status',
      case when v_job_id is null then 'completed' else 'pending' end
  );
end;
$$;
revoke all on function public.request_avatar_replace(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_avatar_replace(uuid, text, text)
  to service_role;

create or replace function public.request_expired_highlight_cleanup(
  p_limit int default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_processed int := 0;
  v_jobs int := 0;
  v_job_id uuid;
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 500));
begin
  for v_row in
    select sh.score_id, sh.highlight_clip_path, s.owner_id
      from public.score_highlights sh
      join public.scores s on s.id = sh.score_id
     where sh.highlight_expires_at < clock_timestamp()
       and sh.highlight_deleted_at is null
     order by sh.highlight_expires_at, sh.score_id
     limit v_limit
     for update of sh skip locked
  loop
    update public.score_highlights
       set highlight_deleted_at = clock_timestamp()
     where score_id = v_row.score_id;
    v_processed := v_processed + 1;
    if v_row.highlight_clip_path is not null then
      v_job_id := public.bp_enqueue_detached_storage_asset(
        'highlight_expired',
        v_row.owner_id,
        v_row.score_id,
        'highlights',
        v_row.highlight_clip_path
      );
      if v_job_id is not null then
        v_jobs := v_jobs + 1;
      end if;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'processed', v_processed, 'jobs', v_jobs);
end;
$$;
revoke all on function public.request_expired_highlight_cleanup(int)
  from public, anon, authenticated, service_role;
grant execute on function public.request_expired_highlight_cleanup(int)
  to service_role;

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
  v_seconds int := greatest(15, least(coalesce(p_lease_seconds, 120), 600));
begin
  with candidate as (
    select j.id
      from public.storage_object_cleanup_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and not public.bp_storage_path_is_referenced(j.bucket, j.path)
       and (
         (j.status = 'pending' and j.next_attempt_at <= clock_timestamp())
         or (j.status = 'leased' and j.leased_until <= clock_timestamp())
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

create or replace function public.finish_storage_object_cleanup(
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
  v_job public.storage_object_cleanup_jobs%rowtype;
  v_delay int;
begin
  select *
    into v_job
    from public.storage_object_cleanup_jobs
   where id = p_job_id
     and status = 'leased'
     and lease_token = p_lease_token
     and lease_version = p_lease_version
     and leased_until > clock_timestamp()
   for update;
  if not found then
    raise exception 'cleanup_lease_lost' using errcode = 'P0001';
  end if;

  if p_success then
    update public.storage_object_cleanup_jobs
       set status = 'completed',
           lease_token = null,
           leased_until = null,
           last_error = null,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'job_id', p_job_id,
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
  update public.storage_object_cleanup_jobs
     set status = 'pending',
         lease_token = null,
         leased_until = null,
         last_error = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_error), ''), 'cleanup_failed'),
           1000
         ),
         next_attempt_at =
           clock_timestamp() + pg_catalog.make_interval(secs => v_delay),
         updated_at = clock_timestamp()
   where id = v_job.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'job_id', p_job_id,
    'lease_token', p_lease_token,
    'lease_version', p_lease_version,
    'status', 'pending',
    'retry_in_seconds', v_delay
  );
end;
$$;
revoke all on function public.finish_storage_object_cleanup(
  uuid, uuid, int, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_storage_object_cleanup(
  uuid, uuid, int, boolean, text
) to service_role;

-- ── 3. Account lifecycle serialization and atomic OAuth seed ────────────────
-- Deletion, consent, profile seed and callback email sync all lock in one
-- global order: profiles -> member_accounts. A consent/profile write either
-- commits before deletion and is scrubbed by it, or observes deleted_at and
-- fails. No delayed request can resurrect PII or consent after deletion.
create or replace function public.bp_create_or_update_member_consent_locked(
  p_user_id uuid,
  p_bonus int,
  p_set_age boolean,
  p_set_terms boolean,
  p_terms_ver int,
  p_set_privacy boolean,
  p_privacy_ver int,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_now timestamptz := clock_timestamp();
  v_rows int;
  v_bonus int := greatest(coalesce(p_bonus, 0), 0);
  v_name text := nullif(pg_catalog.btrim(p_display_name), '');
  v_avatar text := nullif(pg_catalog.btrim(p_avatar_url), '');
  v_email text := nullif(pg_catalog.btrim(p_email), '');
  v_current_legal_version int;
begin
  -- Match admin legal mutation lock order (terms -> privacy). The version is
  -- re-read inside this transaction so publish/rollback cannot occur between
  -- HTTP comparison and the persisted consent stamp.
  if p_set_terms then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('legal:terms', 0::bigint)
    );
    select l.version
      into v_current_legal_version
      from public.legal_documents l
     where l.doc_type = 'terms'
       and l.status = 'published'
       and l.effective_date <= (
         clock_timestamp() at time zone 'Asia/Seoul'
       )::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1;
    if not found
       or v_current_legal_version is distinct from p_terms_ver then
      raise exception 'legal_version_changed' using errcode = 'P0001';
    end if;
  end if;
  if p_set_privacy then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('legal:privacy', 0::bigint)
    );
    select l.version
      into v_current_legal_version
      from public.legal_documents l
     where l.doc_type = 'privacy'
       and l.status = 'published'
       and l.effective_date <= (
         clock_timestamp() at time zone 'Asia/Seoul'
       )::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1;
    if not found
       or v_current_legal_version is distinct from p_privacy_ver then
      raise exception 'legal_version_changed' using errcode = 'P0001';
    end if;
  end if;

  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found or v_profile.deleted_at is not null then
    raise exception 'invalid_account' using errcode = 'P0001';
  end if;

  if v_name is not null and char_length(v_name) > 12 then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;
  if v_avatar is not null and char_length(v_avatar) > 2048 then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;
  if v_email is not null
     and (
       char_length(v_email) > 320
       or v_email like 'deleted+%@deleted.invalid'
     ) then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;

  -- Existing rows are locked after the profile. The insert path remains fenced
  -- by the profile lock and the member PK unique constraint.
  perform 1
    from public.member_accounts
   where user_id = p_user_id
   for update;

  insert into public.member_accounts(
    user_id,
    gen_credits,
    email,
    age_confirmed_at,
    terms_agreed_at,
    terms_version,
    privacy_agreed_at,
    privacy_version
  )
  values (
    p_user_id,
    v_bonus,
    v_email,
    case when p_set_age then v_now else null end,
    case when p_set_terms then v_now else null end,
    case when p_set_terms then p_terms_ver else null end,
    case when p_set_privacy then v_now else null end,
    case when p_set_privacy then p_privacy_ver else null end
  )
  on conflict (user_id) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    if v_bonus > 0 then
      insert into public.credit_lots(
        user_id, source, order_uuid, qty, granted_at, expires_at
      )
      values (
        p_user_id,
        'signup_bonus',
        null,
        v_bonus,
        v_now,
        v_now + interval '1 year'
      );
    end if;
  else
    update public.member_accounts
       set age_confirmed_at =
             case
               when p_set_age and age_confirmed_at is null then v_now
               else age_confirmed_at
             end,
           terms_agreed_at =
             case when p_set_terms then v_now else terms_agreed_at end,
           terms_version =
             case when p_set_terms then p_terms_ver else terms_version end,
           privacy_agreed_at =
             case when p_set_privacy then v_now else privacy_agreed_at end,
           privacy_version =
             case
               when p_set_privacy then p_privacy_ver
               else privacy_version
             end,
           email = coalesce(v_email, email),
           reconsent_required = false,
           updated_at = v_now
     where user_id = p_user_id;
  end if;

  if v_name is not null or v_avatar is not null then
    update public.profiles
       set display_name = coalesce(v_name, display_name),
           avatar_url = coalesce(v_avatar, avatar_url)
     where id = p_user_id;
  end if;

  return v_rows > 0;
end;
$$;
revoke all on function public.bp_create_or_update_member_consent_locked(
  uuid, int, boolean, boolean, int, boolean, int, text, text, text
) from public, anon, authenticated, service_role;

-- Preserve the established signature for internal reviewer provisioning while
-- fixing its active-profile TOCTOU.
create or replace function public.create_or_update_member_consent(
  p_user_id uuid,
  p_bonus int,
  p_set_age boolean,
  p_set_terms boolean,
  p_terms_ver int,
  p_set_privacy boolean,
  p_privacy_ver int
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select public.bp_create_or_update_member_consent_locked(
    p_user_id,
    p_bonus,
    p_set_age,
    p_set_terms,
    p_terms_ver,
    p_set_privacy,
    p_privacy_ver,
    null,
    null,
    null
  );
$$;
revoke all on function public.create_or_update_member_consent(
  uuid, int, boolean, boolean, int, boolean, int
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_update_member_consent(
  uuid, int, boolean, boolean, int, boolean, int
) to service_role;

-- New-member consent and OAuth profile/email seed share one DB transaction.
-- A failure cannot leave a permanently half-seeded member.
create or replace function public.create_or_update_member_consent_with_profile(
  p_user_id uuid,
  p_bonus int,
  p_set_age boolean,
  p_set_terms boolean,
  p_terms_ver int,
  p_set_privacy boolean,
  p_privacy_ver int,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select public.bp_create_or_update_member_consent_locked(
    p_user_id,
    p_bonus,
    p_set_age,
    p_set_terms,
    p_terms_ver,
    p_set_privacy,
    p_privacy_ver,
    p_display_name,
    p_avatar_url,
    p_email
  );
$$;
revoke all on function public.create_or_update_member_consent_with_profile(
  uuid, int, boolean, boolean, int, boolean, int, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_or_update_member_consent_with_profile(
  uuid, int, boolean, boolean, int, boolean, int, text, text, text
) to service_role;

-- Existing-member callback sync uses the same lifecycle fence. Callers must
-- surface failure; a successful redirect can never hide a post-delete write.
create or replace function public.sync_active_member_oauth_profile(
  p_user_id uuid,
  p_display_name text,
  p_avatar_url text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_name text := nullif(pg_catalog.btrim(p_display_name), '');
  v_avatar text := nullif(pg_catalog.btrim(p_avatar_url), '');
  v_email text := nullif(pg_catalog.btrim(p_email), '');
begin
  select *
    into v_profile
    from public.profiles
   where id = p_user_id
   for update;
  if not found or v_profile.deleted_at is not null then
    raise exception 'invalid_account' using errcode = 'P0001';
  end if;
  if v_name is not null and char_length(v_name) > 12
     or v_avatar is not null and char_length(v_avatar) > 2048
     or v_email is not null
        and (
          char_length(v_email) > 320
          or v_email like 'deleted+%@deleted.invalid'
        ) then
    raise exception 'invalid_profile_seed' using errcode = 'P0001';
  end if;

  perform 1
    from public.member_accounts
   where user_id = p_user_id
   for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  update public.profiles
     set display_name = coalesce(v_name, display_name),
         avatar_url = coalesce(v_avatar, avatar_url)
   where id = p_user_id;
  update public.member_accounts
     set email = coalesce(v_email, email),
         updated_at = clock_timestamp()
   where user_id = p_user_id;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.sync_active_member_oauth_profile(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.sync_active_member_oauth_profile(
  uuid, text, text, text
) to service_role;

-- Scrub consent evidence at the deletion transition itself. This trigger runs
-- while the profile row is locked and therefore uses the same profile->member
-- order as every consent/profile writer.
create or replace function public.bp_scrub_member_consent_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.member_accounts
       set email = null,
           reconsent_required = true,
           terms_agreed_at = null,
           terms_version = null,
           privacy_agreed_at = null,
           privacy_version = null,
           updated_at = clock_timestamp()
     where user_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.bp_scrub_member_consent_on_delete()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_profiles_scrub_member_consent_on_delete
  on public.profiles;
create trigger trg_profiles_scrub_member_consent_on_delete
  after update of deleted_at on public.profiles
  for each row execute function public.bp_scrub_member_consent_on_delete();

do $$
begin
  if not (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.storage_upload_intents'::regclass
  )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid = 'public.storage_object_cleanup_jobs'::regclass
     )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid =
          'public.storage_legacy_upload_sweep_control'::regclass
     )
     or not (
       select c.relrowsecurity
         from pg_catalog.pg_class c
        where c.oid =
          'public.storage_legacy_upload_protections'::regclass
     )
  then
    raise exception '0079 postflight: cleanup tables RLS disabled';
  end if;
  if pg_catalog.has_table_privilege(
       'service_role',
       'public.storage_upload_intents',
       'SELECT')
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.storage_object_cleanup_jobs',
       'SELECT')
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.storage_legacy_upload_sweep_control',
       'SELECT')
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.storage_legacy_upload_protections',
       'SELECT')
  then
    raise exception '0079 postflight: cleanup tables must be RPC-only';
  end if;
  if not pg_catalog.has_table_privilege(
       'authenticated', 'public.dolls', 'DELETE')
     or not exists (
       select 1
         from pg_catalog.pg_policy p
        where p.polrelid = 'public.dolls'::regclass
          and p.polcmd = 'd'
     )
  then
    raise exception '0079 postflight: rolling owner DELETE compatibility missing';
  end if;
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.create_admin_storage_upload_intent(uuid,text,text,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.confirm_admin_storage_upload_intent(uuid,text,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.request_doll_delete(uuid,uuid)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.request_avatar_clear(uuid)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.request_avatar_replace(uuid,text,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.create_avatar_upload_intent(uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.confirm_avatar_upload_intent(uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.create_highlight_upload_intent(uuid,uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.confirm_highlight_upload_intent(uuid,uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.create_doll_upload_intent(uuid,uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_storage_upload_cleanup(integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finish_storage_upload_cleanup(uuid,uuid,integer,boolean,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_storage_object_cleanup(uuid,integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finish_storage_object_cleanup(uuid,uuid,integer,boolean,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.request_expired_highlight_cleanup(integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.request_doll_role_update(uuid,uuid,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.sync_active_member_oauth_profile(uuid,text,text,text)',
       'EXECUTE')
  then
    raise exception '0079 postflight: service RPC grant missing';
  end if;
  if pg_catalog.has_function_privilege(
       'anon',
       'public.create_admin_storage_upload_intent(uuid,text,text,text)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.request_doll_delete(uuid,uuid)',
       'EXECUTE')
  then
    raise exception '0079 postflight: client RPC access leaked';
  end if;
end;
$$;

insert into public.schema_migration_journal (
  version, migration_hash, manifest_hash, app_commit
) values ('0079_storage_cleanup_intents', null, null, null)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
