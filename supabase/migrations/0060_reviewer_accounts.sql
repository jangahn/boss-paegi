-- 0060: PG 심사·테스트용 ID/PW 계정 원장(reviewer_accounts).
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- 배경: PG(카카오페이 등) 심사는 로그인 가능한 테스트 계정 ID/PW 회신을 요구하는데, 운영자
--   구글 계정은 구글 보안(새 기기 로그인 차단)에 걸려 전달이 불가했다. Supabase email/password
--   프로바이더로 심사 전용 계정을 만들고(/login?reviewer=1 진입), 이 표가 그 계정의 SoT.
--   생성·비번재설정·활성토글·삭제(CUD)는 어드민 UI(/admin/reviewers → /api/admin/reviewers,
--   service_role auth.admin 경유)가 수행. 초기 1건은 운영자가 직접 시드.
-- 판정 통합: 결제 허용·테스트 채널 스위칭(payModeFor)의 reviewer 여부 =
--   growth_levers.reviewerEmails(OAuth 심사관 allowlist, 콘솔 편집) OR 이 표의 active 행
--   (lib/reviewer.ts isReviewerUser — /credits 표시와 /api/pay/checkout 이 공유).
-- 삭제 정책: 행 삭제 시 auth 계정은 지우지 않고 ban(주문 FK RESTRICT — 결제기록 5년 보존과 충돌 방지).

begin;

create table public.reviewer_accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  active     boolean not null default true,
  note       text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reviewer_accounts is
  'PG 심사·테스트용 ID/PW 계정 — active 행은 결제 허용 + 테스트 채널 스위칭 대상. 어드민 UI 로 CUD.';

-- server-only: 정책 0 + 권한 회수 — service_role(어드민 라우트·판정 유틸)만 접근.
alter table public.reviewer_accounts enable row level security;
revoke all on table public.reviewer_accounts from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
