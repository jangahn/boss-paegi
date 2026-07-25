-- ai_generations.gen_params(생성 provenance) 컬럼 + 어드민 전용 잠금.
-- 생성 당시 파라미터·프롬프트·단계 스냅샷(어드민 전용). NULL = 기능 배포 전/기록 없음(레거시).
-- **어드민 전용화**: gen_params(전체 프롬프트/파라미터)가 owner-read 로 유저에 노출되면 안 되므로,
--   ai_generations 의 anon/authenticated 직접 SELECT 를 revoke + 미사용 owner-read RLS 정책을 drop.
--   (앱의 ai_generations 읽기 15경로 전부 service_role — 정적 전수 확인, 클라/RLS 직접 read 0.)
-- 코드 배포와 동시/선행(0070 먼저) — gen_params 쓰기(선저장/복구)가 이 grant 를 필요로 함.

-- 1) gen_params 컬럼(nullable, default 없음) + object 최소 CHECK + comment
alter table public.ai_generations add column if not exists gen_params jsonb;
alter table public.ai_generations drop constraint if exists ai_generations_gen_params_obj;
alter table public.ai_generations add constraint ai_generations_gen_params_obj
  check (gen_params is null or jsonb_typeof(gen_params) = 'object');
comment on column public.ai_generations.gen_params is
  '생성 provenance(schemaVersion=1) — config/analyze/generation(candidates)/postprocess/picked 스냅샷. 어드민 전용. NULL=기록 없음(레거시). 비밀/URL/이미지 bytes 미포함(lib/character-gen/provenance.ts 계약).';

-- 2) service_role UPDATE(gen_params) grant — 0063 operational 예외에 편입(금융 아님).
--    exact-set 동기화: 0063:64-66 grant(과거파일 불변)·eslint allowedUpdateColumns·G-43(c)·final.md·runbook.
grant update (gen_params) on table public.ai_generations to service_role;

-- 3) 어드민 전용화 — anon/authenticated/public 직접 SELECT revoke + 미사용 owner-read 정책 drop.
--    service_role SELECT 는 유지(어드민/서버 경로). 0063 은 SELECT 를 안 건드렸음(G-43/H4 미검사 영역).
revoke select on table public.ai_generations from anon, authenticated, public;
drop policy if exists "ai_generations: owner read" on public.ai_generations;

-- 4) postflight 불변식(위반 시 abort) — service_role gen_params UPDATE 有 · anon/auth SELECT 無 ·
--    owner-read 정책 無 · 금융인접(credit_lot_id) service_role UPDATE 여전히 無.
do $$
begin
  if not exists (
    select 1 from information_schema.role_column_grants
    where table_schema='public' and table_name='ai_generations'
      and grantee='service_role' and privilege_type='UPDATE' and column_name='gen_params'
  ) then raise exception '0070 postflight: service_role missing UPDATE(gen_params)'; end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and table_name='ai_generations'
      and grantee in ('anon','authenticated') and privilege_type='SELECT'
  ) then raise exception '0070 postflight: anon/authenticated still have SELECT on ai_generations'; end if;

  if exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='ai_generations' and policyname='ai_generations: owner read'
  ) then raise exception '0070 postflight: owner-read policy still present'; end if;

  if exists (
    select 1 from information_schema.role_column_grants
    where table_schema='public' and table_name='ai_generations'
      and grantee='service_role' and privilege_type='UPDATE' and column_name='credit_lot_id'
  ) then raise exception '0070 postflight: service_role must NOT update credit_lot_id (financial-adjacent)'; end if;
end $$;

notify pgrst, 'reload schema';
