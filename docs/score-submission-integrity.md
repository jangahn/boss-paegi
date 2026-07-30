# 점수 제출 무결성 계약

`0074_score_submission_integrity.sql`과 `/api/score`가 함께 보장하는 점수·리포트·텔레메트리 계약이다.

## 불변식

- 한 판은 클라이언트가 만든 RFC 4122 `submissionId` 하나를 갖는다. 같은 판의 HTTP 재시도, 503 재시도, reload 복구는 모두 같은 값을 쓴다.
- 새 판은 결과 모달의 닫힘→열림 edge로 구분하고 `startedAt` 변화도 보조로 확인한다. 저정밀 브라우저 timer가 서로 다른 두 판에 같은 `startedAt`을 줘도 UUID를 재사용하지 않는다.
- `scores(submission_origin_owner_id, submission_id)` partial unique index가 텔레메트리 유무와 무관하게 한 판을 한 행으로 수렴시킨다. origin owner는 익명→회원 이전 뒤에도 바뀌지 않아, 서로 다른 owner가 수학적으로 같은 UUID를 만든 경우도 두 점수를 보존한다.
- 서버는 정제된 core 필드·요청된 doll/telemetry UUID·canonical `gameplayStats`를 key-order canonical JSON으로 만든 뒤 SHA-256 `submission_fingerprint`를 저장한다. 실제 링크 허용 여부는 DB 관측에 따라 재시도 사이 바뀔 수 있으므로 최초 commit 링크가 이기며, 같은 key로 요청 UUID/core/stats를 바꾸면 `submission_id_conflict`다.
- 텔레메트리 UUID 자체는 권한이 아니다. 회원과 익명 모두 `sha256(session_id:user_id)` binding이 일치해야 하며, 익명 row에는 raw Auth subject를 저장하지 않는다.
- `scores`는 `anon`·`authenticated`·`service_role` 모두 SELECT-only다. 제출·리뷰·관리자 상태 전이는 목적별 SECURITY DEFINER RPC만 사용한다.
- visible 점수의 `score_stats`와 `user_badges`는 `commit_score_report` 한 트랜잭션에서 확정된다. 최초 snapshot은 immutable하다.
- 응답이 badge INSERT 뒤 유실돼도 `user_badges.first_score_id=score_id`가 durable receipt이므로 재시도 응답의 `newBadges`가 복원된다. 다른 점수에서 먼저 얻은 badge는 포함하지 않는다.
- badge catalog는 uncached strict read다. 정상 no-row만 코드 seed를 쓰고 DB 오류·invalid 발행 row는 report 503으로 재시도한다.
- percentile은 시점에 따라 달라지는 선택적 표시 snapshot이다. 조회 오류·범위 밖 값은 의도적으로 `null`로 commit하며 점수와 badge transaction을 막지 않는다.
- pending/voided 점수는 leaderboard, percentile, HTML share, OG, public history에서 모두 숨긴다.

## 클라이언트 재시도와 durable outbox

`useScoreSubmission`은 새 판을 감지한 같은 effect에서 즉시 제출한다. `startedAt=0`도 유효한 timestamp이며 duration은 explicit finite/order 검사로 계산한다.

요청 body는 네트워크 호출 전에 localStorage outbox에 기록한다. 같은 key의 후속 body는 최초 durable body를 덮어쓰지 않는다. UUID `scoreId`와 review/percentile/badge/count 타입을 모두 만족하는 2xx ACK 뒤에만 삭제한다.

- 열린 화면: 1초, 2초, 4초 뒤 자동 재시도(총 4회) 후 수동 “다시 시도”.
- reload/탭 종료 뒤: `SessionBootstrap`이 모든 유효 entry를 확인한다. 현재 Auth owner entry는 정상 재전송하고, 다른 owner entry는 source-owner hint를 붙여 같은 bounded schedule로 한 번 복구를 시도한다.
- 다른 owner hint는 권한이 아니다. DB가 완료된 `source→현재 owner` 이전 영수증, 이미 현재 owner로 이동된 score, 같은 origin submission key와 fingerprint를 모두 확인한 경우에만 기존 행으로 수렴한다. 무관한 계정의 409 entry는 삭제하지 않고 TTL 동안 보존한다.
- malformed/future/7일 초과 entry는 replay하지 않는다.
- localStorage를 사용할 수 없는 브라우저에서도 현재 요청은 계속되지만 reload durability는 제공할 수 없다.

## 익명 → 회원 이전

`reassign_anon_data(old,new)`는 다음 두 telemetry 형태를 함께 이전한다.

- 구 스키마: `owner_id=old`
- 0074 익명: `owner_id is null`, `is_anon=true`, `submitter_binding=hash(session,old)`

이전된 세션은 `owner_id=new`, `is_anon=false`, `binding=hash(session,new)`가 된다. score의 현재 `owner_id`만 new로 바뀌고 `submission_origin_owner_id=old`는 유지된다. source advisory lock과 `anon_data_reassignments` winner receipt로 동시 두 target 중 하나만 이긴다. 같은 target 재시도는 최초 결과를 반환하고 다른 target은 `anon_reassignment_conflict`다. RPC가 성공한 뒤에만 account orchestration이 old Auth user를 삭제한다. 점수 저장 뒤 report 응답이 유실된 채 이전된 outbox는 이 영수증과 origin/fingerprint를 모두 증명해야만 target 세션에서 재개된다.

## 무중단 적용 순서

`0072` 이후 QA 하드닝 묶음은 expand/contract 방식으로 배포한다.

1. 구 앱의 비결제 기능은 계속 서비스하되 `0087` 적용 전에 checkout을 유지보수
   모드로 동결한다. `0072`부터
   `0087_payment_evidence_expand_ddl.sql` →
   `008800_payment_evidence_expand_validate.sql` →
   `008899_server_read_surface_rollout_gate.sql`까지 순서대로 적용한다.
2. `npm run qa:db:rollout-expand`와 운영 read-only probe로 구·신 RPC, 구 서버의 제한된 DML, 두 rollout flag, 새 서버의 25개 PostgREST read 표면을 확인한다.
3. 12-arg checkout caller를 포함한 새 앱을 배포하고 점수 제출·텔레메트리·생성 종결·관리자 read를 smoke한다. `submissionId`가 없는 구 서버 점수 요청은 rollout flag가 켜진 동안에도 판별 가능한 exact legacy shape만 허용한다. 텔레메트리 UUID가 있으면 합성 submission identity가 결정적이라 응답 유실 재시도가 한 행으로 수렴한다. `submissionId`와 텔레메트리 UUID가 모두 없으면 응답 유실 재시도와 별개의 동일 게임을 구분할 정보가 없으므로 `client_upgrade_required`로 fail-closed하며 행을 만들지 않는다.
4. PortOne 레거시 evidence backfill과 구 서버 요청·배경 작업·legacy repair drain을
   완료한 뒤 `0090_payment_evidence_contract_constraint.sql` →
   `0091_payment_evidence_contract_validate.sql` →
   `0092_rollout_contract_cleanup.sql`을 적용한다.
5. `npm run qa:db:rollout-contract`로 legacy RPC/DML/브라우저 DELETE와 두 rollout flag가 닫히고 새 RPC·정확한 doll INSERT 열·25개 read 표면만 남았는지 확인한다.

`0076`은 expand 단계에서 구 브라우저의 owner-scoped doll DELETE를 잠시 유지하고,
최종 회수는 `0092`가 담당한다. `0092` 이후에는 submission identity가 없는 점수
요청과 구 생성 전이를 다시 허용하지 않는다. 앱-first 배포는 새 코드가 아직 없는
DB 열을 읽어 실패하므로 금지한다. 결제의 9-arg/12-arg 경계와 all-NULL evidence
fail-closed 계약은 `docs/qa-validation-report.md`와
`docs/portone-cutover-runbook.md`를 따른다.

## 자동 검증

```sh
node --experimental-strip-types --test __tests__/score/*.test.ts
docker exec -i supabase_db_boss-paegi \
  psql -X -Aqt -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/tests/score_submission_integrity.pgtap.sql
npm run qa:db:anon-reassign-race
npm run qa:db:anon-reassign-write-race
npm run qa:db:score-ban-race
npm run qa:db:apply:expand
npm run qa:db:rollout-expand
npm run qa:db:apply:contract
npm run qa:db:rollout-contract
```

검증 범위:

- 9개 무기의 1..19타 S2 경계
- hitCount 0..1000의 실제 궁극 게이지 상한
- 9^1..9^4 무기 순열, combo 0..100,000, score/stat 보존
- highlight 길이 0..7의 모든 유한 정수 trace와 brute-force 비교
- UUID version/variant 전 도메인, `startedAt=0`, null/역순/비유한 시간
- telemetry owner/binding 전체 상태 행렬
- telemetry 없음·unbound·cross-owner, response loss, 같은 key의 stats/core 변경
- report 중복/설정 drift/응답 유실 badge receipt
- submit→ban, ban→stale submit 두 실제 세션 순서 모두 최종 voided·badge 0으로 수렴
- 익명 source를 서로 다른 두 target이 동시에 이전하는 실제 두 세션 경합
- 익명이전 전·후 source 점수/텔레메트리 쓰기의 두 commit 순서와 late-write receipt fence
- 점수 commit 뒤 응답유실→익명이전→target outbox 복구, 무관한 target 거부, cross-owner UUID 충돌 보존

실제 고주사율·터보마우스·모바일 lifecycle과 브라우저별 storage eviction은 실기기 검증이 필요하므로 자동 QA의 증명 범위에 포함하지 않는다.
