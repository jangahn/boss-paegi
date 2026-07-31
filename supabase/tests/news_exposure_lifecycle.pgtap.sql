-- 0099 list_news_events — 소식 노출 수명주기 계약 (2026-08-01 제품 결정)
-- 종료 글 영구 잔존·예약/초안/삭제 숨김·종료 시 pinned 고정 해제 정렬.
begin;
select plan(11);

select ok(
  to_regprocedure('public.list_news_events(text, integer, integer)')
    is not null,
  'news lifecycle list RPC exists'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_news_events(text, integer, integer)',
    'EXECUTE'
  ),
  'service_role can execute the news list'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.list_news_events(text, integer, integer)',
    'EXECUTE'
  ),
  'anon cannot execute the news list directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.list_news_events(text, integer, integer)',
    'EXECUTE'
  ),
  'authenticated cannot execute the news list directly'
);

-- Isolate the fixture without persisting changes.
update public.events set status = 'draft' where status = 'published';
insert into public.events (
  id, type, status, title, summary, body,
  starts_at, ends_at,
  popup_active, banner_home_active, banner_gallery_active,
  banner_leaderboard_active, priority, pinned, popup_dismiss_days,
  published_at, created_at, updated_at
)
values
  -- 노출중·비고정 — 최신 발행.
  ('21111111-1111-4111-8111-111111111111', 'notice', 'published',
   'live plain', 's', 'b',
   pg_catalog.statement_timestamp() - interval '1 hour', null,
   false, false, false, false, 0, false, 7,
   '2026-01-04 00:00:00+00', '2026-01-04 00:00:00+00',
   pg_catalog.statement_timestamp()),
  -- 노출중·고정 — 발행은 가장 오래됐지만 고정이라 최상단이어야 한다.
  ('22222222-2222-4222-8222-222222222222', 'notice', 'published',
   'live pinned', 's', 'b',
   null, null,
   false, false, false, false, 0, true, 7,
   '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00',
   pg_catalog.statement_timestamp()),
  -- 노출종료·고정 — 잔존하되 고정 해제로 일반 최신순에 섞인다.
  ('23333333-3333-4333-8333-333333333333', 'event', 'published',
   'ended pinned', 's', 'b',
   pg_catalog.statement_timestamp() - interval '2 days',
   pg_catalog.statement_timestamp() - interval '1 minute',
   false, false, false, false, 0, true, 7,
   '2026-01-05 00:00:00+00', '2026-01-05 00:00:00+00',
   pg_catalog.statement_timestamp()),
  -- 노출전(예약) — 공개 목록에서 숨김.
  ('24444444-4444-4444-8444-444444444444', 'event', 'published',
   'scheduled hidden', 's', 'b',
   pg_catalog.statement_timestamp() + interval '1 day', null,
   false, false, false, false, 0, false, 7,
   '2026-01-06 00:00:00+00', '2026-01-06 00:00:00+00',
   pg_catalog.statement_timestamp()),
  -- 초안 — 숨김.
  ('25555555-5555-4555-8555-555555555555', 'notice', 'draft',
   'draft hidden', 's', 'b',
   null, null,
   false, false, false, false, 0, false, 7,
   null, '2026-01-07 00:00:00+00', pg_catalog.statement_timestamp()),
  -- 삭제 — 숨김.
  ('26666666-6666-4666-8666-666666666666', 'notice', 'published',
   'deleted hidden', 's', 'b',
   null, null,
   false, false, false, false, 0, false, 7,
   '2026-01-08 00:00:00+00', '2026-01-08 00:00:00+00',
   pg_catalog.statement_timestamp());
update public.events
   set deleted_at = pg_catalog.statement_timestamp()
 where id = '26666666-6666-4666-8666-666666666666';

select is(
  (select (public.list_news_events(null, 20, 0))->>'total')::integer,
  3,
  'ended stays while scheduled, draft, and deleted are hidden'
);
select is(
  (
    select pg_catalog.jsonb_agg(item->>'title')
      from pg_catalog.jsonb_array_elements(
             (public.list_news_events(null, 20, 0))->'items'
           ) item
  ),
  '["live pinned", "ended pinned", "live plain"]'::jsonb,
  'live pinned floats while the ended pinned post loses its pin'
);
select is(
  (
    select item->>'title'
      from pg_catalog.jsonb_array_elements(
             (public.list_news_events(null, 1, 1))->'items'
           ) item
  ),
  'ended pinned',
  'pagination offset walks the same lifecycle order'
);
select is(
  (select (public.list_news_events('event', 20, 0))->>'total')::integer,
  1,
  'type filter keeps the ended event visible'
);
select is(
  (
    select pg_catalog.jsonb_agg(item->>'title')
      from pg_catalog.jsonb_array_elements(
             (public.list_news_events('event', 20, 0))->'items'
           ) item
  ),
  '["ended pinned"]'::jsonb,
  'type filter returns exactly the ended event'
);
select is(
  (public.list_news_events(null, 0, 0))->'items',
  '[]'::jsonb,
  'zero limit returns an empty page with the full total'
);
select is(
  (
    select pg_catalog.count(*)::integer
      from pg_catalog.jsonb_array_elements(
             (public.list_news_events(null, 999, 0))->'items'
           )
  ),
  3,
  'limit is clamped without dropping rows'
);

select * from finish();
rollback;
