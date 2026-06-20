-- 0010: Kakao+Google OAuth 멤버십 — 공개프로필/멤버십 분리 + 생성권 크레딧 + 아바타 + 리더보드 아바타
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- additive only — 구 코드와 공존(롤아웃 1단계). daily_gen_limit 은 코드 전환 후 후속 0011 에서 제거.

-- ── 1. profiles: 공개 아바타 컬럼 + 컬럼레벨 update 잠금 ─────────────────
-- avatar_url 은 공개 프로필(랭킹 노출). 변경은 검증된 /api/avatar(admin) 으로만.
alter table public.profiles
  add column if not exists avatar_url text;

-- 클라(authenticated)는 display_name 만 직접 수정. avatar_url/그외는 admin(service_role)만.
-- self-update RLS 는 유지(= row 게이트). 컬럼 게이트는 grant 로 이중화.
-- updated_at/version 은 BEFORE UPDATE 트리거(0007)가 채우므로 컬럼권한과 무관.
-- (현재 클라 profiles update 는 updateNickname 의 display_name 단일 컬럼뿐 — 전수 확인됨.)
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ── 2. member_accounts: private 멤버십 상태 (생성권/가입시각) ───────────
-- profiles 와 분리 이유: profiles 는 self-update + public-read 라 거기 두면
-- 유저가 자기 크레딧 변조 / 타인 멤버상태·크레딧 노출. 멤버십은 private 격리.
create table if not exists public.member_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  gen_credits int not null default 0 check (gen_credits >= 0),
  member_since timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.member_accounts enable row level security;

-- 본인 row 만 read (UI 멤버여부/잔여 크레딧 표시). public read 절대 없음.
drop policy if exists "member_accounts: self read" on public.member_accounts;
create policy "member_accounts: self read"
  on public.member_accounts for select using (auth.uid() = user_id);

-- 클라 write 금지(읽기만) → service_role / SECURITY DEFINER RPC 만 변경.
revoke insert, update, delete on public.member_accounts from anon, authenticated;
grant all on public.member_accounts to service_role;

-- ── 3. 크레딧 RPC (member_accounts 대상, service_role 전용) ─────────────
-- 원자적 차감/환불 — JS read-modify-write race + check(>=0) 500 회피.
create or replace function public.consume_gen_credit(p_user uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare remaining int;
begin
  update public.member_accounts
     set gen_credits = gen_credits - 1
   where user_id = p_user
     and gen_credits >= 1
  returning gen_credits into remaining;
  return remaining;  -- 잔여 크레딧, 또는 차감 불가(0 또는 비멤버) 시 null
end;
$$;

create or replace function public.refund_gen_credit(p_user uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare remaining int;
begin
  update public.member_accounts
     set gen_credits = gen_credits + 1
   where user_id = p_user
  returning gen_credits into remaining;
  return remaining;
end;
$$;

-- 클라 직접 호출 금지 — service_role(admin client) 만.
revoke all on function public.consume_gen_credit(uuid) from public, anon, authenticated;
revoke all on function public.refund_gen_credit(uuid) from public, anon, authenticated;
grant execute on function public.consume_gen_credit(uuid) to service_role;
grant execute on function public.refund_gen_credit(uuid) to service_role;

-- ── 4. get_leaderboard: avatar_url 추가 (profiles join, member_accounts 조인 금지) ──
-- ⚠️ RETURNS shape 변경 → DROP 먼저 (create or replace 만으론 "cannot change return type" 에러).
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
  doll_image_url text,
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
    d.image_url as doll_image_url,
    p.avatar_url
  from best b
  left join public.profiles p on p.id = b.owner_id
  left join public.dolls d on d.id = b.doll_id
  order by b.score desc, b.created_at desc
  limit max_limit;
$$;
grant execute on function public.get_leaderboard(text, int) to anon, authenticated;

-- ── 5. avatars 공개 버킷 (dolls/highlights 패턴, per-object RLS 없음 = 서명업로드+admin) ──
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;
