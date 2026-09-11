-- 0129_nickname_no_space.sql — 랜덤 닉네임 v2.1(v1.46): 접두와 수식어 사이 공백 제거 + 공백 들어간 자동 닉네임 일괄 정리.
--
-- 사용자 결정(2026-09-11): "접두 수식어명사"보다 공백 없는 "접두수식어명사"(예: 진성상여금용사)가 낫다 → 생성 규칙에서 공백 제거
-- (각 조각 ≤3자 → 길이 5~9자, 숫자·공백 없음; 커스텀 상한 10자는 유지). 0128 이 만든 공백 포함 자동 닉네임(백필분 + 그 이후 가입분)도
-- 공백 없는 형태로 마이그한다. 대상은 **어휘 20×40×50 에 정확히 맞는 "접두 수식어명사" 한 줄**(= 시스템 생성분)만 — 직접 지은
-- 닉네임은 건드리지 않는다. 접두어끼리 서로 접두 관계가 없어(우리/전설/고인/야심/소문/복귀 는 접두어가 아님) 공백 제거는 단사(충돌 없음);
-- 그래도 활성 프로필과 겹치면 재추첨한다. 매핑은 nickname_backfill_2026_09 에 기록(백필 행은 new_name 만 갱신 → old_name 은 0128 이전
-- 원래 이름 그대로 = 롤백 근거, 0128 이후 가입분은 old_name = 공백 포함 생성명으로 신규 행). 어휘·형식은
-- __tests__/account/nickname-vocab.test.ts 가 이 파일을 파싱해 고정한다(함수 배열 = DO 블록 배열).
--
-- 삭제(soft-delete) 프로필도 대상: get_leaderboard()·공유·이력 화면은 deleted_at 을 거르지 않아 삭제된 익명 프로필의 닉네임이
-- 랭킹에 그대로 노출된다(프로드 실측 9/11: 삭제 119명 전원 구 숫자 패턴, 이달 랭킹 창 안 17명). 0128 은 활성만 백필했으므로
-- 여기서 ① 활성 프로필의 공백 포함 생성명 공백 제거, ② 삭제 프로필(회원 행 없는 익명)의 공백 포함 생성명 공백 제거 + 구 자동 패턴
-- (접두어 15 + 4자리) 재추첨을 함께 처리한다. 삭제 프로필은 bp_reject_deleted_profile_update 가드 때문에 0108 과 같은 방식으로
-- 트리거를 국소 해제해 display_name 만 바꾼다. 충돌 검사는 활성 프로필 기준(삭제 프로필은 랭킹 표시 외 식별 용도가 없다).

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

-- ── 마이그: ① 활성 프로필 공백 제거(어휘 정확 일치 "접두 수식어명사" = 0128 생성분) ② 삭제 익명 프로필 공백 제거 + 구 패턴 재추첨 ──
do $$
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
  spaced_pattern text;
  legacy_pattern constant text :=
    '^(분노한 사원|퇴사꿈나무|야근요정|월급루팡|칼퇴전문가|회의실유령|점심시간수호자|참을인세번|보고서기계|결재대기중|커피수혈러|주말출근러|단톡방잠수부|엘리베이터동지|모니터뒤은둔자) [0-9]{4}$';
  r record;
  n text;
begin
  spaced_pattern := '^(' || array_to_string(prefixes, '|') || ') ('
    || array_to_string(modifiers, '|') || ')(' || array_to_string(nouns, '|') || ')$';
  -- ① 공백 제거 — 활성 프로필(트리거 정상 동작)
  for r in
    select id, display_name
      from public.profiles
     where deleted_at is null
       and display_name ~ spaced_pattern
     order by created_at
  loop
    n := replace(r.display_name, ' ', '');
    if exists (
      select 1 from public.profiles p
       where p.display_name = n and p.deleted_at is null and p.id <> r.id
    ) then
      loop
        n := public.random_nickname();
        exit when not exists (
          select 1 from public.profiles p where p.display_name = n and p.deleted_at is null
        );
      end loop;
    end if;
    insert into public.nickname_backfill_2026_09 (profile_id, old_name, new_name)
    values (r.id, r.display_name, n)
    on conflict (profile_id) do update set new_name = excluded.new_name;
    update public.profiles set display_name = n where id = r.id;
  end loop;
  -- ② 삭제 프로필(익명·회원 행 없음) — 공백 포함 생성명은 공백 제거, 0128 이 건너뛴 구 자동 패턴은 재추첨.
  --    bp_reject_deleted_profile_update 가드는 '탈퇴 유지 중 업데이트'를 전면 차단하므로 0108 과 같이 이 1회성 표기 정정에
  --    한해 트리거를 국소 해제한다(딱 display_name 만 변경, 트랜잭션 로컬). 회원 탈퇴자('탈퇴한 사용자' 표기)는 제외.
  -- (set_config() 는 supautils 훅을 타지 않아 postgres 롤에서 거부된다 — SET 문으로)
  execute 'set local session_replication_role = replica';
  for r in
    select p.id, p.display_name
      from public.profiles p
     where p.deleted_at is not null
       and (p.display_name ~ spaced_pattern or p.display_name ~ legacy_pattern)
       and not exists (
         select 1 from public.member_accounts m where m.user_id = p.id
       )
     order by p.created_at
  loop
    if r.display_name ~ spaced_pattern then
      n := replace(r.display_name, ' ', '');
    else
      n := null;
    end if;
    if n is null or exists (
      select 1 from public.profiles p
       where p.display_name = n and p.deleted_at is null
    ) then
      loop
        n := public.random_nickname();
        exit when not exists (
          select 1 from public.profiles p where p.display_name = n and p.deleted_at is null
        );
      end loop;
    end if;
    insert into public.nickname_backfill_2026_09 (profile_id, old_name, new_name)
    values (r.id, r.display_name, n)
    on conflict (profile_id) do update set new_name = excluded.new_name;
    update public.profiles set display_name = n where id = r.id;
  end loop;
  execute 'set local session_replication_role = origin';
end;
$$;
