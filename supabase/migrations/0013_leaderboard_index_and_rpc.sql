-- 0013: 랭킹 인덱스 보험 + get_leaderboard 의 죽은 dolls 조인 제거
--
-- 적용: management API. 반환 shape 변경(doll_image_url 제거) → drop → create.
-- 구 leaderboard 페이지는 doll_image_url 을 렌더하지 않으므로(avatar_url 렌더) 하위호환.

-- 1) created_at 윈도우 필터 인덱스 (현재 142행엔 무의미하나 점수 누적 대비 보험)
create index if not exists scores_created_at_idx on public.scores (created_at desc);

-- 2) get_leaderboard 재정의 — dolls 조인/doll_image_url 제거 (dolls owner-RLS 라 어차피 NULL = 죽은 조인)
drop function if exists public.get_leaderboard(text, int);
create function public.get_leaderboard(period text default 'daily', max_limit int default 10)
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
