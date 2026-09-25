-- telemetry_ingest_envelope.pgtap.sql — 텔레메트리 적재 RPC 봉투 계약(0130 · 0133, anti-abuse v13).
--
-- 단언: ① bp_ingest_telemetry_delta_core 의 suspicious 비율 임계 리터럴 = 저장 봉투(5,500점/초, 0133)·점수 캡 800만
--       ② 3,900 · 2,500(종전 2,000 드리프트 구간) · 4,100점/초(0133 전 4,000 봉투 위 — 제한 시간 판 실측 3,748 근처) 세션은
--          비의심, 5,600점/초 세션은 의심
-- TS 쪽 동일 리터럴 계약은 __tests__/score/telemetry-ingest-envelope.test.ts(MAX_AVG_SCORE_PER_SEC·MAX_SCORE_HARD).
-- Run only on a disposable database after applying every migration in order.

begin;
select plan(7);

create temp table ingest_env_ctx (
  member_id uuid not null default gen_random_uuid(),
  s_ok uuid not null default gen_random_uuid(),
  s_mid uuid not null default gen_random_uuid(),
  s_wide uuid not null default gen_random_uuid(),
  s_over uuid not null default gen_random_uuid(),
  -- 공개 쓰기 quota 의 actor 키 형식 = 64 hex(bp_consume_public_write_quota: invalid_actor 아니면 거부)
  actor_key text not null default md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text),
  ack_ok jsonb,
  ack_mid jsonb,
  ack_wide jsonb,
  ack_over jsonb
);
insert into ingest_env_ctx default values;
insert into auth.users(id, email)
select member_id, 'ingest-envelope@test.local' from ingest_env_ctx;
insert into public.member_accounts(user_id, email)
select member_id, 'ingest-envelope@test.local' from ingest_env_ctx;

select ok(
  pg_get_functiondef(
    'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'::regprocedure
  ) ~ 'c_max_avg_per_sec int := 5500;',
  'ingest suspicious ratio literal equals the storage envelope 5500/s (0133)'
);
select ok(
  pg_get_functiondef(
    'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'::regprocedure
  ) ~ 'c_max_score bigint := 8000000;',
  'ingest raw score clamp literal equals the storage hard cap 8,000,000 (0130)'
);

-- 10초 · 39,000점 = 3,900/초 (봉투 아래)
update ingest_env_ctx c
   set ack_ok = public.ingest_telemetry_delta(
         c.s_ok, c.member_id, true, c.actor_key,
         '{"deviceClass":"mobile-touch","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":39000,"hitCount":100},"weaponSummary":{"fist":{"hits":100}}},"events":[]}'::jsonb
       );
-- 10초 · 25,000점 = 2,500/초 (종전 2,000 드리프트 구간 — 0130 전엔 suspicious 였다)
update ingest_env_ctx c
   set ack_mid = public.ingest_telemetry_delta(
         c.s_mid, c.member_id, true, c.actor_key,
         '{"deviceClass":"mobile-touch","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":25000,"hitCount":100},"weaponSummary":{"fist":{"hits":100}}},"events":[]}'::jsonb
       );
-- 10초 · 41,000점 = 4,100/초 (0133 전 봉투 4,000 위 — 이제 비의심)
update ingest_env_ctx c
   set ack_wide = public.ingest_telemetry_delta(
         c.s_wide, c.member_id, true, c.actor_key,
         '{"deviceClass":"mobile-touch","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":41000,"hitCount":100},"weaponSummary":{"fist":{"hits":100}}},"events":[]}'::jsonb
       );
-- 10초 · 56,000점 = 5,600/초 (봉투 위)
update ingest_env_ctx c
   set ack_over = public.ingest_telemetry_delta(
         c.s_over, c.member_id, true, c.actor_key,
         '{"deviceClass":"mobile-touch","summary":{"seqHigh":1,"durationMs":10000,"totals":{"score":56000,"hitCount":100},"weaponSummary":{"fist":{"hits":100}}},"events":[]}'::jsonb
       );

select is(
  (select (ack_ok->>'mode') || '/' || (ack_mid->>'mode') || '/' || (ack_wide->>'mode') || '/' || (ack_over->>'mode') from ingest_env_ctx),
  'full/full/full/full',
  'all four envelope fixture deltas are ingested in full mode'
);
select is(
  (select t.suspicious from public.telemetry_sessions t join ingest_env_ctx c on t.id = c.s_ok),
  false,
  '3,900 pts/s session is not suspicious under the 5500/s envelope'
);
select is(
  (select t.suspicious from public.telemetry_sessions t join ingest_env_ctx c on t.id = c.s_mid),
  false,
  '2,500 pts/s session (former 2000/s drift zone) is no longer suspicious'
);
select is(
  (select t.suspicious from public.telemetry_sessions t join ingest_env_ctx c on t.id = c.s_wide),
  false,
  '4,100 pts/s session (above the former 4000/s envelope) is no longer suspicious'
);
select is(
  (select t.suspicious from public.telemetry_sessions t join ingest_env_ctx c on t.id = c.s_over),
  true,
  '5,600 pts/s session above the envelope is suspicious'
);

select * from finish();
rollback;
