-- 생성 시 선택한 롤을 ai_generations 에 기록.
-- 용도: ① resume/"이어서" 복귀 시 doll.role 복구 ② pick 시 dolls.role 권위 소스(클라 신뢰 X).
-- dolls.role(0017)과 동일 CHECK. 기존 row 는 NOT NULL DEFAULT 로 자동 백필 = 'boss'.
alter table public.ai_generations
  add column if not exists role text not null default 'boss'
    check (role in ('boss', 'exec', 'teamlead', 'client', 'coworker'));
