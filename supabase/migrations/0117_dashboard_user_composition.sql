-- 0117: 운영 대시보드 '유저 퍼널·구성' — 방문일 기록(user_visit_days) + 처음 방문 코호트(first_visit)
--       + 전체·다시·회원 raw 윈도우 RPC(admin_user_composition_window).
--
-- 설계(v1.17, 2026-09-03 사용자 확정 — GA식·일 단위 처음/다시, 로또젠 v6 '유저 구성'과 같은 프레임):
--  · 방문 = 상호작용·봇 게이트를 통과한 /api/track 방문 적재 시 서버가 세션 uid 로 남긴 (uid, KST 일자) 1행/일.
--    익명 계정은 페이지 로드만으로 생기므로(JS 렌더링 크롤러 포함) 계정 생성 수(anon_users)는 방문이 아니다 —
--    구 스텝은 롤업 이력용으로만 유지하고 화면에서 내린다.
--  · 유저 단위 = auth uid(비회원=브라우저 익명 계정, 회원=계정). 익명→회원 이관 원장(anon_data_reassignments
--    source→target, 0074/0093)으로 익명 시절 방문을 회원에 접는다(점수·텔레메트리는 0093 이 이미 owner 를 옮긴다).
--  · 첫 관측일 = least(계정 생성일, 첫 방문일)(대표 계정 그룹 최소) — 도입 전 계정도 첫날부터 '다시'가 잡힌다.
--  · 처음 방문(first_visit) = 그날 방문했고 첫 관측일이 그날인 유저 → 일 가산이라 admin_funnel_rows_for_day 에
--    추가(cron·라이브 단일 소스 승계, 0112 규약). 전체·다시·회원 = 기간 내 distinct → raw RPC
--    admin_user_composition_window(p_days) (v1.06 규약의 예외 부류 — 재방문·로또젠 유저 구성과 동일).
--  · 무 FK: 계정 삭제 뒤에도 방문일 행이 남아 과거 집계가 흔들리지 않는다(일별 동결과 같은 취지). PII 없음(uid·일자).

-- ── 1) 방문일 기록(1행/유저/일) ────────────────────────────────────────────
create table if not exists public.user_visit_days (
  user_id uuid not null,
  day_kst date not null default ((now() at time zone 'Asia/Seoul')::date),
  primary key (user_id, day_kst)
);
create index if not exists user_visit_days_day_kst_idx on public.user_visit_days (day_kst);
alter table public.user_visit_days enable row level security;
revoke all on public.user_visit_days from anon, authenticated;
grant all on public.user_visit_days to service_role;

-- ── 2) 대표 계정 접기 + 첫 관측일(방문 기록이 있는 유저만) ───────────────────
create or replace function public.admin_user_visits()
returns table(user_id uuid, day_kst date)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(r.target_user_id, v.user_id), v.day_kst
  from public.user_visit_days v
  left join public.anon_data_reassignments r on r.source_user_id = v.user_id
$$;

revoke all on function public.admin_user_visits() from public, anon, authenticated;
grant execute on function public.admin_user_visits() to service_role;

create or replace function public.admin_user_first_seen()
returns table(user_id uuid, first_day date)
language sql
stable
security definer
set search_path = public
as $$
  with created as (
    select coalesce(r.target_user_id, u.id) as user_id,
           min((u.created_at at time zone 'Asia/Seoul')::date) as created_day
    from auth.users u
    left join public.anon_data_reassignments r on r.source_user_id = u.id
    group by 1
  )
  select v.user_id, least(min(v.day_kst), min(c.created_day))
  from public.admin_user_visits() v
  left join created c on c.user_id = v.user_id
  group by v.user_id
$$;

revoke all on function public.admin_user_first_seen() from public, anon, authenticated;
grant execute on function public.admin_user_first_seen() to service_role;

-- ── 3) 롤업 스텝 허용목록에 first_visit 추가(함수·CHECK 는 항상 짝) ───────────
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.admin_funnel_rollups'::regclass
    and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%step%';
  if v_name is not null then
    execute format('alter table public.admin_funnel_rollups drop constraint %I', v_name);
  end if;
  alter table public.admin_funnel_rollups
    add constraint admin_funnel_rollups_step_check
    check (step in ('anon_users', 'players', 'members', 'first_gen', 'first_purchase', 'first_visit'));
end;
$$;

-- ── 4) 하루치 코호트 단일 소스 — 0112 본문 그대로 + first_visit 한 가지(항상 6행/일) ──
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
  -- 현행 get_admin_funnel 과 동일: 테스트 주문 제외(not is_test).
  select 'first_purchase'::text, count(*)::bigint
  from (
    select o.user_id, min(o.paid_at) as first_at
    from public.orders o
    where o.status = 'paid' and not o.is_test and o.paid_at is not null
    group by o.user_id
  ) t
  where t.first_at >= v_lo and t.first_at < v_hi
  union all
  -- v1.17 처음 방문: 그날 방문(상호작용·봇 게이트 통과)했고 첫 관측일이 그날인 유저(대표 계정 기준, 0117).
  select 'first_visit'::text, count(distinct v.user_id)::bigint
  from public.admin_user_visits() v
  join public.admin_user_first_seen() f on f.user_id = v.user_id
  where v.day_kst = p_day and f.first_day = p_day;
end;
$$;

-- ── 5) 전체·다시·회원 윈도우(기간 내 distinct — raw 직조회 예외, p_days null=전체) ──
-- 가입 단계는 롤업의 members 가 전체=처음이라 여기 없다(탈퇴로 줄어드는 raw 와 동결값을 섞지 않는다).
create or replace function public.admin_user_composition_window(p_days int default null)
returns table(stage text, total bigint, again bigint, members bigint)
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  c_max_days constant int := 366;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_from date;
begin
  if p_days is not null and p_days not between 1 and c_max_days then
    raise exception 'admin_user_composition_window_invalid_days'
      using errcode = '22023';
  end if;
  v_from := case when p_days is null then null else v_today - (p_days - 1) end;

  return query
  with visits as (
    select v.user_id, v.day_kst from public.admin_user_visits() v
  ),
  first_seen as (
    select f.user_id, f.first_day from public.admin_user_first_seen() f
  ),
  plays as (
    select s.owner_id as user_id, (s.created_at at time zone 'Asia/Seoul')::date as day_kst
    from public.scores s
    where s.owner_id is not null
  ),
  play_first as (
    select p.user_id, min(p.day_kst) as first_day from plays p group by p.user_id
  ),
  gens as (
    select d.owner_id as user_id, (d.created_at at time zone 'Asia/Seoul')::date as day_kst
    from public.dolls d
    where d.owner_id is not null
  ),
  gen_first as (
    select g.user_id, min(g.day_kst) as first_day from gens g group by g.user_id
  ),
  pays as (
    select o.user_id, (o.paid_at at time zone 'Asia/Seoul')::date as day_kst
    from public.orders o
    where o.status = 'paid' and not o.is_test and o.paid_at is not null
  ),
  pay_first as (
    select p.user_id, min(p.day_kst) as first_day from pays p group by p.user_id
  )
  select 'visit'::text,
    (select count(distinct v.user_id) from visits v
      where v_from is null or v.day_kst >= v_from),
    (select count(distinct v.user_id) from visits v
      join first_seen f on f.user_id = v.user_id
      where (v_from is null or v.day_kst >= v_from) and v.day_kst > f.first_day),
    (select count(distinct v.user_id) from visits v
      where (v_from is null or v.day_kst >= v_from)
        and exists (select 1 from public.member_accounts m where m.user_id = v.user_id))
  union all
  select 'play'::text,
    (select count(distinct p.user_id) from plays p
      where v_from is null or p.day_kst >= v_from),
    (select count(distinct p.user_id) from plays p
      join play_first f on f.user_id = p.user_id
      where (v_from is null or p.day_kst >= v_from) and p.day_kst > f.first_day),
    (select count(distinct p.user_id) from plays p
      where (v_from is null or p.day_kst >= v_from)
        and exists (select 1 from public.member_accounts m where m.user_id = p.user_id))
  union all
  select 'generation'::text,
    (select count(distinct g.user_id) from gens g
      where v_from is null or g.day_kst >= v_from),
    (select count(distinct g.user_id) from gens g
      join gen_first f on f.user_id = g.user_id
      where (v_from is null or g.day_kst >= v_from) and g.day_kst > f.first_day),
    (select count(distinct g.user_id) from gens g
      where v_from is null or g.day_kst >= v_from)
  union all
  select 'purchase'::text,
    (select count(distinct p.user_id) from pays p
      where v_from is null or p.day_kst >= v_from),
    (select count(distinct p.user_id) from pays p
      join pay_first f on f.user_id = p.user_id
      where (v_from is null or p.day_kst >= v_from) and p.day_kst > f.first_day),
    (select count(distinct p.user_id) from pays p
      where v_from is null or p.day_kst >= v_from);
end;
$function$;

revoke all on function public.admin_user_composition_window(int) from public, anon, authenticated;
grant execute on function public.admin_user_composition_window(int) to service_role;
