-- 0132: 누적 뱃지(v1.55) — 내 모든 판 합계(타격 · 궁극기 · 플레이 시간).
--
-- 설계(2026-09-25 사용자 결정 A): 👊 타격 · 💥 궁극기 · ⏱️ 플레이 뱃지를 「한 판」에서 「누적」(내 모든 판 합계)으로
-- 바꾼다. 제한 시간(v1.53, 최대 120초)에서 한 판으로는 닿을 수 없는 tier(타격 2,500+ · 플레이 5분+)가 생겨서다.
--  · 합계 대상 = 본인의 공개 판(review_status registered · cleared) 중 판 통계(score_stats)가 있는 판.
--    판 통계는 공개 판에서만 적재되고(commit_score_report), 검토 대기 · 무효 판은 뺀다.
--  · 플레이 시간 = 판 통계 playMs(v1.53, 첫 타격부터 멈춘 구간 제외). 그 전 판은 기록된 소요 시간(duration_ms).
--  · p_exclude_score = 지금 제출 중인 판(서버 부여 시 「이전 합계」를 구한다 — 재시도로 판 통계가 이미 있어도 이중 합산 없음).
--  · 한 판 기준으로 이미 딴 뱃지는 누적 조건을 자동 충족한다(합계 ≥ 그 판 값) — 누구도 잃지 않는다.
-- 표면: get_play_totals(owner, exclude) = service_role 전용(/api/score), get_my_play_totals() = 로그인(익명 포함) 본인만
-- (인게임 「도전」 진행도). 원시 scores 는 authenticated 가 직접 못 읽는다(0076 계약) — 합계 세 숫자만 내보낸다.

create or replace function public.get_play_totals(
  p_owner uuid,
  p_exclude_score uuid default null
)
returns table(hits bigint, ultimates bigint, play_ms bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum((st.gameplay_stats ->> 'hitCount')::numeric), 0)::bigint,
    coalesce(sum((st.gameplay_stats ->> 'ultimateCount')::numeric), 0)::bigint,
    coalesce(
      sum(coalesce((st.gameplay_stats ->> 'playMs')::numeric, s.duration_ms::numeric)),
      0
    )::bigint
  from public.scores s
  join public.score_stats st on st.score_id = s.id
  where s.owner_id = p_owner
    and s.review_status in ('registered', 'cleared')
    and (p_exclude_score is null or s.id <> p_exclude_score)
$$;

revoke all on function public.get_play_totals(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_play_totals(uuid, uuid) to service_role;

create or replace function public.get_my_play_totals()
returns table(hits bigint, ultimates bigint, play_ms bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select t.hits, t.ultimates, t.play_ms
  from public.get_play_totals((select auth.uid()), null) t
  where (select auth.uid()) is not null
$$;

revoke all on function public.get_my_play_totals() from public, anon, authenticated;
grant execute on function public.get_my_play_totals() to authenticated, service_role;

notify pgrst, 'reload schema';
