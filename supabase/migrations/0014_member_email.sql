-- 0014: member_accounts.email — 이벤트/연락용 queryable 컬럼
--
-- 적용: management API. additive (컬럼 추가 + backfill).
-- 저장 위치 근거: profiles 는 public-read RLS(0004) → 이메일 넣으면 전 회원 공개 노출(PII 사고).
--   member_accounts 는 self-read-only(0010) + 클라 write revoke → 비공개 안전.
-- auth.users.email 이 source-of-truth, 여기는 앱-queryable 복제본(콜백에서 변경 시 최신화).
-- 추출: service-role(admin)/대시보드 `select email from member_accounts`. 클라 프로필/캐시엔 미노출.

alter table public.member_accounts add column if not exists email text;

-- 기존 멤버 backfill (auth.users.email → member_accounts.email). m.email 은 null 이라 전부 채워짐.
update public.member_accounts m
set email = u.email
from auth.users u
where u.id = m.user_id and m.email is distinct from u.email;
