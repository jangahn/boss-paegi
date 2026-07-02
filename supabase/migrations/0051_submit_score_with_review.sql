-- 0051: submit_score_with_review — 점수 저장 + 판정결과(review_status) + score_flags 원자 처리
--
-- 적용: management API query 엔드포인트.
--
-- 배경(fail-closed): 기존 /api/score 는 score insert 후 stats/뱃지를 best-effort 로 처리했고,
-- review_status·score_flags 가 쪼개져 실패하면 조작 점수가 registered 로 남을 수 있다.
-- 이 RPC 는 scores insert + (flagged 시) score_flags insert 를 **한 트랜잭션**으로 묶어,
-- integrity 기록 실패 시 score 도 롤백되게 한다(조작 점수가 visible 로 새지 않음).
--
-- 판정(signals/evidence/abuse_score/review_status)은 서버 route(lib/anti-abuse-rules)가 계산해
-- 인자로 넘긴다. 클라는 이 값을 보낼 수 없다(RPC 는 service_role 전용).

create or replace function public.submit_score_with_review(
  p_owner_id uuid,
  p_doll_id uuid,
  p_score int,
  p_weapon text,
  p_duration_ms int,
  p_max_combo int,
  p_end_reason text,
  p_telemetry_session_id uuid,
  p_review_status text,
  p_signals jsonb,
  p_evidence jsonb,
  p_abuse_score int,
  p_rules_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_existing_id uuid;
  v_existing_owner uuid;
  v_flagged boolean := p_review_status in ('pending','voided');
begin
  -- 방어: review_status allowlist + flags 정합(pending/voided 는 signals 필수).
  if p_review_status not in ('registered','pending','voided') then
    raise exception 'invalid_review_status';
  end if;
  if v_flagged and (p_signals is null or jsonb_array_length(p_signals) = 0) then
    raise exception 'flags_required';
  end if;

  begin
    insert into public.scores (
      owner_id, doll_id, score, weapon, duration_ms, max_combo, end_reason,
      telemetry_session_id, review_status
    ) values (
      p_owner_id, p_doll_id, p_score, p_weapon, p_duration_ms, greatest(coalesce(p_max_combo,0),0),
      case when p_end_reason in ('time_limit','score_limit') then p_end_reason else 'normal' end,
      p_telemetry_session_id, p_review_status
    )
    returning id into v_id;
  exception when unique_violation then
    -- telemetry_session_id 부분 unique 충돌(중복 제출) — 본인 것이면 graceful, 타인이면 거부.
    select id, owner_id into v_existing_id, v_existing_owner
      from public.scores where telemetry_session_id = p_telemetry_session_id;
    if v_existing_owner = p_owner_id then
      return jsonb_build_object(
        'scoreId', v_existing_id,
        'reviewStatus', (select review_status from public.scores where id = v_existing_id),
        'duplicate', true
      );
    end if;
    raise exception 'telemetry_session_conflict';
  end;

  -- flagged 면 리뷰 큐 기록. (같은 트랜잭션 — 실패 시 score 롤백=fail-closed)
  -- 제출시점 auto-flag 는 score_flags 자체가 기록이므로 별도 ledger 미기재(ledger 는 admin/cron 조치용).
  if v_flagged then
    insert into public.score_flags (score_id, signals, evidence, abuse_score, rules_version, status)
    values (v_id, coalesce(p_signals,'[]'::jsonb), coalesce(p_evidence,'{}'::jsonb),
            coalesce(p_abuse_score,0), coalesce(p_rules_version,'v1'), p_review_status);
  end if;

  return jsonb_build_object('scoreId', v_id, 'reviewStatus', p_review_status, 'duplicate', false);
end;
$$;

revoke all on function public.submit_score_with_review(uuid, uuid, int, text, int, int, text, uuid, text, jsonb, jsonb, int, text) from public, anon, authenticated;
grant execute on function public.submit_score_with_review(uuid, uuid, int, text, int, int, text, uuid, text, jsonb, jsonb, int, text) to service_role;
