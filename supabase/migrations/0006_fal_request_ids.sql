-- 0006: queued 생성 복구용 — fal request_id 저장
--
-- 동기 생성 함수가 done 업데이트 전에 죽으면(60s maxDuration / 새로고침 등)
-- fal 은 서버에서 완성돼도 우리 DB row 는 queued 로 박제돼 결과를 잃는다.
-- 생성 시작 시 fal request_id 들을 여기에 저장해두면, 갤러리 재방문 시
-- 이 id 로 fal 에 결과를 다시 물어(queue.status/result) 후보를 복구할 수 있다.
--
-- flux-pulid 는 호출당 1장 → 후보 수만큼(보통 3개) request_id 가 생긴다.
alter table ai_generations
  add column if not exists fal_request_ids text[];

comment on column ai_generations.fal_request_ids is
  '진행 중 생성의 fal queue request_id 목록 (복구용). done/picked 후엔 의미 없음.';
