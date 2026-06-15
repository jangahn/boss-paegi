-- 0007: 모든 테이블에 updated_at + version 감사 컬럼 (데이터 확인/트러블슈팅용)
--
-- 적용: management API query 엔드포인트로 직접 실행
--   POST https://api.supabase.com/v1/projects/<ref>/database/query  (Bearer SUPABASE_ACCESS_TOKEN)
-- UPDATE 마다 트리거가 updated_at=now(), version+=1 자동 갱신.

-- 공통 트리거 함수: 행 수정 시 updated_at·version 자동 갱신
create or replace function public.set_updated_at_and_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version := coalesce(old.version, 0) + 1;
  return new;
end;
$$;

-- 4개 테이블에 동일 적용: 컬럼 추가 → 기존행 backfill(updated_at=created_at) → 트리거
-- (backfill 은 트리거 생성 前에 실행돼야 updated_at 이 created_at 으로 들어감)
do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'dolls', 'scores', 'ai_generations'] loop
    execute format(
      'alter table public.%I add column if not exists updated_at timestamptz not null default now()', t);
    execute format(
      'alter table public.%I add column if not exists version int not null default 1', t);
    execute format(
      'update public.%I set updated_at = created_at where updated_at <> created_at', t);
    execute format('drop trigger if exists trg_%s_audit on public.%I', t, t);
    execute format(
      'create trigger trg_%s_audit before update on public.%I '
      'for each row execute function public.set_updated_at_and_version()', t, t);
  end loop;
end;
$$;
