-- 0044: 배너 구좌를 지면별(홈·갤러리·랭킹) 독립 제어로 분리.
--
-- 변경: 단일 banner_active(3지면 일괄) → banner_home_active/banner_gallery_active/banner_leaderboard_active
--   3개 독립 플래그. 한 이벤트가 임의 조합으로 지면 선택. 문구(summary)·우선순위(priority)는 공용.
--  · banner_active 컬럼은 **유지**(롤아웃 중 구코드 read 호환). 신 RPC가 banner_active = (3지면 OR)로 동기화.
--    신 코드는 3개 컬럼만 사용. banner_active 제거는 후속 정리 마이그(코드 배포 완료 후).
-- additive·무중단(컬럼 추가 + 인덱스 + RPC 시그니처 교체; 페이지 read 는 구컬럼 유지로 윈도우 무영향).

alter table public.events
  add column if not exists banner_home_active        boolean not null default false,
  add column if not exists banner_gallery_active     boolean not null default false,
  add column if not exists banner_leaderboard_active boolean not null default false;

-- 기존 공용 배너 보존(banner_active=true 였으면 3지면 모두 켬)
update public.events set
  banner_home_active = true, banner_gallery_active = true, banner_leaderboard_active = true
where banner_active = true;

-- 지면별 1건 픽용 부분 인덱스
create index if not exists idx_events_banner_home on public.events (priority desc, published_at desc)
  where status = 'published' and deleted_at is null and banner_home_active;
create index if not exists idx_events_banner_gallery on public.events (priority desc, published_at desc)
  where status = 'published' and deleted_at is null and banner_gallery_active;
create index if not exists idx_events_banner_leaderboard on public.events (priority desc, published_at desc)
  where status = 'published' and deleted_at is null and banner_leaderboard_active;

-- admin_save_event: 단일 p_banner_active → 3 지면 파라미터로 교체.
-- **구 15-arg 시그니처는 유지**(오버로드 공존) — 롤아웃 윈도우 중 prod 구코드의 호출 호환.
--   신 코드는 17-arg(3 배너 파라미터)만 호출. 구 15-arg 제거는 후속 정리 마이그(코드 배포 완료 후).
create or replace function public.admin_save_event(
  p_id uuid, p_type text, p_title text, p_summary text, p_body text, p_cover_image_path text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_popup_active boolean,
  p_banner_home_active boolean, p_banner_gallery_active boolean, p_banner_leaderboard_active boolean,
  p_priority int, p_pinned boolean, p_noindex boolean, p_popup_dismiss_days int, p_admin_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_cover text := nullif(btrim(coalesce(p_cover_image_path, '')), '');
  v_home boolean := coalesce(p_banner_home_active, false);
  v_gal  boolean := coalesce(p_banner_gallery_active, false);
  v_lead boolean := coalesce(p_banner_leaderboard_active, false);
  v_any_banner boolean := v_home or v_gal or v_lead;  -- banner_active back-compat
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  if p_type not in ('notice','event') then raise exception 'invalid_type'; end if;
  if char_length(btrim(coalesce(p_title,'')))   not between 1 and 200   then raise exception 'invalid_title'; end if;
  if char_length(btrim(coalesce(p_summary,''))) not between 1 and 200   then raise exception 'invalid_summary'; end if;
  if char_length(btrim(coalesce(p_body,'')))    not between 1 and 50000 then raise exception 'invalid_body'; end if;
  if p_popup_dismiss_days is null or p_popup_dismiss_days not between 1 and 365 then raise exception 'invalid_dismiss_days'; end if;
  if p_starts_at is not null and p_ends_at is not null and p_starts_at >= p_ends_at then raise exception 'invalid_window'; end if;
  if v_cover is not null and not (
       char_length(v_cover) <= 300
       and position('://' in v_cover) = 0
       and left(v_cover, 1) <> '/'
       and position('..' in v_cover) = 0
       and v_cover !~* '\.svg$'
     ) then
    raise exception 'invalid_cover';
  end if;

  if p_id is null then
    perform pg_advisory_xact_lock(hashtext('event:new:' || p_admin_id::text));
    insert into public.events
      (type, status, title, summary, body, cover_image_path, starts_at, ends_at,
       popup_active, banner_active, banner_home_active, banner_gallery_active, banner_leaderboard_active,
       priority, pinned, noindex, popup_dismiss_days, created_by, updated_at)
    values
      (p_type, 'draft', btrim(p_title), btrim(p_summary), p_body, v_cover, p_starts_at, p_ends_at,
       coalesce(p_popup_active,false), v_any_banner, v_home, v_gal, v_lead,
       coalesce(p_priority,0), coalesce(p_pinned,false), coalesce(p_noindex,false), p_popup_dismiss_days, p_admin_id, now())
    returning id into v_id;
  else
    perform pg_advisory_xact_lock(hashtext('event:' || p_id::text));
    update public.events set
      type = p_type, title = btrim(p_title), summary = btrim(p_summary), body = p_body,
      cover_image_path = v_cover, starts_at = p_starts_at, ends_at = p_ends_at,
      popup_active = coalesce(p_popup_active,false), banner_active = v_any_banner,
      banner_home_active = v_home, banner_gallery_active = v_gal, banner_leaderboard_active = v_lead,
      priority = coalesce(p_priority,0), pinned = coalesce(p_pinned,false), noindex = coalesce(p_noindex,false),
      popup_dismiss_days = p_popup_dismiss_days, updated_at = now()
    where id = p_id and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;

  insert into public.events_audit (event_id, action, details, admin_user_id)
    values (v_id, 'event_saved',
      jsonb_build_object('type', p_type, 'title', btrim(p_title),
        'popup_active', coalesce(p_popup_active,false),
        'banner_home', v_home, 'banner_gallery', v_gal, 'banner_leaderboard', v_lead,
        'is_new', (p_id is null)),
      p_admin_id);

  return v_id;
end; $$;
revoke all on function public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,boolean,boolean,int,boolean,boolean,int,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,boolean,boolean,int,boolean,boolean,int,uuid) to service_role;

notify pgrst, 'reload schema';
