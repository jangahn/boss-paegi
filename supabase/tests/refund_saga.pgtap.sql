-- refund_saga.pgtap.sql — 환불 saga 실행 가능 pgTAP 스위트 (§42·§45).
--
-- 상태: generated / runtime-unverified — 실행에는 **pgTAP 확장 + 0062 적용 DB** 가 필요하다(라이브 DB 없음).
--   정적으로는 pglast(libpg_query)로 파스 통과를 확인했다. 모든 함수/테이블 참조는 0062 실 객체다.
--
-- 실행(DB 있을 때):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/refund_saga.pgtap.sql
--   (pgTAP 미설치 시: create extension if not exists pgtap; 선행)
--
-- 구성:
--   Part A — 스키마/카탈로그/ACL(§16)/RLS(§32)/FK RESTRICT(§20)/CHECK(§7·§11·§28) + 봉투/카운터 불변식.
--            데이터 픽스처 불필요(현 DB 상태에 대한 truth 검사). 게이트 SQL 을 복사하지 않고 pgTAP 관용식으로 표현.
--   Part B — §45 기능 목록을 **실 RPC 로 구동한 savepoint 픽스처**로 검증(purchase→lot grant·FIFO consume·
--            failed refund·shortfall·PG partial refund·2차 부분취소·manual transfer·pre/post-PG replan·
--            external resolver·batch auto-full·cancel intent·deleted-user late PAID·expiry sweep·account delete·policy-cap).
--            정상 픽스처는 RPC 가 request.state=derive 를 같은 트랜잭션에서 유지하므로 SET CONSTRAINTS IMMEDIATE 로 재검증(§34).
--
-- 주: 전체가 begin…rollback 안에서 돌며 데이터는 남지 않는다. auth.users 최소 insert 는 on_auth_user_created
--     트리거로 profiles 를 자동 생성한다(0001). 픽스처는 owner/definer RPC 만으로 금융 상태를 만든다(§8·§34).

begin;
select plan(146);

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Part A — 스키마·카탈로그·ACL·불변식 (픽스처 불필요)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- A.1 신규 테이블 존재(§14·A.3)
select has_table('public', 'credit_lots', 'credit_lots 존재');
select has_table('public', 'refund_requests', 'refund_requests 존재');
select has_table('public', 'order_refund_attempts', 'order_refund_attempts 존재');
select has_table('public', 'payment_cancellation_events', 'payment_cancellation_events 존재');
select has_table('public', 'reconciliation_issues', 'reconciliation_issues 존재');
select has_table('public', 'credit_refund_shortfalls', 'credit_refund_shortfalls 존재');
select has_table('public', 'legacy_refund_backfill_evidence', 'legacy_refund_backfill_evidence 존재');
select has_table('public', 'cancellation_resolution_batches', 'cancellation_resolution_batches 존재');
select has_table('public', 'ops_cron_heartbeats', 'ops_cron_heartbeats 존재');

-- A.2 컬럼·타입(§2.2 bigint 확장·§7 pg 필드·§13 schema_version)
select has_column('public', 'order_refund_attempts', 'pg_idempotency_key', 'attempt.pg_idempotency_key 존재');
select has_column('public', 'order_refund_attempts', 'external_payout_ref', 'attempt.external_payout_ref 존재');
select col_type_is('public', 'order_refund_attempts', 'amount', 'bigint', 'attempt.amount = bigint');
select col_type_is('public', 'admin_actions_ledger', 'order_amount', 'bigint', 'admin_ledger.order_amount = bigint(§2.2)');
select has_column('public', 'admin_actions_ledger', 'ref_attempt_id', 'admin_ledger.ref_attempt_id 존재(§2.2)');
select has_column('public', 'admin_actions_ledger', 'ref_cancellation_id', 'admin_ledger.ref_cancellation_id 존재(§2.2)');
select has_column('public', 'admin_actions_ledger', 'payload_hash', 'admin_ledger.payload_hash 존재(§2.2)');
select has_column('public', 'credit_ledger', 'schema_version', 'credit_ledger.schema_version 존재(§13)');
select has_column('public', 'credit_ledger', 'ref_attempt_id', 'credit_ledger.ref_attempt_id 존재(§13)');

-- A.3 외부 RPC 존재(§16 external)
select has_function('public', 'admin_refund_begin', 'admin_refund_begin 존재');
select has_function('public', 'admin_refund_mark_pg_requested', 'admin_refund_mark_pg_requested 존재');
select has_function('public', 'admin_refund_record_pg_result', 'admin_refund_record_pg_result 존재');
select has_function('public', 'admin_refund_commit', 'admin_refund_commit 존재');
select has_function('public', 'admin_refund_commit_manual', 'admin_refund_commit_manual 존재');
select has_function('public', 'admin_refund_switch_to_manual', 'admin_refund_switch_to_manual 존재');
select has_function('public', 'admin_refund_release', 'admin_refund_release 존재');
select has_function('public', 'admin_refund_replan_pre_pg', 'admin_refund_replan_pre_pg 존재');
select has_function('public', 'admin_refund_replan_after_pg', 'admin_refund_replan_after_pg 존재');
select has_function('public', 'cancel_intent_begin', 'cancel_intent_begin 존재');
select has_function('public', 'cancel_intent_resolve', 'cancel_intent_resolve 존재');
select has_function('public', 'resolve_external_cancellation', 'resolve_external_cancellation 존재');
select has_function('public', 'resolve_external_cancellation_auto_full', 'resolve_external_cancellation_auto_full 존재');
select has_function('public', 'admin_soft_delete_account', 'admin_soft_delete_account 존재');
select has_function('public', 'sweep_expired', 'sweep_expired 존재');
select has_function('public', 'ops_cron_heartbeat', 'ops_cron_heartbeat 존재');
select has_function('public', 'derive_refund_request_state', 'derive_refund_request_state 존재');
select has_function('public', 'record_payment_cancellation_observation', 'record_payment_cancellation_observation 존재(관측 ingest)');
select has_function('public', 'mark_order_failed', 'mark_order_failed 존재(pending→failed RPC)');
select has_function('public', 'mark_order_canceled_unpaid', 'mark_order_canceled_unpaid 존재(무결제 취소 RPC)');
select has_function('public', 'create_or_update_member_consent', 'create_or_update_member_consent 존재(v2 — signup_bonus 로트)');
select has_function('public', 'create_generation_row', 'create_generation_row 존재(ops 무소비 생성행 RPC)');

-- A.4 ACL / 역할 테스트(§16) — external=service_role EXECUTE 有·anon/authenticated 無 / internal core·helper·trigger=service_role 실행 불가.
select ok(has_function_privilege('service_role',
  'public.admin_refund_begin(uuid,uuid,uuid,uuid,int,text,timestamptz,text)', 'EXECUTE'),
  'external admin_refund_begin: service_role EXECUTE 有');
select ok(has_function_privilege('service_role',
  'public.mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text)', 'EXECUTE'),
  'external mark_paid_and_grant: service_role EXECUTE 有');
select ok(not has_function_privilege('anon',
  'public.admin_refund_begin(uuid,uuid,uuid,uuid,int,text,timestamptz,text)', 'EXECUTE'),
  'external: anon EXECUTE 無');
select ok(not has_function_privilege('authenticated',
  'public.admin_refund_begin(uuid,uuid,uuid,uuid,int,text,timestamptz,text)', 'EXECUTE'),
  'external: authenticated EXECUTE 無');
select ok(not has_function_privilege('service_role', 'public.bp_sha256_hex(text)', 'EXECUTE'),
  'helper bp_sha256_hex: service_role 직접 실행 거부(§16)');
select ok(not has_function_privilege('service_role', 'public.bp_canonical_json(jsonb)', 'EXECUTE'),
  'helper bp_canonical_json: service_role 직접 실행 거부(§16)');
select ok(not has_function_privilege('service_role', 'public.bp_versioned_hash(jsonb,int)', 'EXECUTE'),
  'helper bp_versioned_hash: service_role 직접 실행 거부(§16)');
select ok(not has_function_privilege('service_role', 'public.jsonb_has_sensitive_key(jsonb)', 'EXECUTE'),
  'helper jsonb_has_sensitive_key: service_role 직접 실행 거부(§16)');
select ok(not has_function_privilege('service_role', 'public.derive_refund_request_state(uuid)', 'EXECUTE'),
  'core derive_refund_request_state: service_role 직접 실행 거부(§16)');
select ok(not has_function_privilege('service_role',
  'public.bp_credit_ledger_write(uuid,int,text,uuid,text,uuid,uuid,uuid,jsonb,text)', 'EXECUTE'),
  'core bp_credit_ledger_write: service_role 직접 실행 거부(§16)');
select function_privs_are('public', 'ledger_append_only_guard', ARRAY[]::text[],
  'service_role', ARRAY[]::text[], 'trigger ledger_append_only_guard: service_role 권한 집합 = 공집합(§16)');
select ok(has_function_privilege('service_role',
  'public.record_payment_cancellation_observation(uuid,text,text,bigint,timestamptz,timestamptz,jsonb)', 'EXECUTE'),
  'external record_payment_cancellation_observation: service_role EXECUTE 有');
select ok(not has_function_privilege('anon',
  'public.record_payment_cancellation_observation(uuid,text,text,bigint,timestamptz,timestamptz,jsonb)', 'EXECUTE'),
  'external record_payment_cancellation_observation: anon EXECUTE 無');

-- A.5 RLS(§32) — 금융 테이블 RLS enabled + policy 0.
select is((select relrowsecurity from pg_class where oid = 'public.credit_lots'::regclass), true,
  'credit_lots RLS enabled(§32)');
select is((select relrowsecurity from pg_class where oid = 'public.order_refund_attempts'::regclass), true,
  'order_refund_attempts RLS enabled(§32)');
select is((select count(*)::int from pg_policy where polrelid = 'public.credit_lots'::regclass), 0,
  'credit_lots policy 0(default deny·§32)');
select is((select count(*)::int from pg_policy where polrelid = 'public.order_refund_attempts'::regclass), 0,
  'order_refund_attempts policy 0(§32)');

-- A.6 hard-delete 차단 FK(§20) — confdeltype='r'(RESTRICT).
select is((select confdeltype from pg_constraint
             where conrelid = 'public.credit_lots'::regclass and contype = 'f'
               and confrelid = 'public.profiles'::regclass
               and conkey = (select array_agg(attnum order by attnum) from pg_attribute
                              where attrelid = 'public.credit_lots'::regclass and attname = 'user_id')),
  'r'::"char", 'credit_lots.user_id→profiles = ON DELETE RESTRICT(§20)');

-- A.7 CHECK 제약(§7·§11) 존재 + 시간 기반 CHECK 부재(§28).
select ok(exists(select 1 from pg_constraint
    where conrelid = 'public.order_refund_attempts'::regclass
      and conname = 'refund_attempts_preflight_coupling_check'),
  'attempt preflight all-or-none CHECK 존재(§7)');
select ok(exists(select 1 from pg_constraint
    where conrelid = 'public.order_refund_attempts'::regclass
      and conname = 'refund_attempts_payout_evidence_check'),
  'payout_evidence 정확 형태 CHECK 존재(§11)');
select ok(exists(select 1 from pg_constraint
    where conrelid = 'public.order_refund_attempts'::regclass
      and conname = 'uq_refund_attempts_external_payout_ref' and contype = 'u'),
  'external_payout_ref named unique 제약 존재(§2.1)');
select is((select count(*)::int from pg_constraint c
     where c.contype = 'c'
       and c.conrelid in ('public.credit_lots'::regclass, 'public.order_refund_attempts'::regclass,
                          'public.payment_cancellation_events'::regclass, 'public.credit_refund_shortfalls'::regclass,
                          'public.cancellation_resolution_batches'::regclass)
       and pg_get_constraintdef(c.oid) ~* '(now\(\)|clock_timestamp|current_timestamp|localtimestamp)'), 0,
  '금융 테이블 CHECK 에 시간 함수 부재(§28)');

-- A.8 봉투·카운터 불변식(§45 — 현 DB 데이터에 대한 truth). 게이트 SQL 복사가 아니라 pgTAP is_empty/is 관용식.
select is((select count(*)::int from public.credit_lots
             where consumed + refunded + refund_reserved > qty), 0,
  '불변식: 로트 consumed+refunded+refund_reserved <= qty');
select is((select count(*)::int from public.credit_lots
             where consumed < 0 or refunded < 0 or refund_reserved < 0), 0,
  '불변식: 로트 카운터 음수 없음');
select is((select count(*)::int
             from (select s.lot_id from public.credit_refund_shortfalls s
                     join public.credit_lots l on l.id = s.lot_id
                    group by s.lot_id, l.consumed
                   having sum(s.remaining_shortfall_qty) > l.consumed) q), 0,
  '불변식: per-lot Σ remaining_shortfall <= consumed(§45)');
select is((select count(*)::int from public.credit_refund_shortfalls s
             where s.recovered_qty + s.remaining_shortfall_qty <> s.initial_shortfall_qty), 0,
  '불변식: shortfall recovered+remaining = initial');
select is((select count(*)::int from public.refund_requests r
             where r.state <> public.derive_refund_request_state(r.id)), 0,
  '불변식: refund_requests.state = derive_refund_request_state(id) — mismatch 0(§4.10·§34)');
select is((select count(*)::int
             from public.member_accounts ma
             left join (select user_id, sum(qty - consumed - refunded - refund_reserved) as remain
                          from public.credit_lots where expired_at is null group by user_id) l
               on l.user_id = ma.user_id
            where ma.gen_credits <> coalesce(l.remain, 0)), 0,
  '불변식: 캐시 봉투 gen_credits = Σ live 로트 잔여(§45)');
select is((select count(*)::int from public.credit_lots l
            where l.refund_reserved <> coalesce((
                    select sum(a.qty) from public.order_refund_attempts a
                     where a.credit_lot_id = l.id
                       and a.state in ('prepared','pg_requested','pg_pending','pg_succeeded','manual_pending','manual_review')), 0)), 0,
  '불변식: 예약 봉투 lot.refund_reserved = Σ open attempts.qty(§45)');

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Part B — §45 기능 픽스처(실 RPC 구동). 픽스처 헬퍼는 pg_temp(트랜잭션 종료 시 소멸).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- 픽스처 헬퍼: 최소 auth.users insert → on_auth_user_created 로 profiles 자동 생성 → member_accounts.
create function pg_temp.mk_user(p_email text, p_admin boolean, p_deleted boolean)
returns uuid language plpgsql as $fn$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_email);
  insert into public.member_accounts (user_id, gen_credits, is_admin)
    values (v_id, 0, p_admin)
    on conflict (user_id) do update set is_admin = excluded.is_admin;
  if p_deleted then
    update public.profiles set deleted_at = now() where id = v_id;
  end if;
  return v_id;
end;
$fn$;

-- 픽스처 헬퍼: pending 주문 생성 + 결제확정(purchase 로트·캐시 지급). order_uuid 반환.
create function pg_temp.mk_paid_order(p_user uuid, p_product text, p_amount int, p_credits int)
returns uuid language plpgsql as $fn$
declare v_order uuid := gen_random_uuid(); v_pay text;
begin
  v_pay := replace(v_order::text, '-', '');
  perform public.create_pending_order(p_user, v_order, p_product, p_amount, p_credits,
                                      v_pay, 'portone', 'card', false);
  perform public.mark_paid_and_grant(v_order, 'pgtx_' || v_pay, p_amount,
                                     pg_catalog.jsonb_build_object('paid_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')),
                                     now(), 'https://receipt.example/' || v_pay);
  return v_order;
end;
$fn$;

-- 컨텍스트 저장(픽스처 id 를 이후 assertion 에서 재사용).
create temporary table pg_temp_ctx (k text primary key, u uuid, o uuid) on commit drop;

-- B.1 purchase → live 로트 grant + 캐시 지급.
select lives_ok($$
  insert into pg_temp_ctx (k, u)
    values ('customer', pg_temp.mk_user('cust1@test.local', false, false))
$$, 'B.1a 고객 유저 생성(auth.users→profiles→member_accounts)');
select lives_ok($$
  insert into pg_temp_ctx (k, o)
    values ('paid', pg_temp.mk_paid_order((select u from pg_temp_ctx where k = 'customer'), 'credits_10', 3000, 10))
$$, 'B.1b credits_10 주문 결제확정(purchase→lot grant·§45)');
select is((select count(*)::int from public.credit_lots
             where order_uuid = (select o from pg_temp_ctx where k = 'paid')
               and source = 'purchase' and expired_at is null and qty = 10), 1,
  'B.1c live purchase 로트 qty=10 정확히 1개(§45 purchase→lot grant)');
select is((select gen_credits from public.member_accounts
             where user_id = (select u from pg_temp_ctx where k = 'customer')), 10,
  'B.1d 캐시 봉투 gen_credits = 10');
select is((select count(*)::int from public.credit_ledger
             where event_type = 'purchase' and schema_version = 2
               and ref_order_uuid = (select o from pg_temp_ctx where k = 'paid')), 1,
  'B.1e purchase v2 원장 1행(§13)');

-- B.2 paid-FIFO consume — 생성 원자 소비(lot.consumed +1·캐시 −1·gen_consume 원장).
select lives_ok($$
  insert into pg_temp_ctx (k, o)
    values ('gen', (public.create_generation_and_consume(
                      (select u from pg_temp_ctx where k = 'customer'), 'boss')->>'generation_id')::uuid)
$$, 'B.2a create_generation_and_consume — queued+consume 원자(§19)');
select is((select gen_credits from public.member_accounts
             where user_id = (select u from pg_temp_ctx where k = 'customer')), 9,
  'B.2b consume 후 캐시 9(paid-FIFO 소비·§45)');
select is((select consumed from public.credit_lots
             where order_uuid = (select o from pg_temp_ctx where k = 'paid') and source = 'purchase'), 1,
  'B.2c purchase 로트 consumed = 1');

-- B.3 failed refund — 실패 생성의 로트 환급(consumed−1·캐시 +1).
select lives_ok($$
  select public.mark_generation_failed_and_refund((select o from pg_temp_ctx where k = 'gen'), 'fal_error')
$$, 'B.3a mark_generation_failed_and_refund — failed+lot refund 원자(§19·§45)');
select is((select gen_credits from public.member_accounts
             where user_id = (select u from pg_temp_ctx where k = 'customer')), 10,
  'B.3b failed refund 후 캐시 복원 10(§45 failed refund)');
select is((select count(*)::int from public.credit_ledger
             where event_type = 'gen_refund' and schema_version = 2
               and ref_gen_id = (select o from pg_temp_ctx where k = 'gen')), 1,
  'B.3c gen_refund v2 원장 1행');

-- B.4 PG partial refund saga — begin(portone)→mark_pg_requested→record_pg_result(succeeded)→commit.
select lives_ok($$
  insert into pg_temp_ctx (k, u, o)
    values ('admin', pg_temp.mk_user('admin1@test.local', true, false), null)
$$, 'B.4a 관리자 유저 생성(is_admin)');
select lives_ok($$
  insert into pg_temp_ctx (k, o)
    values ('req', (public.admin_refund_begin(
              gen_random_uuid(),
              (select u from pg_temp_ctx where k = 'admin'),
              (select u from pg_temp_ctx where k = 'customer'),
              (select o from pg_temp_ctx where k = 'paid'),
              3, 'customer requested partial refund', now(), 'portone_cancel')->>'request_id')::uuid)
$$, 'B.4b admin_refund_begin(portone·qty 3) — request+attempt prepared(§45 PG partial)');
select is((select refund_reserved from public.credit_lots
             where order_uuid = (select o from pg_temp_ctx where k = 'paid') and source = 'purchase'), 3,
  'B.4c 로트 refund_reserved = 3(예약 봉투)');
select is((select gen_credits from public.member_accounts
             where user_id = (select u from pg_temp_ctx where k = 'customer')), 7,
  'B.4d 예약 시 live 캐시 차감 10→7');
select cmp_ok((select state from public.refund_requests where id = (select o from pg_temp_ctx where k = 'req')),
  '=', 'prepared', 'B.4e request state = prepared');

-- B.4f 같은 주문에 open attempt 가 있으면 2차 begin 은 거부(uq_refund_attempts_order_open·§40 2차 부분취소 판단).
select throws_ok($$
  select public.admin_refund_begin(
    gen_random_uuid(),
    (select u from pg_temp_ctx where k = 'admin'),
    (select u from pg_temp_ctx where k = 'customer'),
    (select o from pg_temp_ctx where k = 'paid'),
    1, 'second concurrent refund', now(), 'portone_cancel')
$$, 'P0001', 'order_has_open_refund',
  'B.4f open attempt 존재 시 2차 begin → order_has_open_refund(§40)');

-- B.5 PG 실행: preflight → pg_requested, record_pg_result(succeeded), commit.
select lives_ok($$
  select public.admin_refund_mark_pg_requested(
    (select id from public.order_refund_attempts
       where request_id = (select o from pg_temp_ctx where k = 'req')),
    3000::bigint, 0::bigint, 3000::bigint,
    '[]'::jsonb,
    pg_catalog.jsonb_build_object('amount', 2700, 'reason',
      'BP_REFUND:' || (select id from public.order_refund_attempts
                         where request_id = (select o from pg_temp_ctx where k = 'req'))::text,
      'currentCancellableAmount', 3000))
$$, 'B.5a mark_pg_requested — preflight 5필드+body 저장(§7)');
select cmp_ok((select state from public.order_refund_attempts
                 where request_id = (select o from pg_temp_ctx where k = 'req')),
  '=', 'pg_requested', 'B.5b attempt state = pg_requested');
select lives_ok($$
  select public.admin_refund_record_pg_result(
    (select id from public.order_refund_attempts
       where request_id = (select o from pg_temp_ctx where k = 'req')),
    'succeeded',
    'cancel_' || (select id from public.order_refund_attempts
                    where request_id = (select o from pg_temp_ctx where k = 'req'))::text,
    'SUCCEEDED', 2700::bigint, 'https://receipt.example/cancel1',
    pg_catalog.jsonb_build_object('status', 'PARTIAL_CANCELLED'),
    now(), now())
$$, 'B.5c record_pg_result(succeeded) — SUCCEEDED event 매칭(§7)');
select lives_ok($$
  select public.admin_refund_commit(
    (select id from public.order_refund_attempts
       where request_id = (select o from pg_temp_ctx where k = 'req')))
$$, 'B.5d admin_refund_commit — rr→refunded 확정');
select cmp_ok((select state from public.order_refund_attempts
                 where request_id = (select o from pg_temp_ctx where k = 'req')),
  '=', 'committed', 'B.5e attempt state = committed');
select is((select refunded_credits from public.orders
             where order_uuid = (select o from pg_temp_ctx where k = 'paid')), 3,
  'B.5f orders.refunded_credits = 3(§45 PG partial refund)');
select is((select refunded from public.credit_lots
             where order_uuid = (select o from pg_temp_ctx where k = 'paid') and source = 'purchase'), 3,
  'B.5g 로트 refunded = 3·refund_reserved 복원');

-- B.6 manual transfer rail — switch_to_manual 후 commit_manual(5필드).
select lives_ok($$
  insert into pg_temp_ctx (k, o)
    values ('mreq', (public.admin_refund_begin(
              gen_random_uuid(),
              (select u from pg_temp_ctx where k = 'admin'),
              (select u from pg_temp_ctx where k = 'customer'),
              (select o from pg_temp_ctx where k = 'paid'),
              2, 'manual transfer refund', now(), 'manual_transfer')->>'request_id')::uuid)
$$, 'B.6a admin_refund_begin(manual rail·qty 2)');
-- manual rail 도 committed 진입 전 무이동 증빙이 필수 — prepared→manual_pending 은 switch_to_manual 경유(§7).
select lives_ok($$
  select public.admin_refund_switch_to_manual(
    (select id from public.order_refund_attempts
       where request_id = (select o from pg_temp_ctx where k = 'mreq')),
    (select u from pg_temp_ctx where k = 'admin'),
    'manual rail no movement verified', 0::bigint, '[]'::jsonb, 'admin_reconcile')
$$, 'B.6a2 switch_to_manual — 무이동 증빙 후 manual_pending 진입(§7)');
select lives_ok($$
  select public.admin_refund_commit_manual(
    (select id from public.order_refund_attempts
       where request_id = (select o from pg_temp_ctx where k = 'mreq')),
    (select u from pg_temp_ctx where k = 'admin'),
    'manual bank transfer completed', 'PAYOUT-REF-0001', gen_random_uuid())
$$, 'B.6b admin_refund_commit_manual — external_payout_ref+evidence(§7·§45 manual transfer)');
select cmp_ok((select rail from public.order_refund_attempts
                 where request_id = (select o from pg_temp_ctx where k = 'mreq')),
  '=', 'manual_transfer', 'B.6c manual attempt rail = manual_transfer');
select is((select count(*)::int from public.order_refund_attempts
             where request_id = (select o from pg_temp_ctx where k = 'mreq')
               and state = 'committed' and external_payout_ref = 'PAYOUT-REF-0001'
               and payout_evidence->>'method' = 'bank_transfer'), 1,
  'B.6d manual commit 5필드 확정(payout_evidence bank_transfer)');

-- B.7 pre-PG replan — 새 request 를 pre-PG 에서 released 로 재계획.
select lives_ok($$
  insert into pg_temp_ctx (k, o)
    values ('rreq', (public.admin_refund_begin(
              gen_random_uuid(),
              (select u from pg_temp_ctx where k = 'admin'),
              (select u from pg_temp_ctx where k = 'customer'),
              (select o from pg_temp_ctx where k = 'paid'),
              1, 'to be replanned', now(), 'portone_cancel')->>'request_id')::uuid)
$$, 'B.7a admin_refund_begin(replan 대상·qty 1)');
select lives_ok($$
  select public.admin_refund_replan_pre_pg(
    (select id from public.order_refund_attempts
       where request_id = (select o from pg_temp_ctx where k = 'rreq')),
    (select u from pg_temp_ctx where k = 'admin'), 'replanned before PG', false)
$$, 'B.7b admin_refund_replan_pre_pg — 예약 복원·released(§45 pre/post-PG replan)');
select cmp_ok((select state from public.order_refund_attempts
                 where request_id = (select o from pg_temp_ctx where k = 'rreq')),
  '=', 'released', 'B.7c replan 후 attempt state = released');

-- B.8 cancel intent — 고객 취소 의도 기록(§40 cancel intent).
select lives_ok($$
  insert into pg_temp_ctx (k, o)
    values ('intent_order',
      pg_temp.mk_paid_order((select u from pg_temp_ctx where k = 'customer'), 'credits_3', 1000, 3))
$$, 'B.8a cancel-intent 대상 주문 결제확정');
select lives_ok($$
  select public.cancel_intent_begin(
    (select u from pg_temp_ctx where k = 'admin'),
    (select o from pg_temp_ctx where k = 'intent_order'), now(), 'customer requested cancellation')
$$, 'B.8b cancel_intent_begin — 의도 기록·중복 방지 unique(§3.2)');
select is((select count(*)::int from public.admin_actions_ledger
             where action_type = 'cancel_intent'
               and order_uuid = (select o from pg_temp_ctx where k = 'intent_order')), 1,
  'B.8c cancel_intent 원장 1행(unique(action_type,order_uuid)·§3.5)');

-- B.9 deleted-user late PAID — 활성 상태에서 주문 생성 → 탈퇴 → 뒤늦은 PAID: 미지급·quarantine·issue(§40).
select lives_ok($$
  insert into pg_temp_ctx (k, u)
    values ('deleted', pg_temp.mk_user('gone@test.local', false, false))
$$, 'B.9a (탈퇴 예정) 유저 생성 — 주문은 활성 상태에서 만든다');
select lives_ok($$
  insert into pg_temp_ctx (k, o) values ('dorder', gen_random_uuid())
$$, 'B.9b0 탈퇴자 주문 uuid 준비');
select lives_ok($$
  select public.create_pending_order(
    (select u from pg_temp_ctx where k = 'deleted'),
    (select o from pg_temp_ctx where k = 'dorder'), 'credits_3', 1000, 3,
    replace((select o from pg_temp_ctx where k = 'dorder')::text, '-', ''), 'portone', 'card', false)
$$, 'B.9b1 활성 상태 pending 주문 생성');
select lives_ok($$
  update public.profiles set deleted_at = now()
   where id = (select u from pg_temp_ctx where k = 'deleted')
$$, 'B.9b2 주문 생성 후 프로필 soft-delete');
select lives_ok($$
  select public.mark_paid_and_grant(
    (select o from pg_temp_ctx where k = 'dorder'), 'pgtx_deleted', 1000,
    pg_catalog.jsonb_build_object('paid_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')), now(), null)
$$, 'B.9b3 탈퇴 후 늦은 PAID 확정(deleted PAID·§40)');
select is((select count(*)::int from public.credit_lots
             where order_uuid = (select o from pg_temp_ctx where k = 'dorder')
               and source = 'purchase' and expired_at is not null
               and expiration_reason = 'account_deleted'), 1,
  'B.9c 탈퇴자: quarantine purchase 로트(account_deleted)·크레딧 미지급(§40)');
select is((select coalesce(gen_credits, 0) from public.member_accounts
             where user_id = (select u from pg_temp_ctx where k = 'deleted')), 0,
  'B.9d 탈퇴자 캐시 0(late-paid 무지급)');
select is((select count(*)::int from public.reconciliation_issues
             where order_uuid = (select o from pg_temp_ctx where k = 'dorder')
               and type = 'late_paid' and state = 'open'), 1,
  'B.9e 탈퇴자 late PAID → late_paid issue open(§40)');

-- B.10 account delete(§39) — 미결제 의무 없는 유저 soft delete + live 로트 quarantine.
select lives_ok($$
  insert into pg_temp_ctx (k, u)
    values ('deletable', pg_temp.mk_user('bye@test.local', false, false))
$$, 'B.10a soft-delete 대상 유저 생성');
select lives_ok($$
  select public.admin_soft_delete_account((select u from pg_temp_ctx where k = 'deletable'))
$$, 'B.10b admin_soft_delete_account — 의무 없으면 soft delete(§39)');
select ok((select deleted_at is not null from public.profiles
             where id = (select u from pg_temp_ctx where k = 'deletable')),
  'B.10c soft delete 후 profiles.deleted_at 설정(§39)');

-- B.11 account delete 차단 — open refund attempt 보유 유저는 탈퇴 거부(409·§39).
select lives_ok($$
  select public.admin_refund_begin(
    gen_random_uuid(),
    (select u from pg_temp_ctx where k = 'admin'),
    (select u from pg_temp_ctx where k = 'customer'),
    (select o from pg_temp_ctx where k = 'intent_order'),
    1, 'open attempt for delete-block test', now(), 'portone_cancel')
$$, 'B.11a 삭제 차단용 open attempt 준비(intent_order qty 1)');
select throws_ok($$
  select public.admin_soft_delete_account((select u from pg_temp_ctx where k = 'customer'))
$$, 'P0001', 'open_refund_blocks_delete',
  'B.11b open refund 보유 유저 soft delete 거부(§39)');

-- B.12 expiry sweep — 만료 로트 sweep(빈 배치라도 정상 종료).
select lives_ok($$ select public.sweep_expired(100) $$,
  'B.12 sweep_expired — 만료 로트 처리·live 종료(§45 expiry sweep)');

-- B.13 cron heartbeat — reconcile 심박 기록(§29).
select lives_ok($$ select public.ops_cron_heartbeat('reconcile', 'start', null) $$,
  'B.13a ops_cron_heartbeat(reconcile,start)');
select lives_ok($$ select public.ops_cron_heartbeat('reconcile', 'success', null) $$,
  'B.13b ops_cron_heartbeat(reconcile,success)');
select is((select run_count > 0 from public.ops_cron_heartbeats where job_name = 'reconcile'), true,
  'B.13c heartbeat run_count 증가(§29)');

-- B.17 consent 보너스 로트(§Q1·G-1) — 신규 회원 insert 의 가입 보너스가 signup_bonus 로트와 원자 동기.
select lives_ok($$
  with ins as (insert into auth.users (id, email) values (gen_random_uuid(), 'newbie@test.local') returning id)
  insert into pg_temp_ctx (k, u) select 'newbie', id from ins
$$, 'B.17a 신규(멤버 행 없는) 유저 생성');
select is((select public.create_or_update_member_consent(
             (select u from pg_temp_ctx where k = 'newbie'), 5, true, true, 1, true, 1)), true,
  'B.17b consent 신규 insert → true(보너스 지급 경로)');
select is((select gen_credits from public.member_accounts
             where user_id = (select u from pg_temp_ctx where k = 'newbie')), 5,
  'B.17c 가입 보너스 캐시 5');
select is((select count(*)::int from public.credit_lots
             where user_id = (select u from pg_temp_ctx where k = 'newbie')
               and source = 'signup_bonus' and qty = 5 and expired_at is null), 1,
  'B.17d signup_bonus 로트 qty=5 정확히 1개(불변식 1 동기)');

-- B.18 organic 늦은 PAID(§40) — 무결제 취소된 주문에 늦은 PAID: paid 전환·quarantine·late_paid issue.
select lives_ok($$
  with ins as (insert into auth.users (id, email) values (gen_random_uuid(), 'late@test.local') returning id),
       mem as (insert into public.member_accounts (user_id, gen_credits) select id, 0 from ins returning user_id)
  insert into pg_temp_ctx (k, u) select 'late_user', user_id from mem
$$, 'B.18a late-PAID 유저 생성(member row 포함 — 실 회원 경로 동형)');
select lives_ok($$
  insert into pg_temp_ctx (k, o) values ('late_order', gen_random_uuid())
$$, 'B.18b late-PAID 주문 uuid 준비');
select lives_ok($$
  select public.create_pending_order(
    (select u from pg_temp_ctx where k = 'late_user'),
    (select o from pg_temp_ctx where k = 'late_order'), 'credits_3', 1000, 3,
    replace((select o from pg_temp_ctx where k = 'late_order')::text, '-', ''), 'portone', 'card', false)
$$, 'B.18c pending 주문 생성(create_pending_order·§18)');
select lives_ok($$
  select public.mark_order_canceled_unpaid(
    (select o from pg_temp_ctx where k = 'late_order'), 'CANCELLED', null, null)
$$, 'B.18d 무결제 취소 관측 종단(mark_order_canceled_unpaid)');
select lives_ok($$
  select public.mark_paid_and_grant(
    (select o from pg_temp_ctx where k = 'late_order'), 'pgtx_late', 1000,
    pg_catalog.jsonb_build_object('paid_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')), now(), null)
$$, 'B.18e canceled 주문 늦은 PAID — organic late PAID 흡수(§40)');
select cmp_ok((select status from public.orders
                 where order_uuid = (select o from pg_temp_ctx where k = 'late_order')),
  '=', 'paid', 'B.18f late PAID 후 status=paid 전환(canceled 유지 금지)');
select is((select count(*)::int from public.credit_lots
             where order_uuid = (select o from pg_temp_ctx where k = 'late_order')
               and source = 'purchase' and expired_at is not null
               and expiration_reason = 'order_canceled'), 1,
  'B.18g quarantine purchase 로트(order_canceled)·지급 0');
select is((select count(*)::int from public.reconciliation_issues
             where order_uuid = (select o from pg_temp_ctx where k = 'late_order')
               and type = 'late_paid' and state = 'open'), 1,
  'B.18h late_paid issue open 1');

-- B.19 외부 관측 ingest(§5·§11) — SUCCEEDED 이벤트 영속·unmatched issue·멱등·단건 resolver 자동 해소.
select lives_ok($$
  select public.record_payment_cancellation_observation(
    (select o from pg_temp_ctx where k = 'late_order'), 'ext_cancel_0001', 'SUCCEEDED', 1000,
    now(), now(), pg_catalog.jsonb_build_object('reason', 'PG console refund'))
$$, 'B.19a 외부 관측 SUCCEEDED 이벤트 영속(record_payment_cancellation_observation)');
select cmp_ok((select resolution_state from public.payment_cancellation_events
                 where cancellation_id = 'ext_cancel_0001'),
  '=', 'unmatched', 'B.19b 이벤트 unmatched 영속(가짜 매칭 없음)');
select is((select count(*)::int from public.reconciliation_issues
             where cancellation_id = 'ext_cancel_0001'
               and type = 'unmatched_cancellation' and state = 'open'), 1,
  'B.19c 미귀속 SUCCEEDED → unmatched_cancellation issue open');
select is((select (public.record_payment_cancellation_observation(
             (select o from pg_temp_ctx where k = 'late_order'), 'ext_cancel_0001', 'SUCCEEDED', 1000,
             now(), now(), '{}'::jsonb))->>'outcome'), 'no_op',
  'B.19d 동일 재관측 멱등 no_op(§9)');
select lives_ok($$
  select public.resolve_external_cancellation('ext_cancel_0001',
    (select u from pg_temp_ctx where k = 'admin'), 'admin resolved external refund', 3)
$$, 'B.19e 단건 resolver — 회수·orders 갱신(§45 external resolver)');
select cmp_ok((select state from public.reconciliation_issues
                 where cancellation_id = 'ext_cancel_0001' and type = 'unmatched_cancellation'),
  '=', 'resolved', 'B.19f resolver 가 unmatched issue 를 같은 트랜잭션에서 자동 해소');

-- B.20 mark_order_failed(§13 금융인접 status RPC) — pending→failed·멱등.
select lives_ok($$
  insert into pg_temp_ctx (k, o) values ('fail_order', gen_random_uuid())
$$, 'B.20a failed 전이 대상 주문 uuid 준비');
select lives_ok($$
  select public.create_pending_order(
    (select u from pg_temp_ctx where k = 'customer'),
    (select o from pg_temp_ctx where k = 'fail_order'), 'credits_3', 1000, 3,
    replace((select o from pg_temp_ctx where k = 'fail_order')::text, '-', ''), 'portone', 'card', false)
$$, 'B.20b pending 주문 생성');
select is((select (public.mark_order_failed(
             (select o from pg_temp_ctx where k = 'fail_order'), 'FAILED', 'stale_expired', null))->>'outcome'),
  'failed', 'B.20c mark_order_failed — pending→failed 전이');
select is((select (public.mark_order_failed(
             (select o from pg_temp_ctx where k = 'fail_order'), 'FAILED', 'stale_expired', null))->>'outcome'),
  'no_op', 'B.20d mark_order_failed 재호출 멱등 no_op');

-- B.14 §34 — deferred derive 트리거 재검증: 픽스처 후 SET CONSTRAINTS ALL IMMEDIATE 로 봉투/derive 즉시 확인.
select lives_ok($$ set constraints all immediate $$,
  'B.14 SET CONSTRAINTS ALL IMMEDIATE — deferred derive 불변식 즉시 성립(§34)');

-- B.15 최종 봉투 재확인 — 모든 픽스처 반영 후에도 캐시 봉투 불변식 유지.
select is((select count(*)::int
             from public.member_accounts ma
             left join (select user_id, sum(qty - consumed - refunded - refund_reserved) as remain
                          from public.credit_lots where expired_at is null group by user_id) l
               on l.user_id = ma.user_id
            where ma.gen_credits <> coalesce(l.remain, 0)), 0,
  'B.15 픽스처 후 캐시 봉투 불변식 유지(gen_credits = Σ live 잔여)');
select is((select count(*)::int from public.refund_requests r
             where r.state <> public.derive_refund_request_state(r.id)), 0,
  'B.16 픽스처 후 derive mismatch 0(§4.10)');

select * from finish();
rollback;
