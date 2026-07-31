-- 0099: 소식(/news) 노출 수명주기 — 종료 글 영구 잔존 (2026-08-01 제품 결정)
--
-- 확정 명세: 노출종료(ends_at 경과) 글은 팝업·배너 구좌에서만 내려가고,
-- 소식 목록·상세에는 '종료' 딱지를 단 채 영구 잔존한다(공유 링크 보존).
-- 노출전(starts_at 미래)은 공개 표면에서 계속 숨긴다. pinned 는 종료되면
-- 목록 상단 고정이 해제된다 — 이 정렬은 (pinned AND 미종료) 표현식이라
-- PostgREST order 로 표현할 수 없어(정렬 규약: 정렬키=표시키·id tiebreaker·
-- order 없는 limit 금지) RPC 가 페이지네이션과 정렬을 함께 소유한다.

create or replace function public.list_news_events(
  p_type text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with visible as (
    select e.*
      from public.events e
     where e.status = 'published'
       and e.deleted_at is null
       and (e.starts_at is null or e.starts_at <= pg_catalog.now())
       and (p_type is null or e.type = p_type)
  ),
  page as (
    select v.*,
           pg_catalog.row_number() over (
             order by
               (v.pinned
                 and (v.ends_at is null or v.ends_at > pg_catalog.now())
               ) desc,
               v.published_at desc,
               v.id desc
           ) as ord
      from visible v
     order by ord
     limit least(greatest(coalesce(p_limit, 0), 0), 50)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select pg_catalog.jsonb_build_object(
    'total', (select pg_catalog.count(*) from visible),
    'items', coalesce(
      (
        select pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'id', p.id,
                   'type', p.type,
                   'status', p.status,
                   'title', p.title,
                   'summary', p.summary,
                   'body', p.body,
                   'cover_image_path', p.cover_image_path,
                   'starts_at', p.starts_at,
                   'ends_at', p.ends_at,
                   'popup_active', p.popup_active,
                   'banner_home_active', p.banner_home_active,
                   'banner_gallery_active', p.banner_gallery_active,
                   'banner_leaderboard_active', p.banner_leaderboard_active,
                   'priority', p.priority,
                   'pinned', p.pinned,
                   'noindex', p.noindex,
                   'popup_dismiss_days', p.popup_dismiss_days,
                   'published_at', p.published_at,
                   'created_by', p.created_by,
                   'created_at', p.created_at,
                   'updated_at', p.updated_at,
                   'deleted_at', p.deleted_at,
                   'mutation_version', p.mutation_version
                 )
                 order by p.ord
               )
          from page p
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.list_news_events(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_news_events(text, integer, integer)
  to service_role;
