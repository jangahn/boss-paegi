-- 0043: 이벤트/공지 운영 — 게시판(b)·홈 진입 팝업(a)·배너 구좌(c)의 단일 소스.
--
-- 설계: legal_documents(0029) 하드닝 패턴 복제 — security definer·set search_path·execute revoke·
--   내부 admin 재검증·advisory lock·전용 audit. **버전 이력은 생략**(이벤트/공지는 과거본 공개 의무 없음)
--   → status(draft/published) + 노출 윈도우(starts_at/ends_at)로 단순화.
--  · server-only: anon/authenticated 전부 revoke, service_role grant. 공개 노출은 서버가 발행본+윈도우+미삭제만 투영.
--  · a/c = 행의 popup_active/banner_active 플래그(우선순위 픽). 클릭 시 b 상세(/news/[id])로 랜딩 — 단일 진실원.
--  · 이미지: 신규 public events 버킷의 **상대경로**만 저장(cover_image_path). public URL 은 서버 getter 가 파생.
--    URL·SVG·경로탈출 금지(테이블 CHECK + RPC 재검증 + 업로드 라우트 = 3중).
-- additive·무중단(신규 테이블, 기존 기능 무영향).

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('notice','event')),
  status text not null check (status in ('draft','published')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  summary text not null check (char_length(btrim(summary)) between 1 and 200),   -- 팝업·배너 짧은 문구
  body text not null check (char_length(btrim(body)) between 1 and 50000),        -- 마크다운
  cover_image_path text check (                                                   -- events 버킷 상대경로(URL 아님)
    cover_image_path is null or (
      char_length(cover_image_path) <= 300
      and position('://' in cover_image_path) = 0     -- URL 금지
      and left(cover_image_path, 1) <> '/'            -- 절대경로 금지
      and position('..' in cover_image_path) = 0      -- 경로탈출 금지
      and cover_image_path !~* '\.svg$'               -- SVG 금지(XSS/추적)
    )
  ),
  starts_at timestamptz,                                                          -- 노출 시작(예약), null=즉시
  ends_at timestamptz,                                                            -- 노출 종료(자동만료), null=무기한
  popup_active boolean not null default false,
  banner_active boolean not null default false,
  priority int not null default 0,                                               -- 동시 active 시 노출 우선순위(desc)
  pinned boolean not null default false,                                         -- 목록 상단 고정
  noindex boolean not null default false,                                        -- 행별 검색 색인 제외(운영성 공지)
  popup_dismiss_days int not null default 7 check (popup_dismiss_days between 1 and 365),  -- 팝업 "○일 안보기"
  published_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,                                                        -- 소프트삭제
  check (starts_at is null or ends_at is null or starts_at < ends_at),
  check (status = 'draft' or published_at is not null)                           -- 발행본은 published_at 필수
);
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;   -- 정책 없음 → 비-service_role 접근 0
grant all on public.events to service_role;
-- 목록(미삭제, 고정 우선·최신순)
create index if not exists idx_events_list on public.events (status, pinned desc, published_at desc) where deleted_at is null;
-- 팝업/배너 1건 픽(발행·미삭제·플래그 부분 인덱스)
create index if not exists idx_events_popup on public.events (priority desc, published_at desc)
  where status = 'published' and deleted_at is null and popup_active;
create index if not exists idx_events_banner on public.events (priority desc, published_at desc)
  where status = 'published' and deleted_at is null and banner_active;

-- 변경 감사(누가·언제·무엇) — service_role 전용. money 원장(admin_actions_ledger) 부적합 → 전용(0029 선례).
create table if not exists public.events_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  action text not null check (action in ('event_saved','event_published','event_unpublished','event_deleted')),
  details jsonb not null default '{}'::jsonb,   -- 변경 핵심 메타(save) / 이전→이후 status(publish 등). 전체 body diff 금지.
  admin_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.events_audit enable row level security;
revoke all on public.events_audit from anon, authenticated;
grant all on public.events_audit to service_role;
create index if not exists idx_events_audit on public.events_audit (event_id, created_at desc);

-- 저장(upsert: id null=신규 draft / id=수정, status·published_at 불변) + 감사. 내부 admin 재검증·이미지 출처 검증·advisory lock.
create or replace function public.admin_save_event(
  p_id uuid, p_type text, p_title text, p_summary text, p_body text, p_cover_image_path text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_popup_active boolean, p_banner_active boolean,
  p_priority int, p_pinned boolean, p_noindex boolean, p_popup_dismiss_days int, p_admin_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_cover text := nullif(btrim(coalesce(p_cover_image_path, '')), '');
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
  -- 이미지: events 버킷 상대경로만(URL·절대경로·탈출·SVG 금지)
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
       popup_active, banner_active, priority, pinned, noindex, popup_dismiss_days, created_by, updated_at)
    values
      (p_type, 'draft', btrim(p_title), btrim(p_summary), p_body, v_cover, p_starts_at, p_ends_at,
       coalesce(p_popup_active,false), coalesce(p_banner_active,false), coalesce(p_priority,0),
       coalesce(p_pinned,false), coalesce(p_noindex,false), p_popup_dismiss_days, p_admin_id, now())
    returning id into v_id;
  else
    perform pg_advisory_xact_lock(hashtext('event:' || p_id::text));
    update public.events set
      type = p_type, title = btrim(p_title), summary = btrim(p_summary), body = p_body,
      cover_image_path = v_cover, starts_at = p_starts_at, ends_at = p_ends_at,
      popup_active = coalesce(p_popup_active,false), banner_active = coalesce(p_banner_active,false),
      priority = coalesce(p_priority,0), pinned = coalesce(p_pinned,false), noindex = coalesce(p_noindex,false),
      popup_dismiss_days = p_popup_dismiss_days, updated_at = now()
    where id = p_id and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;

  insert into public.events_audit (event_id, action, details, admin_user_id)
    values (v_id, 'event_saved',
      jsonb_build_object('type', p_type, 'title', btrim(p_title),
        'popup_active', coalesce(p_popup_active,false), 'banner_active', coalesce(p_banner_active,false),
        'is_new', (p_id is null)),
      p_admin_id);

  return v_id;
end; $$;
revoke all on function public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,int,boolean,boolean,int,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_event(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean,int,boolean,boolean,int,uuid) to service_role;

-- 발행: draft → published (+ published_at 1회 설정). advisory lock·내부 admin 재검증.
create or replace function public.admin_publish_event(p_id uuid, p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prev text;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('event:' || p_id::text));
  select status into v_prev from public.events where id = p_id and deleted_at is null;
  if v_prev is null then raise exception 'not_found'; end if;
  update public.events set status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
    where id = p_id;
  insert into public.events_audit (event_id, action, details, admin_user_id)
    values (p_id, 'event_published', jsonb_build_object('from', v_prev, 'to', 'published'), p_admin_id);
  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_publish_event(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_publish_event(uuid,uuid) to service_role;

-- 발행취소: published → draft(공개 노출 중단). published_at 은 보존(재발행 시 안정 정렬).
create or replace function public.admin_unpublish_event(p_id uuid, p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prev text;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('event:' || p_id::text));
  select status into v_prev from public.events where id = p_id and deleted_at is null;
  if v_prev is null then raise exception 'not_found'; end if;
  update public.events set status = 'draft', updated_at = now() where id = p_id;
  insert into public.events_audit (event_id, action, details, admin_user_id)
    values (p_id, 'event_unpublished', jsonb_build_object('from', v_prev, 'to', 'draft'), p_admin_id);
  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_unpublish_event(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_unpublish_event(uuid,uuid) to service_role;

-- 삭제: 소프트삭제(deleted_at). 공개·목록·상세에서 즉시 사라짐. 객체/행 보존(감사).
create or replace function public.admin_delete_event(p_id uuid, p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.member_accounts where user_id = p_admin_id and is_admin = true) then
    raise exception 'not_admin';
  end if;
  perform pg_advisory_xact_lock(hashtext('event:' || p_id::text));
  update public.events set deleted_at = now(), updated_at = now()
    where id = p_id and deleted_at is null returning id into v_id;
  if v_id is null then raise exception 'not_found'; end if;
  insert into public.events_audit (event_id, action, details, admin_user_id)
    values (p_id, 'event_deleted', '{}'::jsonb, p_admin_id);
  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.admin_delete_event(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_event(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
