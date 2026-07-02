-- 0053: integrity_scan_recent — cron 백스톱(제출 후 확정된 텔레메트리로 정합 재검사)
--
-- 적용: management API query 엔드포인트.
--
-- 텔레메트리는 delta 스트리밍이라 /api/score 제출 시점엔 미확정일 수 있다. 이 스캔은 최근
-- registered 점수를 확정 텔레메트리와 대조해 어뷰징을 사후 flag 한다(제출시점 payload 신호가
-- 못 잡은 것 백스톱). registered → pending 만; cleared/voided 는 건드리지 않는다(admin 결정 보존).
-- idempotent: score_flags PK(score_id) on conflict do nothing(이미 flagged 면 재flag 안 함).
--
-- 신호: C1(score 20%+ 불일치)·C1B(duration 20%+ 불일치)·C2(세션 apm>1200 & ≥60s)·
--       C8(연결 텔레 suspicious — 제출 후 단조로 켜진 것).

create or replace function public.integrity_scan_recent(p_hours int default 6, p_rules text default 'v1')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_scanned int; v_flagged int;
begin
  create temp table _iscan on commit drop as
  with cand as (
    select s.id, s.score, s.duration_ms,
           ts.score as tscore, ts.duration_ms as tdur, ts.suspicious, ts.apm
    from public.scores s
    join public.telemetry_sessions ts on ts.id = s.telemetry_session_id
    where s.review_status = 'registered'
      and s.created_at > now() - make_interval(hours => p_hours)
  ),
  scored as (
    -- 정합 검사(C1/C1b)는 텔레메트리가 **실제 플레이를 기록한 경우만**(tscore>0). tscore=0/null 은
    -- 세션이 비었거나(abandoned·hidden_timeout·budget degrade) 텔레 미기록 → 조작 아님(오탐 방지).
    -- 실측: 정상 유저 111K 점수가 tscore=0 세션에 붙어 100% "불일치"로 뜨던 FP 케이스.
    select id,
      (coalesce(tscore,0) > 0 and score > 0 and abs(score - tscore)::numeric / greatest(abs(score),1) > 0.2) as c1,
      (coalesce(tscore,0) > 0 and coalesce(tdur,0) > 0 and abs(duration_ms - tdur)::numeric / greatest(tdur,1) > 0.2) as c1b,
      (coalesce(apm,0) > 1200 and duration_ms >= 60000) as c2,
      coalesce(suspicious,false) as c8,
      tscore, tdur, apm, suspicious
    from cand
  )
  select id,
    (case when c1 then jsonb_build_array(jsonb_build_object('id','C1_SCORE_MISMATCH','value',tscore,'source','cron')) else '[]'::jsonb end
     || case when c1b then jsonb_build_array(jsonb_build_object('id','C1B_DURATION_MISMATCH','value',tdur,'source','cron')) else '[]'::jsonb end
     || case when c2 then jsonb_build_array(jsonb_build_object('id','C2_SESSION_APM','value',apm,'threshold',1200,'source','cron')) else '[]'::jsonb end
     || case when c8 then jsonb_build_array(jsonb_build_object('id','C8_TELEMETRY_SUSPICIOUS','value',1,'source','cron')) else '[]'::jsonb end
    ) as signals,
    ((c1::int)*3 + (c1b::int)*3 + (c2::int) + (c8::int)*3) as abuse_score
  from scored
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
