-- 0055: integrity_scan_recent — C1(점수 정합)을 one-sided 로 (클램프 아티팩트 오탐 제거)
--
-- 배경(정합 점검 2026-07-08): C1 은 |score − tscore|/score > 0.2 (대칭)이었다. 그러나 제출 점수는
-- 시간 상한으로 클램프되고(clampForSubmit: min(raw, durationSec×2000)) 텔레메트리는 raw(무클램프)를
-- 저장한다 → 완주 텔레에선 항상 tscore(raw) ≥ score(clamped). 즉 "tscore > 제출"은 **클램프가 작동한
-- 결과일 뿐 위조가 아니다**(예: score 5c5e6435 — 65s raw 171,354 → ceiling 130,132 로 클램프, C1 32%
-- 오탐, admin cleared). 대칭 C1 은 이 정상 방향까지 flag → 오탐 여지.
--
-- 교정: C1 을 one-sided 로 — 제출이 텔레(raw)를 **초과**할 때만(`score − tscore > 0.2×score`). 완주
-- 텔레에서 tscore ≥ 제출이 보장되므로 이 방향은 "게임 원점수보다 높은 점수 제출"=위조뿐이라 무오탐.
-- 34배 위조(REC2 방향, 제출≫텔레)는 계속 잡힌다. 실측: 완주 텔레 '제출>텔레 20%+' 현재 0건(회귀 0).
--
-- ⚠ C1B(duration)는 대칭 유지 — duration 은 클램프가 없어(게임·텔레 둘 다 벽시계 종료시점 기준) 위조가
--   길게/짧게 양방향 가능하므로 대칭이 맞다. 완주 게이트(0054)만 공유하고 방향은 다르다(설계 '결').
-- 그 외(완주 게이트·C1B·C2·C8·flag insert·ledger·idempotent)는 0054 그대로.

create or replace function public.integrity_scan_recent(p_hours int default 6, p_rules text default 'v1')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_scanned int; v_flagged int;
begin
  create temp table _iscan on commit drop as
  with cand as (
    select s.id, s.score, s.duration_ms,
           ts.score as tscore, ts.duration_ms as tdur, ts.suspicious, ts.apm, ts.end_reason as tend_reason
    from public.scores s
    join public.telemetry_sessions ts on ts.id = s.telemetry_session_id
    where s.review_status = 'registered'
      and s.created_at > now() - make_interval(hours => p_hours)
  ),
  scored as (
    -- 정합 검사(C1/C1B)는 텔레가 게임 끝까지 기록한 경우만(tel_complete). abandon/reload/hidden_timeout/
    -- null 은 조기 절단이라 duration·score 가 부분값 → 비교 무의미(0054).
    -- C1 은 one-sided: 제출>텔레(raw) 방향만. 완주 텔레에선 tscore(raw) ≥ score(clamp)이라 반대 방향은
    -- 클램프 아티팩트(위조 아님) → 억제. C1B 는 대칭(duration 은 클램프 없음).
    select id,
      (tend_reason in ('normal','time_limit','score_limit')) as tel_complete,
      (coalesce(tscore,0) > 0 and score > 0 and (score - tscore)::numeric / greatest(score,1) > 0.2) as c1_raw,
      (coalesce(tscore,0) > 0 and coalesce(tdur,0) > 0 and abs(duration_ms - tdur)::numeric / greatest(tdur,1) > 0.2) as c1b_raw,
      (coalesce(apm,0) > 1200 and duration_ms >= 60000) as c2,
      coalesce(suspicious,false) as c8,
      tscore, tdur, apm, suspicious
    from cand
  ),
  gated as (
    select id,
      (tel_complete and c1_raw) as c1,
      (tel_complete and c1b_raw) as c1b,
      c2, c8, tscore, tdur, apm, suspicious
    from scored
  )
  select id,
    (case when c1 then jsonb_build_array(jsonb_build_object('id','C1_SCORE_MISMATCH','value',tscore,'source','cron')) else '[]'::jsonb end
     || case when c1b then jsonb_build_array(jsonb_build_object('id','C1B_DURATION_MISMATCH','value',tdur,'source','cron')) else '[]'::jsonb end
     || case when c2 then jsonb_build_array(jsonb_build_object('id','C2_SESSION_APM','value',apm,'threshold',1200,'source','cron')) else '[]'::jsonb end
     || case when c8 then jsonb_build_array(jsonb_build_object('id','C8_TELEMETRY_SUSPICIOUS','value',1,'source','cron')) else '[]'::jsonb end
    ) as signals,
    ((c1::int)*3 + (c1b::int)*3 + (c2::int) + (c8::int)*3) as abuse_score
  from gated
  where c1 or c1b or c2 or c8;

  select count(*) into v_scanned from public.scores s
    where s.review_status='registered' and s.created_at > now() - make_interval(hours => p_hours)
      and s.telemetry_session_id is not null;
  select count(*) into v_flagged from _iscan;

  update public.scores set review_status = 'pending' where id in (select id from _iscan);

  insert into public.score_flags (score_id, signals, abuse_score, rules_version, status)
  select id, signals, abuse_score, p_rules, 'pending' from _iscan
  on conflict (score_id) do nothing;

  insert into public.integrity_actions_ledger (admin_user_id, action_type, target_type, target_id, reason, meta)
  select null, 'cron_flag', 'score', id, 'cron integrity-scan', jsonb_build_object('next_status','pending','rules_version',p_rules)
  from _iscan;

  return jsonb_build_object('scanned', v_scanned, 'flagged', v_flagged);
end; $$;
revoke all on function public.integrity_scan_recent(int, text) from public, anon, authenticated;
grant execute on function public.integrity_scan_recent(int, text) to service_role;
