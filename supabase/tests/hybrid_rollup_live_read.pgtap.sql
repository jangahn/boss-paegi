-- hybrid_rollup_live_read.pgtap.sql — 0110/0111/0112 하이브리드(오늘=라이브·과거=롤업) 계약.
--
-- 핵심 단언: cron 이 롤업에 쓰는 값과 라이브 RPC(*_rows_for_day)가 돌려주는 값이
-- **바이트까지 동일**해야 한다(단일 소스 규약 — 어긋나면 어드민 오늘/과거 수치가 드리프트).
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(26);

-- ── Catalog and ACL boundary ──────────────────────────────────────────────

select ok(
  has_function_privilege('service_role', 'public.telemetry_rollup_rows_for_day(date)', 'EXECUTE'),
  'service role can read the telemetry live-day aggregation'
);

select ok(
  has_function_privilege('service_role', 'public.analytics_rollup_rows_for_day(date)', 'EXECUTE'),
  'service role can read the acquisition live-day aggregation'
);

select ok(
  has_function_privilege('service_role', 'public.admin_funnel_rows_for_day(date)', 'EXECUTE'),
  'service role can read the funnel live-day cohort'
);

select ok(
  has_function_privilege('service_role', 'public.admin_funnel_rollup_days(integer)', 'EXECUTE'),
  'service role can rebuild bounded funnel rollups'
);

select ok(
  has_function_privilege('service_role', 'public.get_admin_order_summary_window(integer)', 'EXECUTE'),
  'service role can read the windowed order summary'
);

select ok(
  not has_function_privilege('anon', 'public.telemetry_rollup_rows_for_day(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.telemetry_rollup_rows_for_day(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.analytics_rollup_rows_for_day(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.analytics_rollup_rows_for_day(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_funnel_rows_for_day(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_funnel_rows_for_day(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_funnel_rollup_days(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_funnel_rollup_days(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_admin_order_summary_window(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_admin_order_summary_window(integer)', 'EXECUTE'),
  'browser roles cannot invoke any hybrid read or rebuild function'
);

select ok(
  (
    select count(*) = 5
      and bool_and(p.prosecdef)
      and bool_and(coalesce(p.proconfig @> array['search_path=public']::text[], false))
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'telemetry_rollup_rows_for_day',
        'analytics_rollup_rows_for_day',
        'admin_funnel_rows_for_day',
        'admin_funnel_rollup_days',
        'get_admin_order_summary_window'
      )
  ),
  'all five hybrid functions are security definer with a fixed search path'
);

select ok(
  not has_table_privilege('anon', 'public.admin_funnel_rollups', 'SELECT')
  and not has_table_privilege('authenticated', 'public.admin_funnel_rollups', 'SELECT'),
  'browser roles cannot read funnel rollups directly'
);

-- ── Argument bounds ───────────────────────────────────────────────────────

select throws_ok(
  $$select * from public.telemetry_rollup_rows_for_day(null::date)$$,
  '22023',
  'telemetry_rollup_rows_for_day_invalid_day',
  'telemetry live-day NULL date is rejected'
);

select throws_ok(
  $$select * from public.analytics_rollup_rows_for_day(null::date)$$,
  '22023',
  'analytics_rollup_rows_for_day_invalid_day',
  'acquisition live-day NULL date is rejected'
);

select throws_ok(
  $$select * from public.admin_funnel_rows_for_day(null::date)$$,
  '22023',
  'admin_funnel_rows_for_day_invalid_day',
  'funnel live-day NULL date is rejected'
);

select throws_ok(
  $$select public.admin_funnel_rollup_days(null::integer)$$,
  '22023',
  'admin_funnel_rollup_days_invalid_days',
  'funnel rollup NULL days is rejected'
);

select throws_ok(
  $$select public.admin_funnel_rollup_days(0)$$,
  '22023',
  'admin_funnel_rollup_days_invalid_days',
  'funnel rollup zero days is rejected'
);

select throws_ok(
  $$select public.admin_funnel_rollup_days(367)$$,
  '22023',
  'admin_funnel_rollup_days_invalid_days',
  'funnel rollup above the one-year recovery bound is rejected'
);

select throws_ok(
  $$select public.get_admin_order_summary_window(0)$$,
  '22023',
  'get_admin_order_summary_window_invalid_days',
  'order summary zero-day window is rejected'
);

select throws_ok(
  $$select public.get_admin_order_summary_window(3661)$$,
  '22023',
  'get_admin_order_summary_window_invalid_days',
  'order summary window above ten years is rejected'
);

-- ── 단일 소스 parity: cron 이 쓴 롤업 == 라이브 함수 출력 ────────────────────

insert into public.telemetry_sessions(
  id, is_anon, device_class, started_at, end_reason, duration_ms, score,
  distinct_weapons, distinct_maps, start_map, avg_frame_ms, p95_frame_ms,
  first_hit_ms, weapon_summary, map_summary
)
values (
  gen_random_uuid(), true, 'mobile-touch', now(), 'normal', 42000, 26189,
  2, 1, 'office',
  16.7, 34.2, 850,
  '{"fist":{"hits":80,"score":20000,"attempts":90,"switches":1},"gun":{"hits":10,"score":6189,"attempts":12,"switches":1}}',
  '{"office":{"hits":90,"score":26189,"attempts":102,"switches":0}}'
);

select is(
  (public.telemetry_rollup_days(1)->>'days')::integer,
  1,
  'telemetry rollup rebuild for parity seeding succeeds'
);

select is(
  (
    select count(*)::integer from (
      select dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date
      except
      select dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
    ) diff
  ),
  0,
  'every telemetry rollup row equals the live-day function output'
);

select is(
  (
    select count(*)::integer from (
      select dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
      except
      select dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date
    ) diff
  ),
  0,
  'the telemetry live-day function emits nothing the rollup lacks'
);

insert into public.analytics_events(kind, created_at, day_kst, member_state, source_scope, source_kind, source_value)
values ('visit', now(), (now() at time zone 'Asia/Seoul')::date, 'anon', 'current', 'direct', 'direct');

insert into public.analytics_events(kind, created_at, day_kst, member_state, surface, target, score_tier, result)
values ('share', now(), (now() at time zone 'Asia/Seoul')::date, 'member', 'game_over', 'score', 7, 'attempt');

select is(
  (public.maintain_analytics_rollups(1)->>'days')::integer,
  1,
  'acquisition rollup rebuild for parity seeding succeeds'
);

select is(
  (
    select count(*)::integer from (
      select metric, dim1, dim2, dim3, dim4, value
      from public.analytics_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date
      except
      select metric, dim1, dim2, dim3, dim4, value
      from public.analytics_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
    ) diff
  ) + (
    select count(*)::integer from (
      select metric, dim1, dim2, dim3, dim4, value
      from public.analytics_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
      except
      select metric, dim1, dim2, dim3, dim4, value
      from public.analytics_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date
    ) diff
  ),
  0,
  'acquisition rollup rows and live-day output are identical sets'
);

-- ── 퍼널 코호트: 항상 5단계, 롤업과 라이브 동일 ────────────────────────────

select results_eq(
  $$select step from public.admin_funnel_rows_for_day((now() at time zone 'Asia/Seoul')::date) order by step$$,
  $$values ('anon_users'), ('first_gen'), ('first_purchase'), ('members'), ('players')$$,
  'the funnel live day always yields exactly the five cohort steps'
);

select is(
  (public.admin_funnel_rollup_days(1)->>'days')::integer,
  1,
  'funnel rollup rebuild acknowledges its bounded window'
);

select is(
  (
    select count(*)::integer from (
      select step, value
      from public.admin_funnel_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date
      except
      select step, value
      from public.admin_funnel_rows_for_day((now() at time zone 'Asia/Seoul')::date)
    ) diff
  ),
  0,
  'funnel rollup rows equal the live-day cohort output'
);

-- ── 매출 윈도우: 형태와 단조성 ─────────────────────────────────────────────

select ok(
  (
    select summary ? 'revenue' and summary ? 'orders' and summary ? 'by_status'
    from (select public.get_admin_order_summary_window(null) as summary) t
  ),
  'the all-time order summary exposes revenue, orders, and by_status'
);

select ok(
  (
    select (all_time.summary->>'orders')::bigint >= (today.summary->>'orders')::bigint
      and (all_time.summary->>'revenue')::bigint >= (today.summary->>'revenue')::bigint
    from (select public.get_admin_order_summary_window(null) as summary) all_time,
         (select public.get_admin_order_summary_window(1) as summary) today
  ),
  'the all-time order window dominates the today window'
);

select * from finish();
rollback;
