-- 0112: 운영 대시보드 기간 윈도우 — 가입·구매 퍼널 하이브리드(일별 코호트 롤업) + 매출·주문 윈도우드 직조회.
--
-- 설계(v1.06, 0110/0111 과 동일 하이브리드 규약):
--  · 퍼널 = "역사적 사실" 지표(그날 처음 달성한 유저 수) → 일별 코호트 롤업으로 동결.
--    탈퇴·익명 계정 정리로 원천 직조회는 과거 수치가 시간이 갈수록 줄어드는 문제가 있었다 — 동결이 교정.
--    단일 소스 `admin_funnel_rows_for_day(p_day)` 를 cron(`admin_funnel_rollup_days`, ops route
--    funnel-maintain)과 어드민 라이브 조회(p_day=오늘)가 공유한다. 어드민은 롤업을 day_kst<오늘만 읽는다.
--  · 매출·주문 = "현재 진실" 지표(환불·대사가 과거를 소급 교정) → 롤업 없이 orders 직조회 유지.
--    `get_admin_order_summary_window(p_days|null)` 로 KST 달력일 윈도우(오늘/7/30/전체)만 추가.
--    기존 `get_admin_order_summary()` 는 배포 전환 기간 호환을 위해 존치(대시보드는 windowed 만 사용).
--  · 코호트 정의: 방문=그날 생성된 익명 auth 계정 수 / 플레이=첫 점수 제출일 / 가입=member_accounts 생성일
--    / 첫 생성=첫 doll 생성일 / 첫 구매=첫 paid 주문일(paid_at). 재가입은 신규 코호트로 집계(동의 모델과 정합).
--
-- ⚠ 백필 한계(어드민 화면 각주로 고지): 롤업 도입 전 과거는 "현재 잔존 행" 기준 근사다 —
--   정리된 익명 계정·탈퇴 회원·삭제된 doll 은 소급 불가. 도입 이후부터는 일별 동결로 정확.

-- ── 1) 일별 코호트 롤업 저장소 ─────────────────────────────────────────────
create table if not exists public.admin_funnel_rollups (
  day_kst date not null,
  step text not null check (step in ('anon_users', 'players', 'members', 'first_gen', 'first_purchase')),
  value bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day_kst, step)
);
alter table public.admin_funnel_rollups enable row level security;
revoke all on public.admin_funnel_rollups from anon, authenticated;
grant all on public.admin_funnel_rollups to service_role;

-- ── 2) 하루치 코호트 단일 소스(항상 5행/일) ─────────────────────────────────
create or replace function public.admin_funnel_rows_for_day(p_day date)
returns table(step text, value bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if p_day is null then
    raise exception 'admin_funnel_rows_for_day_invalid_day' using errcode = '22023';
  end if;
  v_lo := (p_day::timestamp at time zone 'Asia/Seoul');
  v_hi := ((p_day + 1)::timestamp at time zone 'Asia/Seoul');

  return query
  select 'anon_users'::text, count(*)::bigint
  from auth.users u
  where u.is_anonymous and u.created_at >= v_lo and u.created_at < v_hi
  union all
  select 'players'::text, count(*)::bigint
  from (
    select s.owner_id, min(s.created_at) as first_at
    from public.scores s
    where s.owner_id is not null
    group by s.owner_id
  ) t
  where t.first_at >= v_lo and t.first_at < v_hi
  union all
  select 'members'::text, count(*)::bigint
  from public.member_accounts m
  where m.created_at >= v_lo and m.created_at < v_hi
  union all
  select 'first_gen'::text, count(*)::bigint
  from (
    select d.owner_id, min(d.created_at) as first_at
    from public.dolls d
    where d.owner_id is not null
    group by d.owner_id
  ) t
  where t.first_at >= v_lo and t.first_at < v_hi
  union all
  select 'first_purchase'::text, count(*)::bigint
  from (
    select o.user_id, min(o.paid_at) as first_at
    from public.orders o
    where o.status = 'paid' and o.paid_at is not null
    group by o.user_id
  ) t
  where t.first_at >= v_lo and t.first_at < v_hi;
end;
$$;

revoke all on function public.admin_funnel_rows_for_day(date) from public, anon, authenticated;
grant execute on function public.admin_funnel_rows_for_day(date) to service_role;

-- ── 3) cron 롤업(0095 유지보수 계열과 동일 규약: 검증 → advisory lock → 일별 delete-재계산) ──
create or replace function public.admin_funnel_rollup_days(p_days int default 3)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_min_days constant int := 1;
  -- 원천(계정·주문)이 영구 보존이라 복구 지평을 1년까지 허용(telemetry 31·analytics 91 과 달리 raw 소실 없음).
  c_max_days constant int := 366;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date;
  i int;
begin
  if p_days is null or p_days not between c_min_days and c_max_days then
    raise exception 'admin_funnel_rollup_days_invalid_days'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('admin_funnel_rollups')
  );

  for i in 0 .. p_days - 1 loop
    v_d := v_today - i;

    delete from public.admin_funnel_rollups where day_kst = v_d;

    insert into public.admin_funnel_rollups(day_kst, step, value, updated_at)
    select v_d, r.step, r.value, now()
    from public.admin_funnel_rows_for_day(v_d) r;
  end loop;

  return jsonb_build_object('ok', true, 'days', p_days);
end;
$function$;

revoke all on function public.admin_funnel_rollup_days(int) from public, anon, authenticated;
grant execute on function public.admin_funnel_rollup_days(int) to service_role;

-- ── 4) 매출·주문 윈도우드 직조회(KST 달력일 · p_days null=전체) ─────────────
-- 기존 get_admin_order_summary() 와 동일한 이중 기준 유지: 매출=paid_at, 주문 건수·상태칩=created_at.
create or replace function public.get_admin_order_summary_window(p_days int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c_min_days constant int := 1;
  c_max_days constant int := 3660;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_start timestamptz;
begin
  if p_days is not null and p_days not between c_min_days and c_max_days then
    raise exception 'get_admin_order_summary_window_invalid_days'
      using errcode = '22023';
  end if;
  v_start := case
    when p_days is null then null
    else ((v_today - (p_days - 1))::timestamp at time zone 'Asia/Seoul')
  end;

  return jsonb_build_object(
    'revenue', coalesce((
      select sum(o.amount) from public.orders o
      where o.status = 'paid' and (v_start is null or o.paid_at >= v_start)
    ), 0),
    'orders', coalesce((
      select count(*) from public.orders o
      where v_start is null or o.created_at >= v_start
    ), 0),
    'by_status', coalesce((
      select jsonb_object_agg(t.status, t.c)
      from (
        select o.status, count(*) as c from public.orders o
        where v_start is null or o.created_at >= v_start
        group by o.status
      ) t
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.get_admin_order_summary_window(int) from public, anon, authenticated;
grant execute on function public.get_admin_order_summary_window(int) to service_role;

-- ── 5) 백필: 원천 최초일 ~ 어제(멱등 재실행 안전) ───────────────────────────
do $backfill$
declare
  v_min date;
  v_yesterday date := (now() at time zone 'Asia/Seoul')::date - 1;
  d date;
begin
  select min(t.first_day) into v_min
  from (
    select min((u.created_at at time zone 'Asia/Seoul'))::date as first_day
      from auth.users u where u.is_anonymous
    union all
    select min((s.created_at at time zone 'Asia/Seoul'))::date
      from public.scores s where s.owner_id is not null
    union all
    select min((m.created_at at time zone 'Asia/Seoul'))::date from public.member_accounts m
    union all
    select min((dl.created_at at time zone 'Asia/Seoul'))::date
      from public.dolls dl where dl.owner_id is not null
    union all
    select min((o.paid_at at time zone 'Asia/Seoul'))::date
      from public.orders o where o.status = 'paid' and o.paid_at is not null
  ) t
  where t.first_day is not null;
  if v_min is null then
    return;
  end if;
  d := v_min;
  while d <= v_yesterday loop
    delete from public.admin_funnel_rollups where day_kst = d;
    insert into public.admin_funnel_rollups(day_kst, step, value, updated_at)
    select d, r.step, r.value, now()
    from public.admin_funnel_rows_for_day(d) r;
    d := d + 1;
  end loop;
end;
$backfill$;

notify pgrst, 'reload schema';
