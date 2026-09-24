-- play_totals.pgtap.sql — 0132 누적 뱃지 합계(get_play_totals · get_my_play_totals) 계약.
--
-- 단언: ① 합계 = 본인 공개 판(registered · cleared) 중 판 통계가 있는 판만(pending · voided · 통계 없는 판 · 남의 판 제외)
--       ② 플레이 시간 = 판 통계 playMs, 없으면 기록된 소요 시간(duration_ms)
--       ③ p_exclude_score 는 지금 제출 중인 판을 뺀다(이전 합계), 판이 없으면 0
--       ④ get_play_totals = service_role 전용, get_my_play_totals = 로그인 본인만(비로그인은 빈 결과)
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(10);

create temporary table play_totals_ctx (
  owner_a uuid not null default gen_random_uuid(),
  owner_b uuid not null default gen_random_uuid()
);
insert into play_totals_ctx default values;

insert into auth.users (id, email)
select owner_a, 'play-totals-a-' || owner_a || '@test.local' from play_totals_ctx
union all
select owner_b, 'play-totals-b-' || owner_b || '@test.local' from play_totals_ctx;

-- on_auth_user_created 트리거가 profiles 를 만들 수 있으므로 멱등 upsert.
insert into public.profiles (id, display_name)
select owner_a, '누적 합계 픽스처 A' from play_totals_ctx
union all
select owner_b, '누적 합계 픽스처 B' from play_totals_ctx
on conflict (id) do update set display_name = excluded.display_name;

-- A: 공개 2판(playMs 있는 판 + v1.53 전 판) + 제외 3판(pending · voided · 통계 없음). B: 공개 1판(남의 판).
create temporary table play_totals_seed (
  label text primary key,
  owner_key text not null,
  score integer not null unique,
  duration_ms integer not null,
  review_status text not null,
  stats jsonb,
  score_id uuid
);
insert into play_totals_seed (label, owner_key, score, duration_ms, review_status, stats)
values
  ('a_registered', 'a', 1200, 30000, 'registered', '{"hitCount":100,"ultimateCount":1,"playMs":25000}'),
  ('a_cleared_before_time_limit', 'a', 3400, 90000, 'cleared', '{"hitCount":200,"ultimateCount":2}'),
  ('a_pending', 'a', 5000, 10000, 'pending', '{"hitCount":999,"ultimateCount":9,"playMs":9999}'),
  ('a_voided', 'a', 6000, 10000, 'voided', '{"hitCount":888,"ultimateCount":8,"playMs":8888}'),
  ('a_no_stats', 'a', 7000, 20000, 'registered', null),
  ('b_registered', 'b', 800, 5000, 'registered', '{"hitCount":50,"ultimateCount":5,"playMs":5000}');

with inserted as (
  insert into public.scores (owner_id, score, weapon, duration_ms, review_status)
  select case s.owner_key when 'a' then c.owner_a else c.owner_b end,
         s.score, 'fist', s.duration_ms, s.review_status
    from play_totals_seed s
   cross join play_totals_ctx c
  returning id, score
)
update play_totals_seed s
   set score_id = i.id
  from inserted i
 where i.score = s.score;

insert into public.score_stats (score_id, gameplay_stats)
select score_id, stats from play_totals_seed where stats is not null;

-- ── 권한 ────────────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.get_play_totals(uuid, uuid)', 'EXECUTE'),
  'anon cannot execute get_play_totals'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_play_totals(uuid, uuid)', 'EXECUTE'),
  'authenticated cannot read another owner''s totals through get_play_totals'
);
select ok(
  has_function_privilege('service_role', 'public.get_play_totals(uuid, uuid)', 'EXECUTE'),
  'service_role executes get_play_totals'
);
select ok(
  not has_function_privilege('anon', 'public.get_my_play_totals()', 'EXECUTE'),
  'anon cannot execute get_my_play_totals'
);
select ok(
  has_function_privilege('authenticated', 'public.get_my_play_totals()', 'EXECUTE'),
  'authenticated executes get_my_play_totals'
);

-- ── 합계 ────────────────────────────────────────────────────────────────────
select results_eq(
  $$select hits, ultimates, play_ms
      from public.get_play_totals((select owner_a from play_totals_ctx), null)$$,
  $$values (300::bigint, 3::bigint, 115000::bigint)$$,
  'totals sum visible games with stats, playMs first then duration_ms; pending, voided, stat-less and other owners excluded'
);

select results_eq(
  $$select hits, ultimates, play_ms
      from public.get_play_totals(
        (select owner_a from play_totals_ctx),
        (select score_id from play_totals_seed where label = 'a_registered')
      )$$,
  $$values (200::bigint, 2::bigint, 90000::bigint)$$,
  'p_exclude_score leaves out the game being submitted'
);

select results_eq(
  $$select hits, ultimates, play_ms from public.get_play_totals(gen_random_uuid(), null)$$,
  $$values (0::bigint, 0::bigint, 0::bigint)$$,
  'an owner without visible games gets zeros'
);

-- ── 본인 합계 ───────────────────────────────────────────────────────────────
select set_config(
  'request.jwt.claims',
  (select pg_catalog.jsonb_build_object('sub', owner_a, 'role', 'authenticated')::text from play_totals_ctx),
  true
);
set local role authenticated;
select results_eq(
  $$select hits, ultimates, play_ms from public.get_my_play_totals()$$,
  $$values (300::bigint, 3::bigint, 115000::bigint)$$,
  'get_my_play_totals returns the signed-in caller''s own totals'
);
reset role;

select set_config('request.jwt.claims', '{}', true);
select is_empty(
  $$select * from public.get_my_play_totals()$$,
  'get_my_play_totals returns no row without a signed-in user'
);

select * from finish();
rollback;
