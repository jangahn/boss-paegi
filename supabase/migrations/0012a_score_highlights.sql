-- 0012a: scores 의 highlight_* 분리 — score_highlights 테이블 생성 + backfill (ADDITIVE)
--
-- 적용: management API query 엔드포인트. expand→deploy→contract 의 expand 단계.
-- 컬럼 drop 은 코드가 score_highlights 로 전환·배포된 뒤 0012b 에서.

create table if not exists public.score_highlights (
  score_id uuid primary key references public.scores(id) on delete cascade,
  highlight_clip_path text,
  highlight_upload_id text,
  highlight_status text,
  highlight_clip_mime text,
  highlight_clip_size int,
  highlight_delta int,
  highlight_window_ms int,
  highlight_expires_at timestamptz,
  highlight_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table public.score_highlights enable row level security;

-- public read (=scores 와 동일, 비민감 공개 하이라이트 메타). 클라 write 정책 없음 → admin/service-role 만.
drop policy if exists "score_highlights: public read" on public.score_highlights;
create policy "score_highlights: public read"
  on public.score_highlights for select using (true);

revoke insert, update, delete on public.score_highlights from anon, authenticated;
grant all on public.score_highlights to service_role;

-- 감사 트리거 (0007 set_updated_at_and_version 재사용)
drop trigger if exists trg_score_highlights_audit on public.score_highlights;
create trigger trg_score_highlights_audit
  before update on public.score_highlights
  for each row execute function public.set_updated_at_and_version();

-- backfill: highlight_* 9개 중 하나라도 non-null 인 scores → score_highlights
insert into public.score_highlights (
  score_id, highlight_clip_path, highlight_upload_id, highlight_status,
  highlight_clip_mime, highlight_clip_size, highlight_delta, highlight_window_ms,
  highlight_expires_at, highlight_deleted_at
)
select
  id, highlight_clip_path, highlight_upload_id, highlight_status,
  highlight_clip_mime, highlight_clip_size, highlight_delta, highlight_window_ms,
  highlight_expires_at, highlight_deleted_at
from public.scores
where highlight_clip_path is not null
   or highlight_upload_id is not null
   or highlight_status is not null
   or highlight_clip_mime is not null
   or highlight_clip_size is not null
   or highlight_delta is not null
   or highlight_window_ms is not null
   or highlight_expires_at is not null
   or highlight_deleted_at is not null
on conflict (score_id) do nothing;
