# 공개 쓰기 quota 계약

인증 없이 또는 익명 Auth로 도달할 수 있는 durable write/egress 표면은 애플리케이션
인스턴스의 메모리 제한만 믿지 않는다. `008900_public_write_quotas.sql`과
`008901_generation_storage_cost_controls.sql`의 PostgreSQL row lock 및 원자
RPC가 모든 인스턴스에 공통인 최종 경계다.

대상은 telemetry, visit/share/conversion analytics, score, content report,
doll signed-URL 발급이다. `analytics_events`, `content_reports`, quota table에는
service role도 직접 INSERT/DML할 수 없으며 허용된 SECURITY DEFINER wrapper만
외부 Data API authority로 남는다.

## actor와 프라이버시

서버가 `member_accounts`의 실제 회원임을 확인한 요청만 Auth UUID를 quota actor로
쓸 수 있다. 익명 Auth UUID와 동의 전 identity는 생성·회전이 쉬우므로 신뢰하지
않고 Vercel edge가 확정한 client IP를 사용한다. `/api/track`, score 자체,
content report, doll signed URL은 항상 network actor를 사용한다. 회원
telemetry와 회원 확정 뒤 conversion만 member Auth actor를 쓸 수 있다.

Vercel은 외부 `X-Forwarded-For`를 그대로 신뢰하지 않고 overwrite하며
`X-Vercel-Forwarded-For`를 제공한다
([Vercel request headers](https://vercel.com/docs/headers/request-headers)).
로컬·preview 호환 순서는 `x-vercel-forwarded-for` → `x-forwarded-for` →
`x-real-ip`다.

원본 Auth UUID와 IP는 요청 메모리 안에서만 service-role secret 기반
HMAC-SHA-256 입력으로 사용한다. 로그·응답·quota DB에는 원본을 남기지 않는다.
edge IP도 없으면 해당 요청이 하나의 `unknown` HMAC bucket을 공유하므로
무제한으로 열리지 않는다. score의 network/owner 차원과 report network 차원은
DB에서 domain prefix와 함께 다시 SHA-256해 서로 연결되지 않는 key로 저장한다.

HMAC actor는 원본 식별자가 아니지만 current와 직전 2개 KST 날짜만 보존하는
pseudonymous security identifier다. `analytics_events`의 무식별 분석 행과
결합하지 않는다. 개인정보처리방침 문구의 검토·발행은 법무 후속 경계이며 QA가
운영 법무 문서를 자동 발행하지 않는다.

## DB 권위와 정확한 일일 상한

모든 quota는 KST 날짜 기준이다. DB 함수는 endpoint/day의 `global` row를 먼저
잠근 뒤 actor row를 고정된 순서로 잠근다. 서로 다른 Vercel 인스턴스와 실제
PostgreSQL 연결도 같은 순서로 직렬화되며, 250ms lock timeout에서 실패하면
데이터를 변경하지 않고 `quota_busy`가 된다.

함수 내부에 별도 3초 statement timeout을 두지 않는다. Data API의 바깥
PostgREST `authenticator` 세션이 8초 statement/lock ceiling을 제공하고,
함수는 더 짧은 250ms quota-lock 경계만 고정한다. migration 자체의 10분
statement timeout은 DDL transaction에만 적용된다.

| 표면 | actor/owner 요청/일 | network 요청/일 | global 요청/일 | 추가 경계 |
|---|---:|---:|---:|---|
| telemetry | actor 1,000 | actor가 network일 수 있음 | 50,000 | actor 신규 세션 30, global 신규 세션 2,000, 세션 write 400 |
| analytics visit/share/conversion | actor 200 | `/api/track`은 항상 network | 2,000 | quota 승인과 event insert가 한 transaction |
| score | owner 100 | 300 | 5,000 | exact submission receipt replay는 quota-free |
| content report | 해당 없음 | 20 | 500 | exact receipt replay는 memory/durable limit 모두 quota-free |
| doll signed URL | 해당 없음 | actor 1,000 units | 10,000 units | 호출당 1~100 units, quota 승인 뒤에만 Storage signing 수행 |

score는 global → network/owner lexical order로 세 차원을 잠근다. report는
global → network 순서다. score/report 앱 경로는 stable submission ID로
`reserve_*_write_attempt`를 먼저 호출해 opaque operation reservation과 quota를
별도 transaction으로 커밋한 뒤 core wrapper를 호출한다. 정확한 receipt replay는
reservation 단계에서 즉시 기존 결과를 반환하고 counter를 바꾸지 않는다.
score의 한 actor 차원이 이미 상한이면 이번 거절에서 새로 생긴 반대 차원의
0-count row도 같은 트랜잭션에서 제거하므로, capped network×새 owner 또는
capped owner×새 network 조합으로 retention row 상한을 우회할 수 없다.

새 intent의 core가 protocol/ownership/lifecycle/target 검증에서 거절되면 wrapper가
예외를 subtransaction에서 잡아 `public_write_attempts`에 terminal error를
커밋하고 동일한 HTTP 오류로 변환 가능한 2xx DB envelope를 반환한다. 따라서
유효한 wire payload이지만 거절될 요청도 quota를 정확히 한 번 소비하고, 같은
operation의 재시도는 core를 다시 실행하지 않는다. payload fingerprint가 바뀌면
conflict다. lock timeout 같은 일시적 busy는 reservation을 `reserved`로 유지하고
`503 + Retry-After`를 반환해 같은 operation이 복구될 수 있다. wrapper 자체도
reservation을 재확인하므로 앱 호출 순서를 우회해도 무제한 core 경로가 생기지 않는다.

rolling expand의 구 score RPC도 owner-derived actor와 global 상한을 거친다.
구 7-argument report RPC에는 신뢰할 network 증거가 없으므로 모든 익명 요청을
하나의 20건 bucket에 넣지 않고 global 500건만 적용한다. `0092` contract에서
두 구 overload의 service-role execute를 회수한다.

## telemetry와 HTTP 결과

- 권위 DB가 확정한 hard quota, invalid ownership, budget/degrade 등은 기존
  `{ok, mode, reason, lastSeq}` ACK로 반환한다. 브라우저는 그 sequence까지
  durable terminal decision으로 처리한다.
- RPC resolved error/throw, malformed success, secret 부재, `quota_busy`는
  `503`, `Cache-Control: no-store`, `Retry-After: 1`이며 `lastSeq`를 보내지
  않는다. 브라우저는 delta를 보존하고 `Retry-After`를 1~60초로 clamp해
  bounded retry한다. 강제 flush는 이 창을 우회할 수 있지만 성공 ACK 전에는
  sequence를 절대 버리지 않는다.
- track/conversion은 제품 동작을 막지 않는 best-effort다. `/api/track`은
  승인·quota drop·dependency failure 모두 `204`와 `no-store`를 반환한다.
- 새 score/report는 quota exhaustion을 `429`, lock contention/dependency
  unavailable을 `503 + Retry-After`로 구분한다. 같은 submission receipt의
  response-loss retry는 cap이 가득 찬 뒤에도 성공한다.

## 보존과 유지보수 capacity

quota primary key는 `(endpoint, day_kst, actor_key)`이고 stale 조회 전용
`(day_kst, endpoint, actor_key)` btree가 별도로 있다. 실패 시도 저장소도
`(day_kst, endpoint, operation_key)` index를 쓰며 원본 IP/Auth/submission ID를
저장하지 않는다. telemetry/analytics 승인 경로는 오래된 quota row를 최대 256개
opportunistic prune한다. 트래픽이 0이어도 일일
`/api/ops/telemetry-maintain`이 독립 privacy 첫 단계로 두 저장소를 합쳐
80,000행 batch를 필수 1회, 잔여 backlog가 있으면 최대 2회까지 10초 부분예산
안에서 drain한다. route 전체는 20초 soft deadline, Vercel은 25초
`maxDuration`, 외부 scheduler request timeout은 90초다.

한 KST 날짜에 수학적으로 생길 수 있는 quota row의 최대치는 다음과 같다.

| quota endpoint | global | actor 차원 최대 | quota row 합계 |
|---|---:|---:|---:|
| telemetry | 1 | 50,000 | 50,001 |
| analytics | 1 | 2,000 | 2,001 |
| score | 1 | network 5,000 + owner 5,000 | 10,001 |
| report | 1 | network 500 | 501 |
| doll signed URL | 1 | network 10,000 | 10,001 |
| quota bucket 소계 | 5 | 72,500 | 72,505 |
| score attempt reservation | 해당 없음 | accepted score intent 5,000 | 5,000 |
| report attempt reservation | 해당 없음 | accepted report intent 500 | 500 |
| 두 저장소 전체 | 5 | 78,000 | 78,005 |

필수 첫 batch 80,000행만으로 exact 일일 최악 78,005행보다 크다. 놓친 실행의
backlog를 위한 호출당 최대 capacity는 `80,000 × 2 = 160,000`이다. 첫 prune이
error이거나 `done:false`여도 telemetry
rollup → telemetry prune → budget refresh는 계속 실행한다. 모든 telemetry
단계가 끝난 뒤 quota error는 500, 잔여 backlog는 503으로 반환하므로 서로
독립인 유지보수 목표가 상대 실패 때문에 생략되거나 false-green이 되지 않는다.

보존 cutoff는 현재 KST 날짜의 이틀 전이다. current와 직전 2개 KST 날짜를
남기고 더 오래된 행을 지운다. 두 batch 또는 시간 예산 뒤 stale 행이 남으면
`done:false`가 scheduler에 그대로 보인다.

## 롤아웃과 검증

`008900`은 bounded telemetry/analytics/score/report wrapper를 추가하고,
`008901`은 doll signed-URL quota를 같은 table에 추가한다. `0092`는 rolling-old
telemetry/score/report overload의 service-role execute와 direct INSERT
compatibility를 닫는다.

```sh
npm run qa:db:apply:expand
npm run qa:db:rollout-expand
npm run qa:db:apply:contract
npm run qa:db:rollout-contract
npm run test:db
npm run qa:db:public-write-race
npm run qa:db:score-report-quota-race
```

pgTAP은 RLS/ACL, raw identifier 부재, exact index order, conversion의 bounded
insert, 모든 actor dimension의 N−1/마지막 슬롯/N+1, exact replay counter
불변, terminal core-error의 durable exact-once quota, rolling-old report
global-only, attempt-priority 80,000행 retention batch를 검증한다. 실제
multi-session harness는 telemetry/analytics와 함께
score/report의 마지막 global slot, concurrent exact retry `quota_busy`,
commit 뒤 quota-free success replay, invalid score/missing report target의
cached failure replay, over-cap durable-state 부재를 충돌시킨다.
