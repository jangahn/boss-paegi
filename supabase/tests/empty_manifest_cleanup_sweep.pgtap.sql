-- 0101 — 빈 매니페스트 탈퇴 정리의 즉시 스윕 계약 (소스 레벨 봉인)
begin;
select plan(3);

select ok(
  (
    select p.prosrc !~ '2 hours 5 minutes'
      from pg_catalog.pg_proc p
     where p.oid = to_regprocedure(
       'public.bp_0084_admin_soft_delete_account_impl(uuid)'
     )
  ),
  'enqueue no longer forces the 2h5m final-sweep floor'
);
select ok(
  (
    select p.prosrc ~ 'coalesce\(v_horizon, pg_catalog\.clock_timestamp\(\)\)'
      from pg_catalog.pg_proc p
     where p.oid = to_regprocedure(
       'public.bp_0084_admin_soft_delete_account_impl(uuid)'
     )
  ),
  'final sweep is anchored to the intent horizon alone'
);
-- claim/finish 의 horizon 재연장·scrub fence 는 무접촉이어야 한다(토큰 ABA 유지).
select ok(
  (
    select p.prosrc ~ 'final_sweep_after'
      from pg_catalog.pg_proc p
     where p.oid = to_regprocedure(
       'public.claim_account_deletion_cleanup_v2(uuid, integer, integer)'
     )
  ),
  'claim v2 still owns its final-sweep gate'
);

select * from finish();
rollback;
