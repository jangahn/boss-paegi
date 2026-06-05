-- boss-paegi 초기 스키마
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣거나 supabase CLI 로 push.

-- 1. profiles : 모든 사용자 (anonymous 포함). auth.users 와 1:1
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles: self read"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: self insert"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles: self update"
  on public.profiles for update
  using (auth.uid() = id);

-- auth.users 가 생성될 때 profiles 자동 생성 (랜덤 동물명)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, '익명' || substr(new.id::text, 1, 6));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. dolls : 생성된 인형 (사용자 갤러리)
create table public.dolls (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  image_url text not null,
  style_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.dolls enable row level security;

create policy "dolls: owner read"
  on public.dolls for select using (auth.uid() = owner_id);

create policy "dolls: owner insert"
  on public.dolls for insert with check (auth.uid() = owner_id);

create policy "dolls: owner delete"
  on public.dolls for delete using (auth.uid() = owner_id);

create index on public.dolls (owner_id, created_at desc);

-- 3. scores : 게임 점수 (랭킹용)
create table public.scores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  doll_id uuid references public.dolls(id) on delete set null,
  score int not null check (score >= 0 and score < 10000000),
  weapon text not null,
  duration_ms int not null check (duration_ms > 0 and duration_ms <= 600000),
  created_at timestamptz not null default now()
);
alter table public.scores enable row level security;

-- 점수는 모두가 읽을 수 있음 (랭킹). 본인만 insert.
create policy "scores: public read"
  on public.scores for select using (true);

create policy "scores: owner insert"
  on public.scores for insert with check (auth.uid() = owner_id);

create index on public.scores (score desc, created_at desc);
create index on public.scores (owner_id, created_at desc);

-- 4. ai_generations : AI 생성 쿼터/감사
create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  fal_request_id text,
  status text not null check (status in ('queued', 'done', 'failed')),
  cost_cents int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.ai_generations enable row level security;

create policy "ai_generations: owner read"
  on public.ai_generations for select using (auth.uid() = owner_id);

-- insert/update 는 service role (서버 Route) 만. 클라이언트 policy 없음.
create index on public.ai_generations (owner_id, created_at desc);

-- 5. Storage 버킷 (Dashboard 에서 직접 생성 권장. 참고용 SQL)
-- insert into storage.buckets (id, name, public) values ('dolls', 'dolls', true);
-- 버킷 정책: owner_id 폴더에만 write, public read.
