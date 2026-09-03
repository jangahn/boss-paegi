-- 0118: 서버 주도 continuation(v1.20)의 예약 읽기 RPC — generation_preflight_reservations 는
-- 008901 이래 service_role 을 포함한 모든 역할의 직접 접근이 revoke 돼 있고(SECURITY DEFINER RPC 만),
-- v1.20 의 웹훅/스윕이 테이블을 직접 select 해 `permission denied` 로 실패했다(2026-09-03 실측:
-- gen.continuation_reservation_read_fail / gen.continue_sweep_query_fail / gen.sweep_incomplete).
-- 읽기 전용 3종. 쓰기·상태 전이는 종전 RPC(claim/commit/continuation/release)만 한다.

-- 1) 단일 예약의 continuation 입력(소유자·롤·이미지 digest·상태) — 웹훅/스윕 진입점.
create or replace function public.read_generation_preflight_for_continuation(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.generation_preflight_reservations%rowtype;
begin
  if p_request_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'request_id_required');
  end if;
  select *
    into v_row
    from public.generation_preflight_reservations r
   where r.id = p_request_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', true, 'found', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'found', true,
    'id', v_row.id,
    'owner_id', v_row.owner_id,
    'role', v_row.role,
    'image_digest', v_row.image_digest,
    'state', v_row.state,
    'continuation_state', v_row.continuation_state
  );
end;
$$;
revoke all on function public.read_generation_preflight_for_continuation(uuid)
  from public, anon, authenticated;
grant execute on function public.read_generation_preflight_for_continuation(uuid)
  to service_role;

-- 2) 이어갈 후보 목록: accepted/committed 이면서 아직 submitted 가 아닌 예약, 생성 시각 나이 창 안, 오래된 순.
create or replace function public.list_generation_preflight_continuations(
  p_min_age_seconds integer,
  p_max_age_seconds integer,
  p_limit integer
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', r.id,
          'owner_id', r.owner_id,
          'state', r.state,
          'continuation_state', r.continuation_state,
          'continuation_leased_until', r.continuation_leased_until,
          'created_at', r.created_at
        )
        order by r.created_at, r.id
      )
      from (
        select *
          from public.generation_preflight_reservations r
         where r.state in ('accepted', 'committed')
           and r.continuation_state <> 'submitted'
           and r.created_at <= pg_catalog.clock_timestamp()
                 - pg_catalog.make_interval(secs => greatest(coalesce(p_min_age_seconds, 0), 0))
           and r.created_at >= pg_catalog.clock_timestamp()
                 - pg_catalog.make_interval(secs => greatest(coalesce(p_max_age_seconds, 0), 0))
         order by r.created_at, r.id
         limit least(greatest(coalesce(p_limit, 0), 0), 200)
      ) r
    ),
    '[]'::jsonb
  );
$$;
revoke all on function public.list_generation_preflight_continuations(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_generation_preflight_continuations(integer, integer, integer)
  to service_role;

-- 3) 방치 예약의 소유자 목록: claimed/accepted 로 p_min_age_seconds 이상 머문 예약의 distinct owner.
--    소유자 단위 환불·종결은 종전 release_stale_generation_preflights(owner) 가 한다.
create or replace function public.list_stale_generation_preflight_owners(
  p_min_age_seconds integer,
  p_limit integer
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (
      select pg_catalog.jsonb_agg(owner_id order by first_created)
      from (
        select r.owner_id, min(r.created_at) as first_created
          from public.generation_preflight_reservations r
         where r.state in ('claimed', 'accepted')
           and r.created_at <= pg_catalog.clock_timestamp()
                 - pg_catalog.make_interval(secs => greatest(coalesce(p_min_age_seconds, 0), 0))
         group by r.owner_id
         order by first_created
         limit least(greatest(coalesce(p_limit, 0), 0), 100)
      ) o
    ),
    '[]'::jsonb
  );
$$;
revoke all on function public.list_stale_generation_preflight_owners(integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_stale_generation_preflight_owners(integer, integer)
  to service_role;
