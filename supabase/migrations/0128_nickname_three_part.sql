-- 0128_nickname_three_part.sql — 랜덤 닉네임 v2(v1.45): 숫자 없는 3조각 "접두 수식어명사" + 기존 자동 닉네임 백필.
--
-- 종전(0003·0076): 접두어 15개 + 공백 + 4자리 숫자(예: "점심시간수호자 1418") — 길고(평균 10.2자) 숫자가 어글리(사용자).
-- 신규: 접두 20 × 수식어 40 × 명사 50 = 40,000 조합, 각 조각 ≤3자·공백 1개 → 길이 6~10자 보장(커스텀 닉네임 상한도 10자로,
-- lib/profile.ts NICKNAME_MAX). 활성 프로필과 겹치면 최대 30회 재추첨(표시 이름은 유일 제약 없음 — 30회 전부 충돌은 확률상 무시).
-- 어휘는 __tests__/account/nickname-vocab.test.ts 가 이 파일을 파싱해 개수·길이·중복·숫자 없음을 고정한다.
-- 백필: 자동 생성 패턴 그대로인 활성 프로필(익명 2,088 + 자동 이름을 그대로 쓰는 회원 3)을 새 규칙으로 재추첨 — 직접 바꾼
-- 닉네임(패턴 불일치)은 건드리지 않는다. 되돌릴 수 있게 old/new 매핑을 nickname_backfill_2026_09 에 남긴다(RLS·권한 차단).
-- 트리거 handle_new_user() 는 random_nickname() 을 그대로 호출(시그니처 불변). ACL 은 0076 과 동일(public·anon·authenticated revoke).

create or replace function public.random_nickname()
returns text
language plpgsql
as $$
declare
  prefixes text[] := array[
    '진성', '프로', '초보', '전설의', '우리팀', '옆팀', '숨은', '자칭', '공식', '만년',
    '신입', '고인물', '사내', '본사', '옥상', '지하', '야심찬', '소문난', '복귀한', '무적'
  ];
  modifiers text[] := array[
    '야근', '칼퇴', '월급', '커피', '회의', '보고', '결재', '주말', '점심', '퇴근',
    '출근', '지각', '연차', '반차', '재택', '탕비실', '복사실', '회식', '눈치', '열정',
    '소심', '심야', '새벽', '월요', '금요', '졸린', '배고픈', '엘베', '단톡', '성과급',
    '상여금', '워크숍', '회의록', '명함', '사원증', '출장', '법카', '야식', '간식', '퇴직금'
  ];
  nouns text[] := array[
    '요정', '루팡', '유령', '좀비', '장인', '기계', '달인', '고수', '꿈나무', '수호자',
    '은둔자', '동지', '잠수부', '방랑자', '탐험가', '수집가', '관찰자', '파수꾼', '해결사', '승부사',
    '예술가', '철학자', '중재자', '흑기사', '반장', '총무', '막내', '도사', '요원', '챔피언',
    '생존자', '순례자', '빌런', '히어로', '전사', '용사', '감별사', '연구원', '마법사', '선구자',
    '실무자', '탈출러', '낭인', '대변인', '사냥꾼', '수호신', '감독', '해설가', '전문가', '대장'
  ];
  candidate text;
  i int;
begin
  for i in 1 .. 30 loop
    candidate := prefixes[1 + floor(random() * array_length(prefixes, 1))::int]
      || ' '
      || modifiers[1 + floor(random() * array_length(modifiers, 1))::int]
      || nouns[1 + floor(random() * array_length(nouns, 1))::int];
    if not exists (
      select 1 from public.profiles p
       where p.display_name = candidate and p.deleted_at is null
    ) then
      return candidate;
    end if;
  end loop;
  return candidate;
end;
$$;
revoke all on function public.random_nickname()
  from public, anon, authenticated;

-- ── 백필 매핑(되돌리기용) — 앱 표면 노출 금지 ────────────────────────────────
create table if not exists public.nickname_backfill_2026_09 (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  old_name text not null,
  new_name text not null,
  backfilled_at timestamptz not null default now()
);
alter table public.nickname_backfill_2026_09 enable row level security;
revoke all on table public.nickname_backfill_2026_09 from public, anon, authenticated;

-- ── 백필: 자동 생성 패턴(구 접두어 15 + ' ' + 4자리) 그대로인 활성 프로필만 ──────
do $$
declare
  r record;
  n text;
  legacy_pattern constant text :=
    '^(분노한 사원|퇴사꿈나무|야근요정|월급루팡|칼퇴전문가|회의실유령|점심시간수호자|참을인세번|보고서기계|결재대기중|커피수혈러|주말출근러|단톡방잠수부|엘리베이터동지|모니터뒤은둔자) [0-9]{4}$';
begin
  for r in
    select id, display_name
      from public.profiles
     where deleted_at is null
       and display_name ~ legacy_pattern
     order by created_at
  loop
    loop
      n := public.random_nickname();
      exit when not exists (
        select 1 from public.profiles p where p.display_name = n and p.deleted_at is null
      );
    end loop;
    insert into public.nickname_backfill_2026_09 (profile_id, old_name, new_name)
    values (r.id, r.display_name, n)
    on conflict (profile_id) do nothing;
    update public.profiles set display_name = n where id = r.id;
  end loop;
end;
$$;
