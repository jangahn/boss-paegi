-- 0026: scores.end_reason — 강제 종료 사유(분석용). additive·무중단.
-- normal | time_limit | score_limit. /api/score 가 기록(컬럼 없으면 fallback insert 로 무시).
alter table public.scores add column if not exists end_reason text;
