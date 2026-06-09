-- 0002: 사용자별 best score 만 랭킹 노출 + 기존 데이터 truncate
--
-- 적용: Supabase SQL Editor 에 통째로 paste 후 RUN.
-- 운영: 이후 scores 테이블에 중복 INSERT 가 그대로 쌓여도, leaderboard 는 RPC 로
-- 사용자별 최고점만 집계.

-- 1) 기존 점수 모두 삭제 (사용자 요청)
truncate table public.scores restart identity;

-- 2) 랭킹 RPC — period: 'daily' | 'weekly'
create or replace function public.get_leaderboard(period text default 'daily', max_limit int default 50)
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
      when period = 'weekly' then now() - interval '7 days'
      else now() - interval '1 day'
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

-- RPC 권한: 누구나 (RLS 우회 아님 — 함수 내 쿼리는 public 데이터만 읽음)
grant execute on function public.get_leaderboard(text, int) to anon, authenticated;
