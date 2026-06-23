-- 0022: 어드민 read-side — 전체주문/처리내역/유저상세 페이지를 위한 인덱스 + 검색·집계 RPC.
-- 전부 additive(create index if not exists / create or replace / add column if not exists). 재적용 안전(멱등).
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
--
-- 보안: 읽기 RPC 는 SECURITY INVOKER(기본) + 명시 revoke/grant(0020 패턴 일관) → service_role 만 실행.
--       service_role(admin client)는 bypassrls 로 전수 조회. (invoker+RLS 가 1차 방어, revoke 가 심층방어.)
-- refund_state: search_orders 반환 형태 일관성을 위해 컬럼을 여기서 추가(읽기). 실제 쓰기/전환 로직은 0023(머니 패스).

-- ── 인덱스 ──
create index if not exists idx_payapp_orders_created
  on public.payapp_orders(created_at desc);
create index if not exists idx_admin_ledger_type_created
  on public.admin_actions_ledger(action_type, created_at desc);
create index if not exists idx_admin_ledger_target_created
  on public.admin_actions_ledger(target_user_id, created_at desc);

-- ── refund_state 컬럼(읽기용 — 쓰기는 0023) + 복구/고착 목록용 부분 인덱스 ──
alter table public.payapp_orders
  add column if not exists refund_state text
  check (refund_state in ('in_progress', 'payapp_done', 'done'));
create index if not exists idx_payapp_orders_refund_state
  on public.payapp_orders(refund_state, updated_at)
  where refund_state in ('in_progress', 'payapp_done');

-- ── LIKE 이스케이프 헬퍼 — 백슬래시 먼저(활성 이스케이프 문자) → %/_ 순. 드리프트 방지 단일 소스. ──
create or replace function public.like_escape(p text)
returns text language sql immutable set search_path = public as $$
  select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- ── 회원 부분검색(이메일/닉네임 ILIKE) — UUID exact 는 호출부에서 처리 ──
-- 대소문자 무시, 리터럴 이스케이프, 최신가입(member_since desc) 최대 p_limit(<=100).
create or replace function public.search_members(p_q text, p_limit int default 30)
returns table (
  user_id uuid, display_name text, email text,
  gen_credits int, member_since timestamptz, is_admin boolean
) language sql stable security invoker set search_path = public as $$
  select m.user_id, p.display_name, m.email, m.gen_credits, m.member_since, m.is_admin
  from public.member_accounts m
  join public.profiles p on p.id = m.user_id
  where length(coalesce(p_q, '')) >= 1 and (
    m.email ilike '%' || public.like_escape(p_q) || '%'
    or p.display_name ilike '%' || public.like_escape(p_q) || '%'
  )
  order by m.member_since desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

-- ── 주문 검색·페이징 — order_uuid::text / mul_no prefix(또는 exact) + status 필터 + total_count ──
-- p_q null/'' 이면 전체. 캐스트/집계를 서버에 둬 PostgREST 캐스트 회피 + 정확 totalPages.
create or replace function public.search_orders(
  p_q text default null, p_status text default null,
  p_limit int default 10, p_offset int default 0
)
returns table (
  order_uuid uuid, status text, amount int, credits int, product_id text,
  mul_no text, created_at timestamptz, paid_at timestamptz, user_id uuid,
  display_name text, refund_state text, total_count bigint
) language sql stable security invoker set search_path = public as $$
  with filtered as (
    select o.order_uuid, o.status, o.amount, o.credits, o.product_id,
           o.mul_no, o.created_at, o.paid_at, o.user_id, p.display_name, o.refund_state
    from public.payapp_orders o
    left join public.profiles p on p.id = o.user_id
    where (p_status is null or p_status = '' or o.status = p_status)
      and (
        p_q is null or p_q = ''
        or o.order_uuid::text ilike public.like_escape(p_q) || '%'
        or o.mul_no ilike public.like_escape(p_q) || '%'
      )
  )
  select f.order_uuid, f.status, f.amount, f.credits, f.product_id,
         f.mul_no, f.created_at, f.paid_at, f.user_id, f.display_name, f.refund_state,
         count(*) over() as total_count
  from filtered f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- ── 유저 상세: 생성 내역 경량 목록(candidate_urls 배열 미반환, count 만) + total_count ──
create or replace function public.get_user_generations(
  p_owner uuid, p_limit int default 10, p_offset int default 0
)
returns table (
  id uuid, status text, role text, picked_doll_id uuid, created_at timestamptz,
  candidate_count int, total_count bigint
) language sql stable security invoker set search_path = public as $$
  select g.id, g.status, g.role, g.picked_doll_id, g.created_at,
         jsonb_array_length(coalesce(g.candidate_urls, '[]'::jsonb)) as candidate_count,
         count(*) over() as total_count
  from public.ai_generations g
  where g.owner_id = p_owner
  order by g.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- ── EXECUTE 권한: 0020 패턴대로 service_role 만(심층방어 — invoker+RLS 위 한 겹 더). ──
revoke all on function public.search_members(text, int) from public, anon, authenticated;
revoke all on function public.search_orders(text, text, int, int) from public, anon, authenticated;
revoke all on function public.get_user_generations(uuid, int, int) from public, anon, authenticated;
grant execute on function public.search_members(text, int) to service_role;
grant execute on function public.search_orders(text, text, int, int) to service_role;
grant execute on function public.get_user_generations(uuid, int, int) to service_role;
