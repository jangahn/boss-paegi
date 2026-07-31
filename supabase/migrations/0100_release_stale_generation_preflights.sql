-- 0100: 버려진 생성 예약의 owner-scoped 즉시 정리 (2026-08-01 제품 결정)
--
-- claim(크레딧 선차감) 후 분석~제출 요청이 끊기면 예약이 '미확정'인 채
-- 남는데, 기존 정리는 expires_at(2h15m) 기반 cron뿐이라 그동안 사용자에겐
-- "크레딧 증발"로 보였다. 이 RPC는 폴링 허브가 요청 사용자 범위로 호출해
-- **재진입 순간** 명백히 버려진 예약(생성 10분 경과 + 분석 lease 5분 이상
-- 만료)을 기존 prune과 동일한 잠금 순서·환불 경로로 즉시 종결한다.
-- 활성 처리는 2분 lease를 계속 갱신하므로 오탐 여지가 없다.

create or replace function public.release_stale_generation_preflights(
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_candidate record;
  v_reservation public.generation_preflight_reservations%rowtype;
  v_terminal jsonb;
  v_released integer := 0;
begin
  if p_owner_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'owner_required');
  end if;

  for v_candidate in
    select r.id
      from public.generation_preflight_reservations r
     where r.owner_id = p_owner_id
       and r.state in ('claimed', 'accepted')
       and r.created_at <= v_now - interval '10 minutes'
       and coalesce(r.analysis_leased_until, r.created_at)
             <= v_now - interval '5 minutes'
     order by r.created_at, r.id
     limit 5
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'generation-preflight:' || v_candidate.id::text,
        0
      )
    );
    select *
      into v_reservation
      from public.generation_preflight_reservations r
     where r.id = v_candidate.id;
    if not found
       or v_reservation.state not in ('claimed', 'accepted')
       or v_reservation.generation_id is null
       or v_reservation.created_at > v_now - interval '10 minutes'
       or coalesce(v_reservation.analysis_leased_until, v_reservation.created_at)
            > v_now - interval '5 minutes' then
      continue;
    end if;
    perform public.bp_mutation_object_lock(
      'generation', v_reservation.generation_id::text
    );
    perform public.bp_user_mutation_lock(v_reservation.owner_id);
    select *
      into v_reservation
      from public.generation_preflight_reservations r
     where r.id = v_candidate.id
       for update;
    if not found
       or v_reservation.state not in ('claimed', 'accepted')
       or v_reservation.created_at > v_now - interval '10 minutes'
       or coalesce(v_reservation.analysis_leased_until, v_reservation.created_at)
            > v_now - interval '5 minutes' then
      continue;
    end if;
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_claim_expired',
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = 'expired',
           terminal_reason = 'claim_expired',
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = v_reservation.id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
    v_released := v_released + 1;
  end loop;

  return pg_catalog.jsonb_build_object('ok', true, 'released', v_released);
end;
$$;

revoke all on function public.release_stale_generation_preflights(uuid)
  from public, anon, authenticated;
grant execute on function public.release_stale_generation_preflights(uuid)
  to service_role;
