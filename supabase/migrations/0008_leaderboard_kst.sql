-- 0008: 랭킹 윈도우를 KST 자정 기준으로 + 기본 10명
--
-- 적용: management API query 엔드포인트로 직접 실행.
-- 기존(0002)은 now()-interval '1 day'/'7 days' 롤링 윈도우였음 → KST 자정 고정 경계로 변경.
--   - 일간: 오늘 KST 00:00 부터 (매일 0시 초기화)
--   - 주간: 이번 주 월요일 KST 00:00 부터 (월요일 0시 초기화)
-- date_trunc(... , now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' = 해당 KST 경계의 UTC 시각.

create or replace function public.get_leaderboard(period text default 'daily', max_limit int default 10)
returns table (
  id uuid,
  owner_id uuid,
  score int,
  weapon text,
  duration_ms int,
  created_at timestamptz,
  display_name text,
  doll_image_url text
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
    d.image_url as doll_image_url
  from best b
  left join public.profiles p on p.id = b.owner_id
  left join public.dolls d on d.id = b.doll_id
  order by b.score desc, b.created_at desc
  limit max_limit;
$$;

grant execute on function public.get_leaderboard(text, int) to anon, authenticated;
