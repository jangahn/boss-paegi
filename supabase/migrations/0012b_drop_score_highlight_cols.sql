-- 0012b: scores 의 highlight_* 컬럼 제거 (contract 단계)
--
-- 적용: management API. **반드시 코드가 score_highlights 로 전환·배포된 뒤** 실행.
-- 0012a backfill 이후 전환 윈도우 중 구 코드가 scores 에 쓴 하이라이트가 있을 수 있어
-- drop 직전 동일 OR 조건으로 재-backfill(on conflict do nothing) 후 컬럼 제거.

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

alter table public.scores drop column if exists highlight_clip_path;
alter table public.scores drop column if exists highlight_upload_id;
alter table public.scores drop column if exists highlight_status;
alter table public.scores drop column if exists highlight_clip_mime;
alter table public.scores drop column if exists highlight_clip_size;
alter table public.scores drop column if exists highlight_delta;
alter table public.scores drop column if exists highlight_window_ms;
alter table public.scores drop column if exists highlight_expires_at;
alter table public.scores drop column if exists highlight_deleted_at;
