-- 0005: 캐릭터 생성 파이프라인 중단 복구
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣기.
--
-- 생성된 후보 3장을 Supabase(dolls 버킷의 candidates/ prefix)에 복사 보관해,
-- 고르기 전 이탈/실패/생성중 끊김에서 갤러리로 이어서 진행할 수 있게 한다.

-- 1. 후보 URL 보관 + 선택 결과 연결 + picked 상태
alter table public.ai_generations
  add column if not exists candidate_urls jsonb not null default '[]'::jsonb,
  add column if not exists picked_doll_id uuid references public.dolls(id) on delete set null;

-- status 에 'picked' 추가 (고르기 완료)
alter table public.ai_generations drop constraint if exists ai_generations_status_check;
alter table public.ai_generations
  add constraint ai_generations_status_check
  check (status in ('queued', 'done', 'failed', 'picked'));

-- 미완결 generation 조회용 인덱스 (owner + status + 최신순)
create index if not exists ai_generations_owner_status_idx
  on public.ai_generations (owner_id, status, created_at desc);

-- 참고: dolls 버킷을 그대로 재사용한다 (별도 버킷 불필요).
--  - 확정 인형:  {owner}/{dollId}.png
--  - 생성 후보:  {owner}/candidates/{genId}/{0,1,2}.jpg
-- 24시간 지난 미선택 후보는 서버(/api/generations)에서 lazy 정리.
