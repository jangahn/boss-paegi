-- 0003: 직장인 컨셉 랜덤 닉네임 + scores.max_combo
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣기.

-- 1. 직장인 컨셉 랜덤 닉네임 생성기
create or replace function public.random_nickname()
returns text
language plpgsql
as $$
declare
  prefixes text[] := array[
    '분노한 사원', '퇴사꿈나무', '야근요정', '월급루팡', '칼퇴전문가',
    '회의실유령', '점심시간수호자', '참을인세번', '보고서기계', '결재대기중',
    '커피수혈러', '주말출근러', '단톡방잠수부', '엘리베이터동지', '모니터뒤은둔자'
  ];
begin
  return prefixes[1 + floor(random() * array_length(prefixes, 1))::int]
    || ' ' || lpad(floor(random() * 10000)::int::text, 4, '0');
end;
$$;

-- 2. 신규 유저 기본 닉네임을 직장인 컨셉으로
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, public.random_nickname());
  return new;
end;
$$;

-- 3. 기존 "익명XXXXXX" 유저들도 일괄 변환
update public.profiles
set display_name = public.random_nickname()
where display_name like '익명%';

-- 4. scores 에 최대 콤보 (결과 보고서/공유 랜딩용)
alter table public.scores
  add column if not exists max_combo int not null default 0
  check (max_combo >= 0 and max_combo < 100000);
