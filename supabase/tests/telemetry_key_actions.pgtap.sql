-- telemetry_key_actions.pgtap.sql — PC 키보드 사용 기록 계약(0131, v1.50).
--
-- 단언: ① telemetry_sessions.key_actions 컬럼(integer, default 0) ② 적재 RPC 가 totals.keyActions 를 0~1,000,000 으로 저장하고
--       필드가 없는 구 클라 payload 는 0 ③ 봉투 리터럴(4000/초·800만)은 0130 그대로 ④ 롤업 단일 소스
--       telemetry_rollup_rows_for_day 의 'sess_keyboard' 차원 = device_class 별 (타격 세션수·키보드 사용 세션수·키보드 동작 합).
-- TS 쪽 계약은 __tests__/telemetry/key-actions-contract.test.ts.
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(11);

create temp table key_actions_ctx (
  member_id uuid not null default gen_random_uuid(),
  s_keyboard uuid not null default gen_random_uuid(),
  s_pointer uuid not null default gen_random_uuid(),
  s_legacy uuid not null default gen_random_uuid(),
  s_huge uuid not null default gen_random_uuid(),
  s_idle uuid not null default gen_random_uuid(),
  s_many uuid not null default gen_random_uuid(),
  actor_key text not null default md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)
);
insert into key_actions_ctx default values;
insert into auth.users(id, email)
select member_id, 'key-actions@test.local' from key_actions_ctx;
insert into public.member_accounts(user_id, email)
select member_id, 'key-actions@test.local' from key_actions_ctx;

select is(
  (select data_type || '/' || coalesce(column_default, '') from information_schema.columns
    where table_schema = 'public' and table_name = 'telemetry_sessions' and column_name = 'key_actions'),
  'integer/0',
  'telemetry_sessions.key_actions is an integer column defaulting to 0 (0131)'
);
select ok(
  pg_get_functiondef('public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'::regprocedure)
    ~ 'c_max_avg_per_sec int := 4000;'
  and pg_get_functiondef('public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'::regprocedure)
    ~ 'c_max_score bigint := 8000000;',
  'ingest envelope literals are unchanged by 0131 (4000/s, 8,000,000)'
);

-- PC 키보드 세션(키보드 동작 42) · PC 포인터 세션(0) · 구 클라(필드 없음) · 상한 초과 · 타격 없는 세션(분모 제외)
select public.ingest_telemetry_delta(c.s_keyboard, c.member_id, true, c.actor_key,
  '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":1200,"hitCount":100,"keyActions":42},"weaponSummary":{"fist":{"hits":100}},"milestones":{"firstHitMs":500}},"events":[]}'::jsonb)
from key_actions_ctx c;
select public.ingest_telemetry_delta(c.s_pointer, c.member_id, true, c.actor_key,
  '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":1200,"hitCount":100,"keyActions":0},"weaponSummary":{"fist":{"hits":100}},"milestones":{"firstHitMs":500}},"events":[]}'::jsonb)
from key_actions_ctx c;
select public.ingest_telemetry_delta(c.s_legacy, c.member_id, true, c.actor_key,
  '{"deviceClass":"mobile-touch","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":1200,"hitCount":100},"weaponSummary":{"fist":{"hits":100}},"milestones":{"firstHitMs":500}},"events":[]}'::jsonb)
from key_actions_ctx c;
select public.ingest_telemetry_delta(c.s_huge, c.member_id, true, c.actor_key,
  '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":1200,"hitCount":100,"keyActions":99999999},"weaponSummary":{"fist":{"hits":100}},"milestones":{"firstHitMs":500}},"events":[]}'::jsonb)
from key_actions_ctx c;
select public.ingest_telemetry_delta(c.s_idle, c.member_id, true, c.actor_key,
  '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":0,"hitCount":0,"keyActions":0},"weaponSummary":{},"milestones":{}},"events":[]}'::jsonb)
from key_actions_ctx c;

-- 무기 15종을 쓴 세션 · 어휘(19)보다 큰 값 — distinct_weapons 상한은 9 가 아니라 19 (0131 드리프트 수정)
select public.ingest_telemetry_delta(c.s_many, c.member_id, true, c.actor_key,
  '{"deviceClass":"mobile-touch","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":1200,"hitCount":100,"distinctWeapons":15},"weaponSummary":{"fist":{"hits":100}},"milestones":{"firstHitMs":500}},"events":[]}'::jsonb)
from key_actions_ctx c;
select is((select t.distinct_weapons from public.telemetry_sessions t join key_actions_ctx c on t.id = c.s_many), 15,
  'distinct_weapons above the legacy 9 clamp is stored as sent (weapon vocabulary is 19)');
select ok(
  pg_get_functiondef('public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'::regprocedure) ~ 'c_weapon_count int := 19;',
  'ingest weapon-count clamp literal equals the 19-weapon vocabulary'
);

select is((select t.key_actions from public.telemetry_sessions t join key_actions_ctx c on t.id = c.s_keyboard), 42,
  'totals.keyActions is stored on the session');
select is((select t.key_actions from public.telemetry_sessions t join key_actions_ctx c on t.id = c.s_pointer), 0,
  'pointer-only session stores 0');
select is((select t.key_actions from public.telemetry_sessions t join key_actions_ctx c on t.id = c.s_legacy), 0,
  'legacy payload without the field stores 0 (old bundle compatible)');
select is((select t.key_actions from public.telemetry_sessions t join key_actions_ctx c on t.id = c.s_huge), 1000000,
  'keyActions is clamped to 1,000,000 (same bound as lib/telemetry/validate.ts)');

-- 롤업 단일 소스: 오늘(KST) 행에서 이 테스트 세션만 분리할 수 없으므로 기준선 대비 증가분으로 단언한다.
create temp table key_actions_rollup as
select r.dim_key, r.sessions, r.hits, r.measure_a
  from public.telemetry_rollup_rows_for_day((now() at time zone 'Asia/Seoul')::date) r
 where r.dim_type = 'sess_keyboard';

select is(
  (select count(*)::int from key_actions_rollup where dim_key not in
     ('mobile-touch', 'mobile-pointer', 'desktop-touch', 'desktop-pointer', 'other')),
  0,
  'sess_keyboard dim keys are device classes'
);
select ok(
  (select sessions >= 3 and measure_a >= 2 and hits >= 1000042 from key_actions_rollup where dim_key = 'desktop-pointer'),
  'desktop-pointer row counts hit sessions (3: keyboard, pointer, huge — idle excluded), keyboard sessions (2) and key actions'
);
select ok(
  (select sessions >= 1 and measure_a = (select count(*) from public.telemetry_sessions t
                                          where t.device_class = 'mobile-touch' and t.first_hit_ms is not null
                                            and coalesce(t.key_actions, 0) > 0
                                            and t.started_at >= ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul'))
     from key_actions_rollup where dim_key = 'mobile-touch'),
  'mobile-touch row counts the sessions without key actions in the denominator only'
);

select * from finish();
rollback;
