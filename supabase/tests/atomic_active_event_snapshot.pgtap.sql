begin;
select plan(18);

select ok(
  to_regprocedure('public.get_active_event_surfaces()') is not null,
  'atomic active-event RPC exists'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.get_active_event_surfaces()',
    'EXECUTE'
  ),
  'service_role can execute the active-event projection'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_active_event_surfaces()',
    'EXECUTE'
  ),
  'anon cannot execute the active-event projection directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_active_event_surfaces()',
    'EXECUTE'
  ),
  'authenticated cannot execute the active-event projection directly'
);
select ok(
  (
    select l.lanname = 'sql' and p.provolatile = 's' and p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure('public.get_active_event_surfaces()')
  ),
  'one STABLE SECURITY DEFINER SQL statement binds one MVCC snapshot'
);
select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.get_active_event_surfaces()')
  ),
  array['search_path=pg_catalog, public'],
  'RPC pins the trusted search path'
);

-- Isolate the fixture without persisting changes.
update public.events set status = 'draft' where status = 'published';
create temporary table active_event_test_times on commit drop as
select
  pg_catalog.statement_timestamp() - interval '1 minute' as active_start,
  pg_catalog.statement_timestamp() + interval '100 years' as future_start,
  pg_catalog.statement_timestamp() - interval '1 millisecond' as expired_end,
  '2026-01-01 00:00:00+00'::timestamptz as same_published,
  '2026-01-01 00:00:00+00'::timestamptz as same_created;

insert into public.events (
  id,
  type,
  status,
  title,
  summary,
  body,
  starts_at,
  ends_at,
  popup_active,
  banner_home_active,
  banner_gallery_active,
  banner_leaderboard_active,
  priority,
  pinned,
  popup_dismiss_days,
  published_at,
  created_at,
  updated_at
)
select
  fixture.id,
  fixture.type,
  'published',
  fixture.title,
  fixture.summary,
  'fixture body',
  fixture.starts_at,
  fixture.ends_at,
  fixture.popup_active,
  fixture.banner_home_active,
  fixture.banner_gallery_active,
  fixture.banner_leaderboard_active,
  fixture.priority,
  fixture.pinned,
  7,
  fixture.published_at,
  fixture.created_at,
  pg_catalog.statement_timestamp()
from active_event_test_times t
cross join lateral (
  values
    (
      '11111111-1111-4111-8111-111111111111'::uuid,
      'notice',
      'popup winner',
      'popup winner summary',
      t.active_start,
      null::timestamptz,
      true,
      false,
      false,
      false,
      100,
      false,
      t.same_published,
      t.same_created
    ),
    (
      '22222222-2222-4222-8222-222222222222'::uuid,
      'event',
      'home lower tie',
      'home lower tie summary',
      t.active_start,
      null::timestamptz,
      false,
      true,
      false,
      false,
      90,
      false,
      t.same_published,
      t.same_created
    ),
    (
      '33333333-3333-4333-8333-333333333333'::uuid,
      'event',
      'gallery leaderboard',
      'gallery leaderboard summary',
      t.active_start,
      null::timestamptz,
      false,
      false,
      true,
      true,
      50,
      true,
      t.same_published,
      t.same_created
    ),
    (
      '44444444-4444-4444-8444-444444444444'::uuid,
      'event',
      'future event',
      'future event summary',
      t.future_start,
      null::timestamptz,
      true,
      true,
      true,
      true,
      1000,
      true,
      t.same_published,
      t.same_created
    ),
    (
      '55555555-5555-4555-8555-555555555555'::uuid,
      'event',
      'expired event',
      'expired event summary',
      null::timestamptz,
      t.expired_end,
      true,
      true,
      true,
      true,
      1000,
      true,
      t.same_published,
      t.same_created
    ),
    (
      '66666666-6666-4666-8666-666666666666'::uuid,
      'event',
      'home pinned tie',
      'home pinned tie summary',
      t.active_start,
      null::timestamptz,
      false,
      true,
      false,
      false,
      90,
      true,
      t.same_published,
      t.same_created
    ),
    (
      '77777777-7777-4777-8777-777777777777'::uuid,
      'event',
      'home final tie',
      'home final tie summary',
      t.active_start,
      null::timestamptz,
      false,
      true,
      false,
      false,
      90,
      true,
      t.same_published,
      t.same_created
    )
) fixture(
  id,
  type,
  title,
  summary,
  starts_at,
  ends_at,
  popup_active,
  banner_home_active,
  banner_gallery_active,
  banner_leaderboard_active,
  priority,
  pinned,
  published_at,
  created_at
);

set local role service_role;
create temporary table active_event_snapshot_result on commit drop as
select public.get_active_event_surfaces() as result;
reset role;

select is(
  (
    select pg_catalog.count(*)
    from active_event_snapshot_result r,
      lateral pg_catalog.jsonb_object_keys(r.result)
  ),
  4::bigint,
  'top-level response has exactly four keys'
);
select ok(
  (
    select result ?& array[
      'serverNow',
      'nextTransitionAt',
      'popup',
      'banners'
    ]
    from active_event_snapshot_result
  ),
  'top-level response keys are complete'
);
select matches(
  (select result->>'serverNow' from active_event_snapshot_result),
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$',
  'serverNow is canonical millisecond UTC'
);
select is(
  (select result->>'nextTransitionAt' from active_event_snapshot_result),
  (
    select pg_catalog.to_char(
      future_start at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
    from active_event_test_times
  ),
  'nearest future start/end transition is projected exactly'
);
select is(
  (select result#>>'{popup,id}' from active_event_snapshot_result),
  '11111111-1111-4111-8111-111111111111',
  'expired and future high-priority rows cannot replace active popup'
);
select is(
  (select result#>>'{banners,home,id}' from active_event_snapshot_result),
  '77777777-7777-4777-8777-777777777777',
  'home pick applies priority, pinned, timestamps, then UUID ordering'
);
select is(
  (select result#>>'{banners,gallery,id}' from active_event_snapshot_result),
  '33333333-3333-4333-8333-333333333333',
  'gallery pick uses the same atomic candidate set'
);
select is(
  (select result#>>'{banners,leaderboard,id}' from active_event_snapshot_result),
  '33333333-3333-4333-8333-333333333333',
  'leaderboard pick uses the same atomic candidate set'
);
select is(
  (
    select pg_catalog.count(*)
    from active_event_snapshot_result r,
      lateral pg_catalog.jsonb_object_keys(r.result->'banners')
  ),
  3::bigint,
  'banners object has exactly three surface keys'
);
select is(
  (
    select pg_catalog.count(*)
    from active_event_snapshot_result r,
      lateral pg_catalog.jsonb_object_keys(r.result->'popup')
  ),
  5::bigint,
  'popup projection has exactly five public fields'
);
select is(
  (
    select pg_catalog.count(*)
    from active_event_snapshot_result r,
      lateral pg_catalog.jsonb_object_keys(r.result#>'{banners,home}')
  ),
  3::bigint,
  'banner projection has exactly three public fields'
);
select ok(
  (
    select pg_catalog.pg_column_size(result) <= 8192
    from active_event_snapshot_result
  ),
  'public snapshot is bounded to 8 KiB'
);

select * from finish();
rollback;
