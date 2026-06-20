-- 게임 하이라이트 클립 — scores 에 메타 컬럼 + public storage 버킷
-- 클립 바이트는 클라가 Supabase 로 직접 업로드(서명 URL), 서버는 path/메타만 검증·기록.
-- 전부 nullable: 녹화 미지원/미공유 시 클립 없이 카드만으로 동작해야 함.

alter table public.scores add column if not exists highlight_clip_path text;
alter table public.scores add column if not exists highlight_upload_id text;   -- 업로드별 uuid (재시도/중복클릭/두 탭 충돌 방지, 경로 격리)
alter table public.scores add column if not exists highlight_status text;      -- 'attached' 면 클립 확정 (score당 1회만)
alter table public.scores add column if not exists highlight_clip_mime text;
alter table public.scores add column if not exists highlight_clip_size int;    -- bytes (서버 info() 검증값)
alter table public.scores add column if not exists highlight_delta int;        -- 클립 구간 점수 상승폭 (표시용, 서버 클램프)
alter table public.scores add column if not exists highlight_window_ms int;    -- 클립 길이 ms
alter table public.scores add column if not exists highlight_expires_at timestamptz;  -- TTL 설계용 (cron 후순위)
alter table public.scores add column if not exists highlight_deleted_at timestamptz; -- 신고/삭제 설계용

-- public 버킷: 공유 링크에서 누구나 영상 재생 (Supabase CDN). 업로드는 서명 URL 로만.
insert into storage.buckets (id, name, public)
values ('highlights', 'highlights', true)
on conflict (id) do nothing;
