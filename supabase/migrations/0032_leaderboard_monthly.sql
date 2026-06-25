-- 0032: get_leaderboard 에 monthly(이번 달) 기간 추가. 0013 정의에 KST 월초 분기 한 줄만 추가.
--
-- 적용: management API. 반환 shape/시그니처 동일((text,int)) → create or replace 로 grant 보존되나
-- 안전하게 grant 재명시. security invoker·stable·search_path 등 0013 속성 그대로.

create or replace function public.get_leaderboard(period text default 'daily', max_limit int default 10)
returns table (
  id uuid,
  owner_id uuid,
  score int,
  weapon text,
  duration_ms int,
  created_at timestamptz,
  display_name text,
  avatar_url text
)
language sql
stable
security invoker
set search_path = public
as $$
  with windowed as (
    select s.*
    from public.scores s
    where s.created_at >= case
      when period = 'weekly'
        then (date_trunc('week', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
      when period = 'monthly'
        then (date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
      else (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
    end
  ),
  best as (
    -- 사용자별 최고점 1개만
    select distinct on (owner_id) *
    from windowed
    order by owner_id, score desc, created_at desc
  )
  select
    b.id,
    b.owner_id,
    b.score,
    b.weapon,
    b.duration_ms,
    b.created_at,
    p.display_name,
    p.avatar_url
  from best b
  left join public.profiles p on p.id = b.owner_id
  order by b.score desc, b.created_at desc
  limit max_limit;
$$;
grant execute on function public.get_leaderboard(text, int) to anon, authenticated;
