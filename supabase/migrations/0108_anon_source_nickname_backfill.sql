-- 0108: 격리된 익명 소스의 '탈퇴한 사용자' 표기 정정(2026-08-21).
-- 0093 개정으로 익명 소스는 격리 시 랜덤 닉네임을 보존한다. 개정 전 격리로
-- 플레이스홀더가 된 익명 소스(회원 행 없음 = 회원 탈퇴자 아님)만 새 랜덤
-- 닉네임을 재부여해 랭킹 오표기를 해소한다.

-- bp_reject_deleted_profile_update 가드는 '탈퇴 유지 중 업데이트'를 전면 차단하므로
-- 이 1회성 표기 정정은 트리거를 국소 해제하고 수행한다(딱 display_name만 변경).
set local session_replication_role = replica;

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

set local session_replication_role = origin;

notify pgrst, 'reload schema';
