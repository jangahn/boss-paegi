-- 0097_public_write_quota_relax.sql
--
-- 2026-07-31 제품 오너 결정: QA(008900/008901)가 임의 선정한 공개 쓰기 일일
-- 쿼터가 정상 사용(헤비 플레이·CGNAT 공유 IP·바이럴 트래픽)을 차단하거나
-- 고득점을 자동 보류(S6)로 밀어넣는다. 구조(버킷·원자 소비·감사)는 유지하고
-- 상한만 100배로 완화한다 — 파국적 어뷰징 상한은 남기되 사람은 닿지 않는다.
-- 함수 본문은 008900/008901의 byte-copy에 상한 상수만 바꾼 것이다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

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
      v_global_request_limit := 5000000;
      v_actor_request_limit := 100000;
      v_global_new_session_limit := 200000;
      v_actor_new_session_limit := 3000;
    when 'track' then
      -- Normal acquisition emits two visits/browser and shares are debounced.
      -- 2,000 raw rows/day keeps the 90-day Free-plan retention finite while
      -- still covering roughly 1,000 ordinary new visitors/day.
      v_global_request_limit := 200000;
      v_actor_request_limit := 20000;
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

create or replace function public.bp_consume_report_legacy_write_quota()
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '250ms'
as $$
declare
  c_global_limit integer := 50000;
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
  c_global_limit integer := 50000;
  c_network_limit integer := 2000;
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
  c_global_limit integer := 500000;
  c_network_limit integer := 30000;
  c_owner_limit integer := 10000;
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
    v_global_day_limit := 50000;
    v_actor_day_limit := 1000;
    v_owner_day_limit := 1000;
    v_actor_outstanding_limit := 200;
    v_owner_outstanding_limit := 200;
  elsif p_purpose = 'highlight_upload' then
    v_global_day_limit := 10000;
    v_actor_day_limit := 500;
    v_owner_day_limit := 500;
    v_actor_outstanding_limit := 200;
    v_owner_outstanding_limit := 200;
  else
    v_global_day_limit := 10000;
    v_actor_day_limit := 5000;
    v_owner_day_limit := 5000;
    v_actor_outstanding_limit := 500;
    v_owner_outstanding_limit := 500;
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
  c_global_unit_limit integer := 1000000;
  c_actor_unit_limit integer := 100000;
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
  c_max_session_writes integer := 40000;
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

notify pgrst, 'reload schema';
commit;
