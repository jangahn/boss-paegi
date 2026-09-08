-- game_score_bucket_rollup.pgtap.sql — 0119 점수 구간 분포 dim(game_score_1k) 계약.
--
-- 단언: ① 공개 판정(registered·cleared) 점수만 1,000점 버킷으로 집계된다(pending·voided 제외)
--       ② 버킷 키 = floor(score/1000), sessions=게임 수, score=점수 합, measure_a=duration 합
--       ③ cron 롤업(telemetry_rollup_days)과 라이브 함수 출력이 이 dim 에서도 바이트 동일(단일 소스)
--       ④ 백필 문장은 멱등(재실행해도 행 수 불변)
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(9);

create temporary table score_bucket_ctx (
  owner_id uuid not null default gen_random_uuid()
);
insert into score_bucket_ctx default values;

insert into auth.users (id, email)
select owner_id, 'score-bucket-' || owner_id || '@test.local' from score_bucket_ctx;

-- on_auth_user_created 트리거가 profiles 를 만들 수 있으므로 멱등 upsert.
insert into public.profiles (id, display_name)
select owner_id, '점수구간 픽스처' from score_bucket_ctx
on conflict (id) do update set display_name = excluded.display_name;

-- 공개 판정 4판(registered 3 + cleared 1) + 비공개 2판(pending·voided). 버킷: 1(1,200)·9(9,999)·12(12,345)·100(100,000).
insert into public.scores (owner_id, score, weapon, duration_ms, review_status)
select owner_id, s.score, 'fist', s.duration_ms, s.review_status
from score_bucket_ctx,
  (values
    (1200, 30000, 'registered'),
    (9999, 40000, 'registered'),
    (12345, 90000, 'registered'),
    (100000, 300000, 'cleared'),
    (55555, 10000, 'pending'),
    (77777, 10000, 'voided')
  ) as s(score, duration_ms, review_status);

select is(
  (
    select count(*)::integer
    from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
    where dim_type = 'game_score_1k'
  ),
  4,
  'visible scores fold into exactly their distinct 1,000-point buckets'
);

select results_eq(
  $$select dim_key, sessions, score, measure_a
      from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
     where dim_type = 'game_score_1k'
     order by dim_key::integer$$,
  $$values ('1'::text, 1, 1200::bigint, 30000::numeric),
           ('9'::text, 1, 9999::bigint, 40000::numeric),
           ('12'::text, 1, 12345::bigint, 90000::numeric),
           ('100'::text, 1, 100000::bigint, 300000::numeric)$$,
  'bucket key is floor(score/1000) and sessions/score/measure_a are count, score sum, duration sum'
);

select is(
  (
    select coalesce(sum(sessions), 0)::integer
    from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
    where dim_type = 'game_score_1k'
  ),
  4,
  'pending and voided scores are excluded from the score-band histogram'
);

select is(
  (
    select count(*)::integer
    from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
    where dim_type = 'game_score_1k' and (hits <> 0 or attempts <> 0 or switches <> 0)
  ),
  0,
  'unused measures stay zero on the score-band dim'
);

select is(
  (public.telemetry_rollup_days(1)->>'days')::integer,
  1,
  'telemetry rollup rebuild for parity seeding succeeds'
);

select is(
  (
    select count(*)::integer from (
      select dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date and dim_type = 'game_score_1k'
      except
      select dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
      where dim_type = 'game_score_1k'
    ) diff
  ) + (
    select count(*)::integer from (
      select dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date)
      where dim_type = 'game_score_1k'
      except
      select dim_key, sessions, hits, score, attempts, switches, measure_a
      from public.telemetry_rollups
      where day_kst = (now() at time zone 'Asia/Seoul')::date and dim_type = 'game_score_1k'
    ) diff
  ),
  0,
  'score-band rollup rows and live-day output are identical sets'
);

-- 백필 멱등 — 마이그레이션의 insert 문장을 재실행해도 행 수 불변(on conflict do nothing).
create temporary table score_bucket_before as
  select count(*)::integer as n from public.telemetry_rollups where dim_type = 'game_score_1k';

insert into public.telemetry_rollups(day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a)
select (s.created_at at time zone 'Asia/Seoul')::date, 'game_score_1k', (s.score / 1000)::text,
  count(*)::int, 0, coalesce(sum(s.score), 0), 0, 0, coalesce(sum(s.duration_ms), 0)
from public.scores s
where s.review_status in ('registered', 'cleared')
  and (s.created_at at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date
group by 1, 3
on conflict (day_kst, dim_type, dim_key) do nothing;

select is(
  (select count(*)::integer from public.telemetry_rollups where dim_type = 'game_score_1k'),
  (select n from score_bucket_before),
  'the historical backfill statement is idempotent'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.telemetry_rollup_rows_for_day(date)'::regprocedure),
    $needle$s.review_status in ('registered', 'cleared')$needle$
  ) > 0,
  'the score-band dim uses the public visibility predicate (registered, cleared)'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.telemetry_rollup_rows_for_day(date)'::regprocedure),
    $needle$'game_score_1k'::text, (s.score / 1000)::text$needle$
  ) > 0,
  'the score-band dim key is the 1,000-point bucket of the score'
);

select * from finish();
rollback;
