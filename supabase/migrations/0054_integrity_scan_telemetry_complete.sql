-- 0054: integrity_scan_recent — 정합 검사(C1/C1B)를 "완주 텔레메트리"로 한정 (오탐 근본해결)
--
-- 배경(전수조사 2026-07-08, FP 사례 score c80b30b6 / owner 5a7d2f1a):
--   scores.duration_ms 는 게임 벽시계(performance.now()-startedAt, 게임오버 시점 — 백그라운드/idle 포함).
--   telemetry_sessions.duration_ms 는 collector end() 에서 **동결**. 탭 30초+ 숨김이면
--   finalize('hidden_timeout')(app/play/useTelemetry.ts) 가 collector 를 파기 → 복귀해도 재개 안 함.
--   → 탭 백그라운드 후 복귀해 정상 종료한 정상 유저 = 텔레 duration 절단(짧음) ≪ 게임 duration.
--   C1B 는 이 둘을 직접 비교해 99% "불일치"로 오탐(사례: 257s vs 129s인데 점수는 10%만 차이=같은 게임).
--
-- 판별자는 duration 이 아니라 텔레 end_reason 이다:
--   endSession(reason) 는 게임오버 사유(normal/time_limit/score_limit)로 텔레를 종료 → 이 값이면
--   텔레가 게임 끝까지 기록됐다는 뜻(완주). abandon/reload/hidden_timeout/null 은 조기 절단이라
--   duration·score 모두 부분값 → 정합 비교 무의미.
--
-- 전수조사 근거: 정상종료 텔레 184건 C1B 발화 0 / hidden_timeout 4건 중 3건 발화 — 3건 전부
--   "제출>텔레"(절단) 방향, 진짜 의심(텔레>제출) 방향은 전체 DB 0건. C1B 발화는 100% 절단 아티팩트.
--   절단 텔레의 실제 어뷰징(score c80b30b6 이웃의 2.18M 위조)은 관리자 CONFIRMED_AUTOCLICKER 가 담당(C1B 아님).
--   → C1/C1B 를 완주 텔레로 한정해도 회귀 0. 위조 봉투의 실질 바인딩은 제출시 S3(1,400/s)로 불변.
--
-- 변경: cand 에 ts.end_reason 추가 + C1/C1B 조건에 tel_complete 게이트. 기존 tscore=0 가드와 동일 철학.
-- 그 외(C2/C8·flag insert·ledger·idempotent on conflict)는 0053 그대로.

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
    -- 정합 검사(C1/C1B)는 텔레메트리가 **게임 끝까지 기록한 경우만**:
    --   (1) tscore>0  — 세션이 비었거나(abandoned·hidden_timeout·budget degrade) 텔레 미기록이면 조작 아님.
    --   (2) tel_complete — 텔레 end_reason 이 게임오버 경로(normal/time_limit/score_limit)여야 완주.
    --       abandon/reload/hidden_timeout/null 은 조기 절단이라 duration·score 가 부분값 → 비교 무의미(오탐).
    select id,
      (tend_reason in ('normal','time_limit','score_limit')) as tel_complete,
      (coalesce(tscore,0) > 0 and score > 0 and abs(score - tscore)::numeric / greatest(abs(score),1) > 0.2) as c1_raw,
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
