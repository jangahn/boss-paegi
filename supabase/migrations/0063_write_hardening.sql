-- 0063: write hardening — 0062(additive) 가 공존시킨 구코드 직접 DML 을 차단하는 파괴적(breaking) 단계.
--       § 매핑: §17(orders/member/ai SELECT-only)·§21(3분리의 hardening 단계)·§16(exact ACL)·§22(journal).
--
-- 적용: management API query 엔드포인트로 파일 전문 실행
--   POST https://api.supabase.com/v1/projects/<ref>/database/query  (Bearer SUPABASE_ACCESS_TOKEN)
--
-- 전제(§21·§44 배포 순서 13): 0062 additive 적용 완료 → v2 앱(모든 write 신규 RPC 경유) 배포·canary → direct DML 0 실측
--   → 그 다음에 본 파일 적용. 0062 는 기존 orders/member/ai 의 operational 컬럼 UPDATE 를 grant 로 남겨 구앱 drain 을
--   허용했다(0062 S12/A.5.2). 본 파일은 그 잔여 grant 를 전부 회수해 세 테이블을 service_role SELECT-only 로 굳힌다.
--   이후 모든 write 는 0062 의 SECURITY DEFINER RPC(mark_paid_and_grant·create_pending_order·create_generation_and_consume·
--   mark_generation_failed_and_refund·admin_* saga·admin_settle_stuck_order·admin_soft_delete_account 등)로만 가능하다.
--
-- 롤백/fix-forward(§21·§44): 본 파일은 데이터 무변경(권한·함수 본문만). 문제 시 0062 의 grant 재부여로 즉시 복구 가능
--   (canary off). 안정화 확인 후 legacy stub 함수는 0064 에서 drop.
--
-- runbook(§22): 적용 전 `set lock_timeout='5s'; set statement_timeout='60s';` 권장. 응답 유실 시 재실행 전
--   schema_migration_journal 에서 '0063_write_hardening' 행 존재 여부로 성공 판정(같은 version 재적용은 멱등).

begin;

-- ── S0. 대상 3테이블 짧은 EXCLUSIVE LOCK(권한 변경 중 write race 이중 방어). 신규 saga 테이블은 미대상. ──
lock table public.orders, public.member_accounts, public.ai_generations in exclusive mode;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S1. orders / member_accounts / ai_generations 하드닝 (§13/§17 — operational 컬럼 예외 유지).
--   테이블 레벨 DML(INSERT/UPDATE/DELETE)은 전량 회수하고, §13 이 정의한 **operational 컬럼만**
--   column-level UPDATE 로 남긴다(명세 final §13 "operational 컬럼 예외"):
--     orders          : pg_status · raw · error_message           (refund_state 는 legacy — 회수)
--     member_accounts : email                                     (consent 계열은 definer RPC 경유 — 회수)
--     ai_generations  : status · fail_reason · candidate_urls · fal_request_id · fal_request_ids ·
--                       picked_doll_id · picked_index · cost_cents · role
--   금융/금융인접(status·canceled_at·paid_at·payment_id·pg_tx_id·amount·credits·refunded_*·
--   cancel-intent 4·receipt·gen_credits·credit_lot_id·consumed_at·refunded_at·version)은 grant 0 —
--   0062 definer RPC(mark_order_failed·mark_order_canceled_unpaid·record_payment_cancellation_observation·
--   mark_paid_and_grant·saga RPC 군)만이 유일 경로다. anon/authenticated/RLS 정책은 손대지 않는다.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
revoke all privileges on table public.orders          from service_role;
revoke all privileges on table public.member_accounts  from service_role;
revoke all privileges on table public.ai_generations   from service_role;

-- 0062(S12·A.5.2)가 부여한 **컬럼 레벨** UPDATE grant 를 일단 전량 회수한 뒤(테이블 REVOKE 는 컬럼
-- grant 를 자동 제거하지 않음 — 미보유 컬럼 회수는 WARNING 일 뿐 에러 아님) operational 만 재부여한다.
revoke update (pg_status, raw, error_message, refund_state)
  on table public.orders from service_role;
revoke update (email, age_confirmed_at, terms_agreed_at, privacy_agreed_at,
               terms_version, privacy_version, reconsent_required, abuse_status)
  on table public.member_accounts from service_role;
revoke update (status, fal_request_id, cost_cents, candidate_urls,
               picked_doll_id, picked_index, fal_request_ids, fail_reason, role)
  on table public.ai_generations from service_role;

-- 읽기 재부여 + operational 컬럼 UPDATE 재부여(§13 exact set — H2 가 이 목록과 1:1 대조).
grant select on table public.orders          to service_role;
grant select on table public.member_accounts to service_role;
grant select on table public.ai_generations  to service_role;

grant update (pg_status, raw, error_message) on table public.orders to service_role;
grant update (email) on table public.member_accounts to service_role;
grant update (status, fail_reason, candidate_urls, fal_request_id, fal_request_ids,
              picked_doll_id, picked_index, cost_cents, role)
  on table public.ai_generations to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S2. 구 함수 fail-closed stub (§21·§16) — 본문을 RAISE 로 교체하되 시그니처 유지 + execute 회수.
--   0062 가 새 이름/오버로드로 대체했지만 삭제하지 않은 구 구현이 PostgREST RPC 로 여전히 호출 가능한 표면:
--     ① mark_paid_and_grant(uuid,text,int,jsonb)   — 0058 4-arg. 0062 6-arg(+paid_at,+receipt_url)로 대체(구 RPC overload).
--     ② consume_gen_credit(uuid)                    — 0010 1-arg. 0062 consume_gen_credit_v2(uuid,uuid)로 대체.
--     ③ refund_gen_credit(uuid)                     — 0010 1-arg. 0062 refund_gen_credit_v2(uuid,int)로 대체.
--   create or replace 는 기존 ACL 을 보존하므로(구앱이 갖던 service_role EXECUTE 잔존) 각 stub 뒤에 revoke all 필수.
--   본문 RAISE(errcode P0001) + ACL 제거의 이중 fail-closed. 함수 자체 제거는 0064.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ① 구 mark_paid_and_grant 4-arg overload
create or replace function public.mark_paid_and_grant(
  p_order_uuid uuid, p_pg_tx_id text, p_price int, p_raw jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'legacy_mark_paid_and_grant_4arg_removed: use mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text) [0062]'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.mark_paid_and_grant(uuid, text, int, jsonb)
  from public, anon, authenticated, service_role;

-- ② 구 consume_gen_credit 1-arg
create or replace function public.consume_gen_credit(p_user uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'legacy_consume_gen_credit_removed: use create_generation_and_consume(uuid,text) [0062]'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.consume_gen_credit(uuid)
  from public, anon, authenticated, service_role;

-- ③ 구 refund_gen_credit 1-arg
create or replace function public.refund_gen_credit(p_user uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'legacy_refund_gen_credit_removed: use mark_generation_failed_and_refund(uuid,text,int) [0062]'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.refund_gen_credit(uuid)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S3. exact ACL 재확인(§16) — 신규 saga 테이블·2원장은 이미 0062 에서 service_role SELECT-only.
--   본 파일에서 새로 바뀐 ACL 표면은 (S1) 3테이블·(S2) stub 3함수뿐이므로 여기서 별도 재부여는 없다.
--   외부 RPC 27종의 service_role EXECUTE·core/helper/trigger 의 execute 0 은 0062 가 확정 — 불변 유지.
--   (전수 검증은 post-0062-go-no-go.sql G-31·G-43 에서.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S4. hardening postflight (실패 시 전체 롤백) — S1/S2 최종 상태를 카탈로그로 검증.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
do $$
declare v int;
begin
  -- H1. 세 테이블에 service_role 의 INSERT/UPDATE/DELETE 테이블 grant 0.
  select count(*) into v
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('orders', 'member_accounts', 'ai_generations')
     and g.grantee = 'service_role'
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if v > 0 then raise exception 'hardening_H1_table_dml_grant_remains: %', v using errcode = 'P0001'; end if;

  -- H2. 세 테이블의 service_role 컬럼 레벨 UPDATE grant = §13 operational exact set(초과·부족 모두 위반).
  select count(*) into v
    from (
      select g.table_name, g.column_name
        from information_schema.role_column_grants g
       where g.table_schema = 'public'
         and g.table_name in ('orders', 'member_accounts', 'ai_generations')
         and g.grantee = 'service_role'
         and g.privilege_type = 'UPDATE'
      except
      select * from (values
        ('orders', 'pg_status'), ('orders', 'raw'), ('orders', 'error_message'),
        ('member_accounts', 'email'),
        ('ai_generations', 'status'), ('ai_generations', 'fail_reason'),
        ('ai_generations', 'candidate_urls'), ('ai_generations', 'fal_request_id'),
        ('ai_generations', 'fal_request_ids'), ('ai_generations', 'picked_doll_id'),
        ('ai_generations', 'picked_index'), ('ai_generations', 'cost_cents'),
        ('ai_generations', 'role')) allow(table_name, column_name)
    ) extra;
  if v > 0 then raise exception 'hardening_H2_unexpected_column_grant: %', v using errcode = 'P0001'; end if;
  select count(*) into v
    from (
      select * from (values
        ('orders', 'pg_status'), ('orders', 'raw'), ('orders', 'error_message'),
        ('member_accounts', 'email'),
        ('ai_generations', 'status'), ('ai_generations', 'fail_reason'),
        ('ai_generations', 'candidate_urls'), ('ai_generations', 'fal_request_id'),
        ('ai_generations', 'fal_request_ids'), ('ai_generations', 'picked_doll_id'),
        ('ai_generations', 'picked_index'), ('ai_generations', 'cost_cents'),
        ('ai_generations', 'role')) allow(table_name, column_name)
      except
      select g.table_name, g.column_name
        from information_schema.role_column_grants g
       where g.table_schema = 'public'
         and g.table_name in ('orders', 'member_accounts', 'ai_generations')
         and g.grantee = 'service_role'
         and g.privilege_type = 'UPDATE'
    ) missing;
  if v > 0 then raise exception 'hardening_H2_operational_grant_missing: %', v using errcode = 'P0001'; end if;

  -- H3. 세 테이블에 service_role SELECT 는 유지(운영 조회 경로 보존).
  select count(*) into v
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('orders', 'member_accounts', 'ai_generations')
     and g.grantee = 'service_role'
     and g.privilege_type = 'SELECT';
  if v <> 3 then raise exception 'hardening_H3_select_grant_missing: %', v using errcode = 'P0001'; end if;

  -- H4. 세 테이블에 anon/authenticated/PUBLIC 의 INSERT/UPDATE/DELETE grant 0(§17 불변 확인).
  select count(*) into v
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('orders', 'member_accounts', 'ai_generations')
     and g.grantee in ('anon', 'authenticated', 'PUBLIC')
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if v > 0 then raise exception 'hardening_H4_public_dml_grant: %', v using errcode = 'P0001'; end if;

  -- H5. 3 stub 함수에 owner 외 EXECUTE 잔여 0. proacl is null(=PUBLIC 기본 EXECUTE)도 위반.
  --     (owner 자기 grant 는 REVOKE ALL 후에도 남는 PostgreSQL 정상 상태 — 위반 아님.)
  select count(*) into v
    from pg_proc p
   where p.oid in (
           to_regprocedure('public.mark_paid_and_grant(uuid,text,int,jsonb)'),
           to_regprocedure('public.consume_gen_credit(uuid)'),
           to_regprocedure('public.refund_gen_credit(uuid)'))
     and ( p.proacl is null
        or exists (select 1 from aclexplode(p.proacl) a
                    where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) );
  if v > 0 then raise exception 'hardening_H5_stub_execute_remains: %', v using errcode = 'P0001'; end if;

  -- H6. 6-arg mark_paid_and_grant(keeper)·v2 consume/refund keeper 는 살아있어야 함.
  if to_regprocedure('public.mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text)') is null
     or to_regprocedure('public.consume_gen_credit_v2(uuid,uuid)') is null
     or to_regprocedure('public.refund_gen_credit_v2(uuid,int)') is null then
    raise exception 'hardening_H6_keeper_missing' using errcode = 'P0001';
  end if;

  -- H7. keeper 외부 RPC 는 service_role EXECUTE 유지(대표 3종 spot check — mark_paid_and_grant 6-arg 포함).
  select count(*) into v
    from pg_proc p
   where p.oid in (
           to_regprocedure('public.mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text)'),
           to_regprocedure('public.create_pending_order(uuid,uuid,text,int,int,text,text,text,boolean)'),
           to_regprocedure('public.admin_refund_commit(uuid)'))
     and exists (
           select 1 from aclexplode(p.proacl) a
            join pg_roles r on r.oid = a.grantee
           where r.rolname = 'service_role' and a.privilege_type = 'EXECUTE');
  if v <> 3 then raise exception 'hardening_H7_keeper_grant_missing: %', v using errcode = 'P0001'; end if;

  raise notice 'hardening postflight OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- S5. §22 migration journal — 적용 사실 원자 기록(0062 가 생성한 private·SELECT-only 테이블 재사용).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
insert into public.schema_migration_journal (version, migration_hash, manifest_hash, app_commit)
select '0063_write_hardening', null, null, null
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
