-- 0064: legacy stub removal — 안정화 확인 후, 0063 이 fail-closed stub 으로 굳힌 구 함수를 자체 drop 한다.
--       § 매핑: §21(3분리의 마지막 단계 — stub 제거)·§22(journal)·§30(적용은 glob 아닌 journal/배포 증거 기준).
--
-- 적용: management API query 엔드포인트로 파일 전문 실행
--   POST https://api.supabase.com/v1/projects/<ref>/database/query  (Bearer SUPABASE_ACCESS_TOKEN)
--
-- 전제(§21·§44 배포 순서 20~21): 0063 적용 후 충분한 안정화 기간 동안 구 함수 호출 0(Sentry/로그 확인) 확인.
--   canary 에는 미적용 가능(§30 — phase manifest 는 after-0062 / after-0063 / after-0064 로 분리). 본 파일 적용 직전
--   post-0062-go-no-go.sql 전 gate 재실행(§44-21). drop 은 되돌릴 수 없으므로 fix-forward = 0062 정의 재적용.
--
-- 대상(0063 S2 의 3 stub — 전부 신규 RPC 로 대체 완료):
--   ① mark_paid_and_grant(uuid,text,int,jsonb)  → mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text)
--   ② consume_gen_credit(uuid)                   → create_generation_and_consume(uuid,text) 내부 consume_gen_credit_v2
--   ③ refund_gen_credit(uuid)                    → mark_generation_failed_and_refund(uuid,text,int) 내부 refund_gen_credit_v2

begin;

-- ── 선행 가드(§21·§22) — 0063 hardening 이 journal 에 없으면 적용 금지(순서 위반 fail-closed). ──
do $$
begin
  if not exists (select 1 from public.schema_migration_journal where version = '0063_write_hardening') then
    raise exception 'stub_removal_requires_0063: apply 0063_write_hardening first' using errcode = 'P0001';
  end if;
end $$;

drop function if exists public.mark_paid_and_grant(uuid, text, int, jsonb);
drop function if exists public.consume_gen_credit(uuid);
drop function if exists public.refund_gen_credit(uuid);

-- ── postflight(실패 시 전체 롤백) — stub 소멸 + keeper 존치 확인. ──
do $$
begin
  -- 1. 3 stub 은 완전히 사라져야 함.
  if to_regprocedure('public.mark_paid_and_grant(uuid,text,int,jsonb)') is not null
     or to_regprocedure('public.consume_gen_credit(uuid)') is not null
     or to_regprocedure('public.refund_gen_credit(uuid)') is not null then
    raise exception 'stub_removal_still_present' using errcode = 'P0001';
  end if;

  -- 2. keeper 함수(6-arg mark_paid_and_grant·v2 consume/refund·상위 RPC)는 살아있어야 함.
  if to_regprocedure('public.mark_paid_and_grant(uuid,text,int,jsonb,timestamptz,text)') is null
     or to_regprocedure('public.consume_gen_credit_v2(uuid,uuid)') is null
     or to_regprocedure('public.refund_gen_credit_v2(uuid,int)') is null
     or to_regprocedure('public.create_generation_and_consume(uuid,text)') is null
     or to_regprocedure('public.mark_generation_failed_and_refund(uuid,text,int)') is null then
    raise exception 'stub_removal_keeper_missing' using errcode = 'P0001';
  end if;

  raise notice 'legacy stub removal OK';
end $$;

-- ── §22 migration journal ──
insert into public.schema_migration_journal (version, migration_hash, manifest_hash, app_commit)
select '0064_legacy_stub_removal', null, null, null
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
