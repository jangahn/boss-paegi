-- dashboard_user_composition.pgtap.sql — 0117 유저 퍼널·구성 계약(방문일 기록·처음 방문 코호트·전체/다시 윈도우).
--
-- 핵심 단언: 방문은 user_visit_days(uid·KST 일자)만이 소스이고, 첫 관측일 = least(계정 생성일, 첫 방문일),
-- 익명→회원 이관 원장(anon_data_reassignments)으로 익명 시절 방문이 회원에 접힌다. 처음 방문(first_visit)은
-- admin_funnel_rows_for_day(단일 소스)에서 나오고 롤업과 동일하다.
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(13);

-- ── ACL boundary ─────────────────────────────────────────────────────────

select ok(
  not has_table_privilege('anon', 'public.user_visit_days', 'SELECT')
  and not has_table_privilege('authenticated', 'public.user_visit_days', 'SELECT')
  and not has_table_privilege('anon', 'public.user_visit_days', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_visit_days', 'INSERT'),
  'browser roles cannot read or write visit days'
);

select ok(
  has_table_privilege('service_role', 'public.user_visit_days', 'INSERT')
  and has_table_privilege('service_role', 'public.user_visit_days', 'SELECT'),
  'service role records and reads visit days'
);

select ok(
  has_function_privilege('service_role', 'public.admin_user_composition_window(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_user_composition_window(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_user_composition_window(integer)', 'EXECUTE'),
  'only the service role can read the composition window'
);

select ok(
  not has_function_privilege('anon', 'public.admin_user_visits()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_user_visits()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_user_first_seen()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_user_first_seen()', 'EXECUTE'),
  'browser roles cannot invoke the visit helpers'
);

-- ── Argument bounds ───────────────────────────────────────────────────────

select throws_ok(
  $$select * from public.admin_user_composition_window(0)$$,
  '22023',
  'admin_user_composition_window_invalid_days',
  'composition window zero days is rejected'
);

select throws_ok(
  $$select * from public.admin_user_composition_window(367)$$,
  '22023',
  'admin_user_composition_window_invalid_days',
  'composition window above the one-year bound is rejected'
);

select results_eq(
  $$select stage from public.admin_user_composition_window(null) order by stage$$,
  $$values ('generation'), ('play'), ('purchase'), ('visit')$$,
  'the composition window always yields exactly the four distinct-user stages'
);

-- ── Semantics: 처음/다시, 계정 생성일 바닥, 익명→회원 접기 ──────────────────
-- A: 10일 전 생성, 오늘 방문 → 다시. B: 오늘 생성·오늘 방문 → 처음.
-- C: 20일 전 생성된 익명 소스(5일 전 방문) → D(오늘 생성한 회원, 오늘 방문)로 이관 → D 는 다시(첫 관측일 20일 전).

create temporary table composition_ctx as
select
  '00000000-0000-4000-8000-0000000c0a01'::uuid as user_a,
  '00000000-0000-4000-8000-0000000c0b02'::uuid as user_b,
  '00000000-0000-4000-8000-0000000c0c03'::uuid as user_c,
  '00000000-0000-4000-8000-0000000c0d04'::uuid as user_d,
  (now() at time zone 'Asia/Seoul')::date as today;

insert into auth.users (id, email, created_at)
select user_a, 'composition-a-' || user_a || '@test.local', now() - interval '10 days' from composition_ctx
union all
select user_b, 'composition-b-' || user_b || '@test.local', now() from composition_ctx
union all
select user_c, 'composition-c-' || user_c || '@test.local', now() - interval '20 days' from composition_ctx
union all
select user_d, 'composition-d-' || user_d || '@test.local', now() from composition_ctx;

insert into public.member_accounts (user_id, gen_credits)
select user_d, 0 from composition_ctx;

insert into public.anon_data_reassignments (source_user_id, target_user_id, result)
select user_c, user_d, '{"ok": true, "scores": 0, "badges": 0, "telemetry": 0}'::jsonb from composition_ctx;

insert into public.user_visit_days (user_id, day_kst)
select user_a, today from composition_ctx
union all select user_b, today from composition_ctx
union all select user_c, today - 5 from composition_ctx
union all select user_d, today from composition_ctx;

select is(
  (
    select r.value
    from public.admin_funnel_rows_for_day((select today from composition_ctx)) r
    where r.step = 'first_visit'
  ),
  1::bigint,
  'first_visit counts only the user whose first observed day is today (B)'
);

select results_eq(
  $$select total, again, members from public.admin_user_composition_window(1) where stage = 'visit'$$,
  $$values (3::bigint, 2::bigint, 1::bigint)$$,
  'today: A, B, D visited; A and D are returning; D is the only member'
);

select results_eq(
  $$select total, again, members from public.admin_user_composition_window(7) where stage = 'visit'$$,
  $$values (3::bigint, 2::bigint, 1::bigint)$$,
  'seven days: the anonymous source visit folds into member D instead of adding a fourth user'
);

select results_eq(
  $$select total, again, members from public.admin_user_composition_window(null) where stage = 'visit'$$,
  $$values (3::bigint, 2::bigint, 1::bigint)$$,
  'all-time window matches the folded principal set'
);

-- volatile RPC 와 검증 서브쿼리를 한 SELECT 에 두면 평가 순서가 비결정(재계산 전 값을 읽음) — 반드시 분리.
select ok(
  (public.admin_funnel_rollup_days(1)->>'ok')::boolean,
  'funnel rollup rebuild for first_visit parity seeding succeeds'
);

select is(
  (
    select r.value from public.admin_funnel_rollups r
    where r.day_kst = (select today from composition_ctx) and r.step = 'first_visit'
  ),
  1::bigint,
  'the funnel rollup persists the same first_visit value as the live day'
);

select * from finish();
rollback;
