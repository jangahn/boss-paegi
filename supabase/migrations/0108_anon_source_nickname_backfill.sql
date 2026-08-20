-- 0108: 격리된 익명 소스의 '탈퇴한 사용자' 표기 정정(2026-08-21).
-- 0093 개정으로 익명 소스는 격리 시 랜덤 닉네임을 보존한다. 개정 전 격리로
-- 플레이스홀더가 된 익명 소스(회원 행 없음 = 회원 탈퇴자 아님)만 새 랜덤
-- 닉네임을 재부여해 랭킹 오표기를 해소한다.

update public.profiles p
   set display_name = public.random_nickname()
 where p.deleted_at is not null
   and p.display_name = '탈퇴한 사용자'
   and not exists (
     select 1 from public.member_accounts m where m.user_id = p.id
   )
   and exists (
     select 1 from public.oauth_flow_intents f where f.source_user_id = p.id
   );

notify pgrst, 'reload schema';
