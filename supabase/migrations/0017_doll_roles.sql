-- 0017: 캐릭터 롤 — dolls.role (부장/임원/팀장/거래처/직장동료).
-- 생성 기본 'boss'. 기존 doll 은 NOT NULL DEFAULT 로 자동 백필='boss'(별도 update 불필요).
-- 롤 변경은 /api/doll PATCH(owner 검증 + admin update)라 별도 UPDATE RLS 정책 불필요.
-- 0007 감사 트리거가 update 시 version/updated_at 자동 갱신.

alter table public.dolls
  add column if not exists role text not null default 'boss'
    check (role in ('boss','exec','teamlead','client','coworker'));
