-- 0046_generation_meta.sql
-- 생성 현황 어드민 탭(PR-C)용 메타 2종. additive·무중단. 코드 배포 전 적용 권장.
--
-- ① fail_reason: 지금은 no-face·타임아웃·fal오류·차감실패·제출오류가 전부 status='failed' 한 덩어리라
--    "얼굴없어서 거부"를 다른 실패와 구분 불가. 사유 문자열을 남겨 어드민 상태 필터를 정확히.
--    예상값(자유 텍스트 — CHECK 안 검: 새 사유가 실패 마킹을 깨지 않게):
--      no_face | no_credits | submit_error | fal_error | no_requests | timeout | expired
-- ② picked_index: 후보 3장 중 몇 번째를 골랐는지(0~2). 픽 선호 패턴 분석용. 미상이면 NULL.

alter table public.ai_generations
  add column if not exists fail_reason text,
  add column if not exists picked_index int;

comment on column public.ai_generations.fail_reason is
  '실패 사유(자유 텍스트): no_face|no_credits|submit_error|fal_error|no_requests|timeout|expired. status=failed 일 때만 의미.';
comment on column public.ai_generations.picked_index is
  '고른 후보의 0-based 인덱스(0~2). status=picked 일 때 의미, 미상이면 NULL.';
