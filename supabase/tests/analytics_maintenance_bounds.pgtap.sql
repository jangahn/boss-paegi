-- analytics_maintenance_bounds.pgtap.sql — 0095 destructive maintenance
-- argument validation and exact KST-day boundary behavior.
--
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(50);

-- ── Catalog and ACL boundary ──────────────────────────────────────────────

select ok(
  has_function_privilege(
    'service_role',
    'public.telemetry_rollup_days(integer)',
    'EXECUTE'
  ),
  'service role can rebuild bounded telemetry rollups'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.maintain_analytics_rollups(integer)',
    'EXECUTE'
  ),
  'service role can rebuild bounded acquisition rollups'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.prune_analytics_events(integer)',
    'EXECUTE'
  ),
  'service role can run bounded acquisition retention'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.telemetry_rollup_days(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.telemetry_rollup_days(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.maintain_analytics_rollups(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.maintain_analytics_rollups(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.prune_analytics_events(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.prune_analytics_events(integer)',
    'EXECUTE'
  ),
  'browser roles cannot invoke destructive maintenance'
);

select ok(
  (
    select count(*) = 3 and bool_and(p.prosecdef)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'telemetry_rollup_days',
        'maintain_analytics_rollups',
        'prune_analytics_events'
      )
  ),
  'all three maintenance functions remain security definer'
);

select ok(
  (
    select count(*) = 3
      and bool_and(
        coalesce(
          p.proconfig @> array['search_path=public']::text[],
          false
        )
      )
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'telemetry_rollup_days',
        'maintain_analytics_rollups',
        'prune_analytics_events'
      )
  ),
  'all three maintenance functions retain their fixed search path'
);

select ok(
  (
    select count(*) = 3
      and bool_and(a.grantee = service_role.oid)
      and bool_and(a.privilege_type = 'EXECUTE')
      and bool_and(not a.is_grantable)
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        p.proacl,
        pg_catalog.acldefault('f', p.proowner)
      )
    ) a
    cross join lateral (
      select oid
      from pg_catalog.pg_roles
      where rolname = 'service_role'
    ) service_role
    where p.oid = any(array[
      to_regprocedure('public.telemetry_rollup_days(integer)'),
      to_regprocedure('public.maintain_analytics_rollups(integer)'),
      to_regprocedure('public.prune_analytics_events(integer)')
    ])
      and a.grantee <> p.proowner
  ),
  'only service_role has a direct non-owner EXECUTE grant without grant option'
);

select ok(
  (
    with function_source as (
      select pg_catalog.pg_get_functiondef(
        to_regprocedure('public.telemetry_rollup_days(integer)')
      ) as body
    )
    select
      position('if p_days is null' in body) > 0
      and position(
        'pg_catalog.pg_advisory_xact_lock' in body
      ) > position('if p_days is null' in body)
      and position(
        'pg_catalog.hashtext(''telemetry_rollups'')' in body
      ) > position('pg_catalog.pg_advisory_xact_lock' in body)
      and position('for i in 0 .. p_days - 1 loop' in body)
        > position('pg_catalog.hashtext(''telemetry_rollups'')' in body)
    from function_source
  ),
  'telemetry validates before taking its fixed lock and mutating rollups'
);

select ok(
  (
    with function_source as (
      select pg_catalog.pg_get_functiondef(
        to_regprocedure('public.maintain_analytics_rollups(integer)')
      ) as body
    )
    select
      position('if p_days is null' in body) > 0
      and position(
        'pg_catalog.pg_advisory_xact_lock' in body
      ) > position('if p_days is null' in body)
      and position(
        'pg_catalog.hashtext(''analytics_rollups'')' in body
      ) > position('pg_catalog.pg_advisory_xact_lock' in body)
      and position('for i in 0 .. p_days - 1 loop' in body)
        > position('pg_catalog.hashtext(''analytics_rollups'')' in body)
    from function_source
  ),
  'analytics rebuild validates before taking its shared lock and mutating rollups'
);

select ok(
  (
    with function_source as (
      select pg_catalog.pg_get_functiondef(
        to_regprocedure('public.prune_analytics_events(integer)')
      ) as body
    )
    select
      position('if p_retention_days is null' in body) > 0
      and position(
        'pg_catalog.pg_advisory_xact_lock' in body
      ) > position('if p_retention_days is null' in body)
      and position(
        'pg_catalog.hashtext(''analytics_rollups'')' in body
      ) > position('pg_catalog.pg_advisory_xact_lock' in body)
      and position('v_cutoff := v_today - p_retention_days' in body)
        > position('pg_catalog.hashtext(''analytics_rollups'')' in body)
    from function_source
  ),
  'analytics pruning validates before taking the rebuild lock and computing its cutoff'
);

-- ── Telemetry rollup arguments: valid 1..31 ───────────────────────────────

insert into public.telemetry_rollups(
  day_kst,
  dim_type,
  dim_key,
  sessions
)
values (
  (now() at time zone 'Asia/Seoul')::date,
  'qa_0095_sentinel',
  'invalid_input_must_not_delete',
  77
);

select throws_ok(
  $$select public.telemetry_rollup_days(null::integer)$$,
  '22023',
  'telemetry_rollup_days_invalid_days',
  'telemetry NULL is rejected before DML'
);

select throws_ok(
  $$select public.telemetry_rollup_days('-2147483648'::integer)$$,
  '22023',
  'telemetry_rollup_days_invalid_days',
  'telemetry minimum integer is rejected before subtraction'
);

select throws_ok(
  $$select public.telemetry_rollup_days(-1)$$,
  '22023',
  'telemetry_rollup_days_invalid_days',
  'telemetry negative days are rejected'
);

select throws_ok(
  $$select public.telemetry_rollup_days(0)$$,
  '22023',
  'telemetry_rollup_days_invalid_days',
  'telemetry zero days are rejected'
);

select throws_ok(
  $$select public.telemetry_rollup_days(32)$$,
  '22023',
  'telemetry_rollup_days_invalid_days',
  'telemetry first value above the 31-day recovery bound is rejected'
);

select throws_ok(
  $$select public.telemetry_rollup_days(2147483647)$$,
  '22023',
  'telemetry_rollup_days_invalid_days',
  'telemetry maximum integer is rejected without an unbounded loop'
);

select is(
  (
    select count(*)::integer
    from public.telemetry_rollups
    where dim_type = 'qa_0095_sentinel'
      and dim_key = 'invalid_input_must_not_delete'
      and sessions = 77
  ),
  1,
  'every invalid telemetry argument leaves the preexisting rollup untouched'
);

delete from public.telemetry_rollups
where dim_type = 'qa_0095_sentinel';

insert into public.telemetry_sessions(
  id,
  is_anon,
  device_class,
  started_at,
  end_reason,
  distinct_maps,
  weapon_summary,
  map_summary
)
values (
  gen_random_uuid(),
  true,
  'other',
  now(),
  'normal',
  2,
  '{"qa_0095_weapon":{"hits":2,"score":3,"attempts":4,"switches":5}}',
  '{"qa_0095_map":{"hits":6,"score":7,"attempts":8,"switches":9}}'
);

select is(
  (public.telemetry_rollup_days(1)->>'days')::integer,
  1,
  'telemetry lower bound rebuilds exactly one KST date'
);

select is(
  (public.telemetry_rollup_days()->>'days')::integer,
  3,
  'telemetry omitted argument retains the three-day default'
);

select is(
  (public.telemetry_rollup_days(31)->>'days')::integer,
  31,
  'telemetry upper bound rebuilds the full retained horizon'
);

select is(
  (
    select count(*)::integer
    from public.telemetry_rollups
    where dim_type = 'funnel_step'
      and day_kst between
        (now() at time zone 'Asia/Seoul')::date - 30
        and (now() at time zone 'Asia/Seoul')::date
  ),
  248,
  'telemetry upper bound materializes eight funnel rows for each of 31 dates'
);

select is(
  (
    select row(hits, score, attempts, switches)::text
    from public.telemetry_rollups
    where dim_type = 'weapon'
      and dim_key = 'qa_0095_weapon'
      and day_kst = (now() at time zone 'Asia/Seoul')::date
  ),
  row(2::bigint, 3::bigint, 4::integer, 5::integer)::text,
  'bounded telemetry rebuild preserves weapon aggregation semantics'
);

select is(
  (
    select row(sessions, hits, score, attempts, switches)::text
    from public.telemetry_rollups
    where dim_type = 'map'
      and dim_key = 'qa_0095_map'
      and day_kst = (now() at time zone 'Asia/Seoul')::date
  ),
  row(1::integer, 6::bigint, 7::bigint, 8::integer, 9::integer)::text,
  'bounded telemetry rebuild preserves map aggregation semantics'
);

-- ── Acquisition rollup arguments: valid 1..91 ─────────────────────────────

insert into public.analytics_rollups(
  day_kst,
  metric,
  dim1,
  value
)
values (
  (now() at time zone 'Asia/Seoul')::date,
  'visit_by_source',
  'qa_0095_invalid_sentinel',
  77
);

select throws_ok(
  $$select public.maintain_analytics_rollups(null::integer)$$,
  '22023',
  'maintain_analytics_rollups_invalid_days',
  'analytics rollup NULL is rejected before its advisory lock and DML'
);

select throws_ok(
  $$select public.maintain_analytics_rollups('-2147483648'::integer)$$,
  '22023',
  'maintain_analytics_rollups_invalid_days',
  'analytics rollup minimum integer is rejected before subtraction'
);

select throws_ok(
  $$select public.maintain_analytics_rollups(-1)$$,
  '22023',
  'maintain_analytics_rollups_invalid_days',
  'analytics rollup negative days are rejected'
);

select throws_ok(
  $$select public.maintain_analytics_rollups(0)$$,
  '22023',
  'maintain_analytics_rollups_invalid_days',
  'analytics rollup zero days are rejected'
);

select throws_ok(
  $$select public.maintain_analytics_rollups(92)$$,
  '22023',
  'maintain_analytics_rollups_invalid_days',
  'analytics first value above the 91-date recovery bound is rejected'
);

select throws_ok(
  $$select public.maintain_analytics_rollups(2147483647)$$,
  '22023',
  'maintain_analytics_rollups_invalid_days',
  'analytics maximum integer is rejected without an unbounded loop'
);

select is(
  (
    select count(*)::integer
    from public.analytics_rollups
    where metric = 'visit_by_source'
      and dim1 = 'qa_0095_invalid_sentinel'
      and value = 77
  ),
  1,
  'every invalid analytics rollup argument leaves existing data untouched'
);

delete from public.analytics_rollups
where metric = 'visit_by_source'
  and dim1 = 'qa_0095_invalid_sentinel';

insert into public.analytics_events(
  kind,
  created_at,
  day_kst,
  member_state,
  source_scope,
  source_kind,
  source_value,
  utm_source
)
values (
  'visit',
  now(),
  (now() at time zone 'Asia/Seoul')::date,
  'anon',
  'current',
  'utm',
  'qa_0095',
  'qa_0095'
);

insert into public.analytics_events(
  kind,
  created_at,
  day_kst,
  member_state,
  source_scope,
  source_kind,
  source_value,
  utm_source,
  conversion_step
)
values (
  'conversion',
  now(),
  (now() at time zone 'Asia/Seoul')::date,
  'member',
  'first_touch',
  'utm',
  'qa_0095',
  'qa_0095',
  'play'
);

insert into public.analytics_events(
  kind,
  created_at,
  day_kst,
  member_state,
  surface,
  target,
  score_tier,
  result
)
values (
  'share',
  now(),
  (now() at time zone 'Asia/Seoul')::date,
  'anon',
  'game_over',
  'score',
  9,
  'attempt'
);

select is(
  (public.maintain_analytics_rollups(1)->>'days')::integer,
  1,
  'analytics rollup lower bound rebuilds exactly one KST date'
);

select is(
  (public.maintain_analytics_rollups()->>'days')::integer,
  7,
  'analytics rollup omitted argument retains the seven-day default'
);

select is(
  (public.maintain_analytics_rollups(91)->>'days')::integer,
  91,
  'analytics rollup upper bound rebuilds every retained raw date'
);

select is(
  (
    select count(*)::integer
    from public.analytics_rollups
    where metric in ('share_game_over', 'score_submit', 'play_session')
      and day_kst between
        (now() at time zone 'Asia/Seoul')::date - 90
        and (now() at time zone 'Asia/Seoul')::date
  ),
  273,
  'analytics upper bound materializes three unconditional metrics for 91 dates'
);

select is(
  (
    select value
    from public.analytics_rollups
    where day_kst = (now() at time zone 'Asia/Seoul')::date
      and metric = 'visit_by_source'
      and dim1 = 'current'
      and dim2 = 'utm'
      and dim3 = 'qa_0095'
  ),
  1::bigint,
  'bounded analytics rebuild preserves visit source aggregation semantics'
);

select is(
  (
    select value
    from public.analytics_rollups
    where day_kst = (now() at time zone 'Asia/Seoul')::date
      and metric = 'conversion_play_by_source'
      and dim1 = 'utm'
      and dim2 = 'qa_0095'
  ),
  1::bigint,
  'bounded analytics rebuild preserves conversion aggregation semantics'
);

select is(
  (
    select value
    from public.analytics_rollups
    where day_kst = (now() at time zone 'Asia/Seoul')::date
      and metric = 'share_by_score_tier'
      and dim1 = '9'
  ),
  1::bigint,
  'bounded analytics rebuild preserves share aggregation semantics'
);

-- ── Raw analytics retention arguments: valid 1..90 ────────────────────────

create temporary table analytics_maintenance_bounds_ctx (
  label text primary key,
  event_id uuid not null,
  event_day date not null
) on commit drop;

insert into analytics_maintenance_bounds_ctx(label, event_id, event_day)
values
  (
    'today',
    gen_random_uuid(),
    (now() at time zone 'Asia/Seoul')::date
  ),
  (
    'minimum_boundary',
    gen_random_uuid(),
    (now() at time zone 'Asia/Seoul')::date - 1
  ),
  (
    'minimum_outside',
    gen_random_uuid(),
    (now() at time zone 'Asia/Seoul')::date - 2
  ),
  (
    'maximum_boundary',
    gen_random_uuid(),
    (now() at time zone 'Asia/Seoul')::date - 90
  ),
  (
    'maximum_outside',
    gen_random_uuid(),
    (now() at time zone 'Asia/Seoul')::date - 91
  );

insert into public.analytics_events(
  id,
  kind,
  created_at,
  day_kst,
  member_state,
  source_scope,
  source_kind,
  source_value
)
select
  event_id,
  'visit',
  (event_day::timestamp + interval '12 hours')
    at time zone 'Asia/Seoul',
  event_day,
  'anon',
  'current',
  'direct',
  'direct'
from analytics_maintenance_bounds_ctx;

select throws_ok(
  $$select public.prune_analytics_events(null::integer)$$,
  '22023',
  'prune_analytics_events_invalid_retention_days',
  'analytics retention NULL is rejected before cutoff arithmetic'
);

select throws_ok(
  $$select public.prune_analytics_events('-2147483648'::integer)$$,
  '22023',
  'prune_analytics_events_invalid_retention_days',
  'analytics retention minimum integer is rejected before date overflow'
);

select throws_ok(
  $$select public.prune_analytics_events(-1)$$,
  '22023',
  'prune_analytics_events_invalid_retention_days',
  'negative retention cannot move the deletion cutoff into the future'
);

select throws_ok(
  $$select public.prune_analytics_events(0)$$,
  '22023',
  'prune_analytics_events_invalid_retention_days',
  'zero-day retention is rejected'
);

select throws_ok(
  $$select public.prune_analytics_events(91)$$,
  '22023',
  'prune_analytics_events_invalid_retention_days',
  'retention above the published 90-day privacy envelope is rejected'
);

select throws_ok(
  $$select public.prune_analytics_events(2147483647)$$,
  '22023',
  'prune_analytics_events_invalid_retention_days',
  'analytics retention maximum integer is rejected before date underflow'
);

select is(
  (
    select count(*)::integer
    from public.analytics_events e
    join analytics_maintenance_bounds_ctx c on c.event_id = e.id
  ),
  5,
  'every invalid retention argument leaves all modeled dates untouched'
);

select cmp_ok(
  (public.prune_analytics_events(90)->>'deleted')::integer,
  '>=',
  1,
  'maximum valid retention deletes data older than its cutoff'
);

select is(
  (
    select count(*)::integer
    from public.analytics_events e
    join analytics_maintenance_bounds_ctx c on c.event_id = e.id
    where c.label = 'maximum_outside'
  ),
  0,
  '90-day retention deletes the first date outside its horizon'
);

select ok(
  (
    select count(*) = 4
      and bool_and(
        c.label in (
          'today',
          'minimum_boundary',
          'minimum_outside',
          'maximum_boundary'
        )
      )
    from public.analytics_events e
    join analytics_maintenance_bounds_ctx c on c.event_id = e.id
  ),
  '90-day retention preserves its boundary date and every newer date'
);

select cmp_ok(
  (public.prune_analytics_events(1)->>'deleted')::integer,
  '>=',
  2,
  'minimum valid retention deletes every date older than yesterday'
);

select ok(
  (
    select count(*) = 2
      and bool_and(c.label in ('today', 'minimum_boundary'))
    from public.analytics_events e
    join analytics_maintenance_bounds_ctx c on c.event_id = e.id
  ),
  'one-day retention preserves today and the exact yesterday boundary only'
);

select is(
  (public.prune_analytics_events()->>'cutoff')::date,
  (now() at time zone 'Asia/Seoul')::date - 90,
  'analytics retention omitted argument retains the 90-day default'
);

select * from finish();
rollback;
