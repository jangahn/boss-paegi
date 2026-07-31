-- 008900 public write quota boundaries. True cross-session races are covered by
-- scripts/qa/test-public-write-quota-races.sh.

begin;
select plan(44);

select has_table(
  'public',
  'public_write_quota_buckets',
  'short-lived public write quota table exists'
);
select ok(
  (
    select c.relrowsecurity
      from pg_catalog.pg_class c
     where c.oid = 'public.public_write_quota_buckets'::regclass
  ),
  'quota table has RLS enabled'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.public_write_quota_buckets',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.public_write_quota_buckets',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.public_write_quota_buckets',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'quota counters are inaccessible to every Data API role'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_consume_public_write_quota(text,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.bp_consume_public_write_quota(text,text,boolean)',
    'EXECUTE'
  ),
  'quota primitive is private to SECURITY DEFINER wrappers'
);
select ok(
  coalesce(
    (
      select i.indisvalid
         and i.indisready
         and not i.indisunique
         and i.indpred is null
         and i.indexprs is null
         and am.amname = 'btree'
         and (
           select pg_catalog.array_agg(a.attname order by k.ordinality)
             from pg_catalog.unnest(i.indkey) with ordinality
                    as k(attnum, ordinality)
             join pg_catalog.pg_attribute a
               on a.attrelid = i.indrelid
              and a.attnum = k.attnum
         ) = array['day_kst', 'endpoint', 'actor_key']::name[]
        from pg_catalog.pg_index i
        join pg_catalog.pg_class idx on idx.oid = i.indexrelid
        join pg_catalog.pg_am am on am.oid = idx.relam
       where i.indexrelid =
         pg_catalog.to_regclass(
           'public.public_write_quota_retention_idx'
         )
    ),
    false
  ),
  'retention lookup has an exact valid day-leading btree index'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)',
    'EXECUTE'
  ),
  'unbounded telemetry core is not a Data API RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.ingest_telemetry_delta(uuid,uuid,boolean,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)',
    'EXECUTE'
  ),
  'contract exposes only new bounded telemetry while legacy stays internal'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_public_analytics_event(text,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.record_public_analytics_event(text,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.record_public_analytics_event(text,text,jsonb)',
    'EXECUTE'
  ),
  'bounded analytics insert is callable only by the server route'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.prune_public_write_quota_buckets(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.prune_public_write_quota_buckets(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.prune_public_write_quota_buckets(integer)',
    'EXECUTE'
  ),
  'scheduled opaque-actor retention is callable only by the server cron'
);
select is(
  (
    select count(*)::integer
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'ingest_telemetry_delta'
  ),
  2,
  'telemetry exposes exactly the bounded new and rolling-old overloads'
);
select ok(
  not exists (
    select 1
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'public_write_quota_buckets'
       and c.column_name in (
         'ip', 'ip_address', 'user_id', 'session_id', 'auth_subject'
       )
  ),
  'quota storage has no raw IP, Auth subject, or session identifier column'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.analytics_events',
    'INSERT'
  ),
  'service role cannot bypass bounded analytics with direct INSERT'
);

create temp table public_write_quota_ctx (
  member_id uuid not null,
  actor_key text not null,
  other_actor_key text not null,
  session_a uuid not null,
  session_b uuid not null,
  session_c uuid not null,
  session_d uuid not null,
  track_actor_ack jsonb,
  track_actor_block jsonb,
  track_global_ack jsonb,
  track_global_block jsonb,
  telemetry_ack jsonb,
  telemetry_block jsonb
) on commit drop;

insert into public_write_quota_ctx values (
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  '93000000-0000-4000-8000-000000000011',
  '93000000-0000-4000-8000-000000000012',
  '93000000-0000-4000-8000-000000000013',
  '93000000-0000-4000-8000-000000000014',
  null, null, null, null, null, null
);

insert into auth.users(id, email)
select member_id, 'public-write-quota@test.local'
  from public_write_quota_ctx;
insert into public.member_accounts(user_id, email)
select member_id, 'public-write-quota@test.local'
  from public_write_quota_ctx;

delete from public.public_write_quota_buckets
 where day_kst <= (
   pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
 )::date;
delete from public.analytics_events
 where kind = 'share'
   and surface in ('gallery', 'history')
   and target in ('doll', 'highlight');
update public.telemetry_budget
   set degrade_mode = 'full',
       over_budget = false,
       new_sessions_today = 0,
       day_kst = (
         pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
       )::date
 where id = true;

select is(
  (
    public.record_public_analytics_event(
      'not-a-digest',
      'anon',
      '{"kind":"share","surface":"gallery","target":"doll","score_tier":null,"result":"attempt"}'::jsonb
    )->>'reason'
  ),
  'invalid_actor',
  'invalid opaque actor is dropped before analytics insert'
);
select is(
  (
    select count(*)::integer
      from public.public_write_quota_buckets
  ),
  0,
  'invalid opaque actor cannot allocate a quota row'
);
select is(
  (
    public.record_public_analytics_event(
      pg_catalog.repeat('a', 64),
      'anon',
      '{"kind":"conversion","conversion_step":"play","source_scope":"first_touch","source_kind":"direct","source_value":"direct","referrer_domain":null,"utm_source":null,"utm_medium":null,"utm_campaign":null,"viral_type":null}'::jsonb
    )->>'accepted'
  ),
  'true',
  'server conversion uses the same bounded analytics RPC'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from public.analytics_events
     where kind = 'conversion'
       and conversion_step = 'play'
       and source_kind = 'direct'
  ),
  1,
  'bounded conversion creates exactly one analytics event'
);
delete from public.analytics_events
 where kind = 'conversion'
   and conversion_step = 'play'
   and source_kind = 'direct';
delete from public.public_write_quota_buckets where endpoint = 'track';

insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
select 'track',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       'global',
       0
union all
select 'track',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       actor_key,
       199
  from public_write_quota_ctx;

update public_write_quota_ctx c
   set track_actor_ack = public.record_public_analytics_event(
         c.actor_key,
         'anon',
         '{"kind":"share","surface":"gallery","target":"doll","score_tier":null,"result":"attempt"}'::jsonb
       );
update public_write_quota_ctx c
   set track_actor_block = public.record_public_analytics_event(
         c.actor_key,
         'anon',
         '{"kind":"share","surface":"gallery","target":"doll","score_tier":null,"result":"attempt"}'::jsonb
       );
select is(
  (select track_actor_ack->>'accepted' from public_write_quota_ctx),
  'true',
  'track actor boundary request is inserted'
);
select is(
  (select track_actor_block->>'reason' from public_write_quota_ctx),
  'actor_request_quota',
  'track actor request over the exact boundary is dropped'
);
select is(
  (
    select count(*)::integer
      from public.analytics_events
     where kind = 'share'
       and surface = 'gallery'
       and target = 'doll'
  ),
  1,
  'track actor quota and event insert commit atomically exactly once'
);
select ok(
  exists (
    select 1
      from public.public_write_quota_buckets q
      join public_write_quota_ctx c on c.actor_key = q.actor_key
     where q.endpoint = 'track'
       and q.request_count = 2000000
  )
  and exists (
    select 1
      from public.public_write_quota_buckets q
     where q.endpoint = 'track'
       and q.actor_key = 'global'
       and q.request_count = 1
  ),
  'actor rejection leaves both counters at their exact committed values'
);

delete from public.public_write_quota_buckets where endpoint = 'track';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
select 'track',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       'global',
       1999;
update public_write_quota_ctx c
   set track_global_ack = public.record_public_analytics_event(
         c.other_actor_key,
         'member',
         '{"kind":"share","surface":"history","target":"highlight","score_tier":null,"result":"attempt"}'::jsonb
       );
update public_write_quota_ctx c
   set track_global_block = public.record_public_analytics_event(
         c.actor_key,
         'member',
         '{"kind":"share","surface":"history","target":"highlight","score_tier":null,"result":"attempt"}'::jsonb
       );
select is(
  (select track_global_ack->>'accepted' from public_write_quota_ctx),
  'true',
  'track global boundary request is inserted'
);
select is(
  (select track_global_block->>'reason' from public_write_quota_ctx),
  'global_request_quota',
  'track request over the exact global boundary is dropped'
);
select is(
  (
    select count(*)::integer
      from public.analytics_events
     where kind = 'share'
       and surface = 'history'
       and target = 'highlight'
  ),
  1,
  'global quota admits exactly one boundary event'
);
select ok(
  exists (
    select 1
      from public.public_write_quota_buckets q
     where q.endpoint = 'track'
       and q.actor_key = 'global'
       and q.request_count = 20000000
  )
  and not exists (
    select 1
      from public.public_write_quota_buckets q
      join public_write_quota_ctx c on c.actor_key = q.actor_key
     where q.endpoint = 'track'
  ),
  'global rejection happens before a random actor can allocate another row'
);

delete from public.public_write_quota_buckets where endpoint = 'telemetry';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count, new_session_count
)
select 'telemetry',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       'global',
       0,
       0
union all
select 'telemetry',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       actor_key,
       0,
       29
  from public_write_quota_ctx;

update public_write_quota_ctx c
   set telemetry_ack = public.ingest_telemetry_delta(
         c.session_a,
         c.member_id,
         true,
         c.actor_key,
         '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":1000,"totals":{"score":1,"hitCount":1}},"events":[]}'::jsonb
       );
update public_write_quota_ctx c
   set telemetry_block = public.ingest_telemetry_delta(
         c.session_b,
         c.member_id,
         true,
         c.actor_key,
         '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":1000,"totals":{"score":1,"hitCount":1}},"events":[]}'::jsonb
       );
select is(
  (select telemetry_ack->>'ok' from public_write_quota_ctx),
  'true',
  'telemetry actor new-session boundary is ingested'
);
select is(
  (select telemetry_block->>'reason' from public_write_quota_ctx),
  'actor_new_session_quota',
  'random telemetry session over actor boundary receives terminal off ack'
);
select is(
  (
    select count(*)::integer
      from public.telemetry_sessions t
      join public_write_quota_ctx c
        on t.id in (c.session_a, c.session_b)
  ),
  1,
  'blocked random session cannot allocate a telemetry row'
);
select ok(
  exists (
    select 1
      from public.public_write_quota_buckets q
      join public_write_quota_ctx c on c.actor_key = q.actor_key
     where q.endpoint = 'telemetry'
       and q.request_count = 1
       and q.new_session_count = 3000
  )
  and exists (
    select 1
      from public.public_write_quota_buckets q
     where q.endpoint = 'telemetry'
       and q.actor_key = 'global'
       and q.request_count = 1
       and q.new_session_count = 1
  ),
  'new-session boundary increments actor and global counters exactly once'
);

select is(
  (
    select public.ingest_telemetry_delta(
      c.session_a,
      c.member_id,
      true,
      c.actor_key,
      '{"deviceClass":"desktop-pointer","summary":{"seqHigh":2,"durationMs":1100,"totals":{"score":2,"hitCount":2}},"events":[]}'::jsonb
    )->>'ok'
      from public_write_quota_ctx c
  ),
  'true',
  'existing legitimate session can finish after new-session quota is full'
);
select ok(
  exists (
    select 1
      from public.public_write_quota_buckets q
      join public_write_quota_ctx c on c.actor_key = q.actor_key
     where q.endpoint = 'telemetry'
       and q.request_count = 2
       and q.new_session_count = 3000
  ),
  'existing session consumes only request quota'
);

update public.telemetry_sessions t
   set write_count = 40000
  from public_write_quota_ctx c
 where t.id = c.session_a;
select is(
  (
    select public.ingest_telemetry_delta(
      c.session_a,
      c.member_id,
      true,
      c.actor_key,
      '{"summary":{"seqHigh":3},"events":[]}'::jsonb
    )->>'reason'
      from public_write_quota_ctx c
  ),
  'session_quota',
  'one session hard-stops after 40000 committed writes'
);
select is(
  (
    select q.request_count
      from public.public_write_quota_buckets q
      join public_write_quota_ctx c on c.actor_key = q.actor_key
     where q.endpoint = 'telemetry'
  ),
  2,
  'session hard-stop does not consume another actor request unit'
);

delete from public.public_write_quota_buckets where endpoint = 'telemetry';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count, new_session_count
)
select 'telemetry',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       'global',
       0,
       200000;
select is(
  (
    select public.ingest_telemetry_delta(
      c.session_c,
      c.member_id,
      true,
      c.actor_key,
      '{"summary":{"seqHigh":9},"events":[]}'::jsonb
    )->>'reason'
      from public_write_quota_ctx c
  ),
  'global_new_session_quota',
  'global new-session cap is an exact hard boundary'
);
select ok(
  not exists (
    select 1
      from public.telemetry_sessions t
      join public_write_quota_ctx c on t.id = c.session_c
  )
  and not exists (
    select 1
      from public.public_write_quota_buckets q
      join public_write_quota_ctx c on q.actor_key = c.actor_key
     where q.endpoint = 'telemetry'
  ),
  'global new-session rejection creates neither session nor actor row'
);

update public.public_write_quota_buckets
   set request_count = 5000000,
       new_session_count = 0
 where endpoint = 'telemetry'
   and actor_key = 'global';
select is(
  (
    select public.ingest_telemetry_delta(
      c.session_c,
      c.member_id,
      true,
      c.actor_key,
      '{"summary":{"seqHigh":10},"events":[]}'::jsonb
    )->>'reason'
      from public_write_quota_ctx c
  ),
  'global_request_quota',
  'global telemetry request cap is an exact hard boundary'
);
select is(
  (
    select request_count
      from public.public_write_quota_buckets
     where endpoint = 'telemetry'
       and actor_key = 'global'
  ),
  5000000,
  'rejected global request never overflows its counter'
);

delete from public.public_write_quota_buckets where endpoint = 'telemetry';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count, new_session_count
)
select 'telemetry',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       'global',
       0,
       0
union all
select 'telemetry',
       (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
       pg_catalog.encode(
         extensions.digest(
           pg_catalog.convert_to(
             'legacy:' || member_id::text,
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ),
       0,
       3000
  from public_write_quota_ctx;
select is(
  (
    select public.ingest_telemetry_delta(
      c.session_d,
      c.member_id,
      true,
      '{"summary":{"seqHigh":1},"events":[]}'::jsonb
    )->>'reason'
      from public_write_quota_ctx c
  ),
  'actor_new_session_quota',
  'rolling-old four-argument telemetry protocol is also actor-bounded'
);
select ok(
  not exists (
    select 1
      from public.telemetry_sessions t
      join public_write_quota_ctx c on t.id = c.session_d
  ),
  'bounded rolling-old protocol cannot allocate an over-quota row'
);

delete from public.public_write_quota_buckets where endpoint = 'track';
delete from public.public_write_attempts where endpoint = 'score';
insert into public.public_write_attempts(
  endpoint,
  operation_key,
  request_fingerprint,
  day_kst
)
select
  'score',
  pg_catalog.md5('stale-attempt-' || g::text)
    || pg_catalog.md5('stale-attempt-' || g::text),
  pg_catalog.md5('stale-fingerprint-' || g::text)
    || pg_catalog.md5('stale-fingerprint-' || g::text),
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date - 3
from pg_catalog.generate_series(1, 100) g;
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
select
  'track',
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date - 3,
  pg_catalog.md5('stale-quota-' || g::text)
    || pg_catalog.md5('stale-quota-' || g::text),
  1
from pg_catalog.generate_series(1, 300) g;
with result as (
  select public.prune_public_write_quota_buckets(256) ack
)
select ok(
  (select
     ack->>'ok' = 'true'
     and (ack->>'deleted')::integer = 256
     and ack->>'done' = 'false'
     and ack->>'cutoff' = (
       (
         pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
       )::date - 2
     )::text
   from result),
  'scheduled retention deletes one exact bounded batch and reports backlog'
);
select is(
  (
    (select pg_catalog.count(*)::integer
       from public.public_write_quota_buckets q
      where q.day_kst < (
        pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
      )::date - 2)
    +
    (select pg_catalog.count(*)::integer
       from public.public_write_attempts a
      where a.day_kst < (
        pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
      )::date - 2)
  ),
  144,
  'first retention batch prioritizes attempts and never exceeds its limit'
);
with result as (
  select public.prune_public_write_quota_buckets(256) ack
)
select ok(
  (select
     ack->>'ok' = 'true'
     and (ack->>'deleted')::integer = 144
     and ack->>'done' = 'true'
   from result),
  'next scheduled retention batch reports exact convergence'
);
select is(
  (
    (select pg_catalog.count(*)::integer
       from public.public_write_quota_buckets q
      where q.day_kst < (
        pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
      )::date - 2)
    +
    (select pg_catalog.count(*)::integer
       from public.public_write_attempts a
      where a.day_kst < (
        pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
      )::date - 2)
  ),
  0,
  'scheduled retention removes stale counters and attempts without traffic'
);

select ok(
  (
    select bool_and(
      q.actor_key = 'global'
      or q.actor_key ~ '^[0-9a-f]{64}$'
    )
      from public.public_write_quota_buckets q
  ),
  'every persisted actor is only a fixed-size opaque digest'
);
select ok(
  (
    select p.prosecdef
       and coalesce(p.proconfig, '{}'::text[]) @> array[
             'search_path=""',
             'lock_timeout=250ms'
           ]
       and not exists (
         select 1
           from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) c
          where c like 'statement_timeout=%'
       )
      from pg_catalog.pg_proc p
     where p.oid =
       'public.record_public_analytics_event(text,text,jsonb)'::regprocedure
  )
  and (
    select p.prosecdef
       and coalesce(p.proconfig, '{}'::text[]) @> array[
             'search_path=""',
             'lock_timeout=250ms'
           ]
       and not exists (
         select 1
           from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) c
          where c like 'statement_timeout=%'
       )
      from pg_catalog.pg_proc p
     where p.oid =
       'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)'::regprocedure
  )
  and (
    select p.prosecdef
       and coalesce(p.proconfig, '{}'::text[]) @> array[
             'search_path=""',
             'lock_timeout=250ms'
           ]
       and not exists (
         select 1
           from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) c
          where c like 'statement_timeout=%'
       )
      from pg_catalog.pg_proc p
     where p.oid =
       'public.bp_consume_public_write_quota(text,text,boolean)'::regprocedure
  )
  and (
    select p.prosecdef
       and coalesce(p.proconfig, '{}'::text[]) @> array[
             'search_path=""',
             'lock_timeout=1s'
           ]
       and not exists (
         select 1
           from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) c
          where c like 'statement_timeout=%'
       )
      from pg_catalog.pg_proc p
     where p.oid =
       'public.prune_public_write_quota_buckets(integer)'::regprocedure
  )
  and (
    select coalesce(r.rolconfig, '{}'::text[]) @>
             array['statement_timeout=8s', 'lock_timeout=8s']
      from pg_catalog.pg_roles r
     where r.rolname = 'authenticator'
  ),
  'public write functions pin search_path/lock bounds and inherit the outer 8s PostgREST ceiling'
);

select * from finish();
rollback;
