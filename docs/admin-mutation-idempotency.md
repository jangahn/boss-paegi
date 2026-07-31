# 관리자 mutation exactly-once 계약

이 문서는 Migration 0085가 담당하는 외부 관리자 쓰기의 요청 영수증, 응답 유실 복구,
상태 선행조건, 외부 시스템 경계를 정의한다. 크레딧 조정은 0082, 법무 문서는 0081,
심사 계정은 0083이 담당한다. 영구 삭제의 요청 영수증·CAS는 0085가, 실제 Storage
삭제의 durable job·lease fence는 0078이 담당한다.

## 공통 불변식

- `request_id`는 한 관리자·작업·대상·정확한 JSON payload에 영구 결합된다. 같은 UUID를
  다른 컨텍스트나 payload에 재사용하면 `idempotency_conflict`다.
- 완료 영수증과 실제 변경·감사는 한 DB 트랜잭션에 커밋된다. 같은 요청 재생은 저장된
  결과만 반환하며 다시 변경하지 않는다.
- 일반 복구 RPC가 POST보다 먼저 도착하면 `aborted` tombstone을 만든다. 같은 request
  advisory lock 뒤에 도착한 POST는 `request_aborted`로 실패하므로 “미확인 성공”을 새
  변경으로 오인하지 않는다.
- 영수증 테이블은 RLS가 켜져 있고 client policy가 없다. `service_role`도 SELECT만
  가능하며 INSERT/UPDATE/DELETE는 전용 SECURITY DEFINER 함수와 append-only trigger만
  수행한다.
- 상태가 되돌아오는 ABA 시나리오는 monotonic version으로 구분한다. 현재 snapshot 또는
  동일 동시 작업이 만든 바로 다음 version만 no-op으로 수렴할 수 있고, 더 오래된
  snapshot은 상태가 우연히 같아도 충돌한다.
- 모든 version은 JavaScript가 정수로 정확히 표현할 수 있는 `0..2^53-1`로 제한한다.
  경계를 넘는 변경은 트랜잭션 전체가 실패하므로 성공했지만 복구 불가능한 숫자를 만들지
  않는다.
- credential, provider secret, auth token, 비밀번호는 payload나 영수증에 받거나 저장하지
  않는다.

## 표면별 계약

| HTTP 표면 | DB 진입점 | 요청 식별 | 상태 선행조건 | 응답 유실 처리 |
|---|---|---|---|---|
| `POST /api/admin/config` | `admin_update_app_setting_idempotent` | canonical payload의 결정론 UUID | `baseVersion` CAS | 일반 영수증 복구; 선복구는 abort |
| `POST /api/admin/events` save | `admin_save_event_idempotent` | 브라우저가 호출 전 보존한 UUID + create intent `targetKey` | `expectedVersion`; 신규는 0 | 같은 request 재생. UUID가 회전해도 같은 create intent+payload는 한 event로 수렴 |
| `POST /api/admin/events` publish/unpublish/delete | `admin_transition_event_idempotent` | canonical payload의 결정론 UUID | `expectedVersion`; 즉시 동등 경쟁만 no-op | 일반 영수증 복구 |
| moderation dismiss/takedown/restore | `admin_moderation_action_idempotent` | action+state+version 결합 결정론 UUID | `expectedState` + `expectedVersion` | 일반 영수증 복구; report/doll 모든 writer가 version 증가 |
| moderation permanent-delete | `admin_begin_doll_purge_idempotent` → 0078 purge saga | 모달을 열 때 생성하고 최초 전송부터 exact payload와 함께 고정한 UUID | 반드시 `hidden` + 정확한 `moderationVersion` | replay를 현재 상태 확인보다 먼저 수행해 같은 job ID 복구; claim이 `idle`이면 `get_moderation_purge_status`로 terminal 완료를 판정; 새 모달 intent에서만 UUID 회전 |
| integrity clear/void/ban/unban | `admin_integrity_action_idempotent` | action+state+version 결합 결정론 UUID | score/member 상태 + version | 일반 영수증 복구; 같은 snapshot의 동등 경쟁은 한 단계 no-op 수렴 |
| `POST /api/admin/reactivate` | begin → durable Auth-sync job → fenced activate/cancel finish | 삭제 시각·단조 증가 탈퇴 세대와 payload에 결합된 결정론 UUID | 정확한 `deleted_at` + `withdrawal_generation` + request/admin/user + action + lease token/version/expiry | begin은 DB를 활성화하지 않는다. route crash·응답 유실은 `content-maintain`이 이어받고, admin 상세는 최소 pending correlation을 복구한다. activate/cancel 각각의 exact terminal status만 성공으로 복구 |
| `POST /api/admin/settle` | `admin_settle_stuck_order_verified` + `get_admin_settlement_receipt` | 검증한 order/reason의 결정론 UUID | PortOne PAID·금액 검증을 HTTP 계층에서 먼저 수행 | 외부 재호출 전 non-tombstoning receipt peek, mutation 뒤 exact receipt postcondition. superseded `admin_settle_stuck_order_idempotent`는 0095부터 owner-only |

이벤트 create의 `targetKey`는 논리적 생성 의도이고 `request_id`는 전송 시도다. 두
전송 UUID가 동일한 intent와 payload를 사용하면 `event-create-intent` object lock 아래
한 행·한 감사로 수렴하고 각각 복구 가능한 완료 영수증을 얻는다. 같은 intent를 다른
payload에 쓰면 실패한다. 같은 탭에서 응답이 유실된 뒤 폼이 바뀌어도 에디터는 이전
delivery를 DB lock 아래 먼저 복구/abort하고, 완료된 create가 있으면 현재 폼을 그 행의
후속 update로 저장한다. 미확정 요청을 지우고 두 번째 create로 바꾸지 않는다.

## 외부 시스템 경계

재활성화는 DB를 먼저 활성화하면 Auth 변경 실패 동안 탈퇴 계정이 로그인 가능한 상태가
되는 2-system partial commit이 생긴다. 따라서 순서는 다음으로 고정한다.

1. `admin_begin_account_reactivation`이 삭제 timestamp, 단조 증가
   `withdrawal_generation`, 복원 email을 검증하고, 최초
   결정한 `resolved_email`을 exact payload에 고정한 pending 영수증과
   `account_reactivation_jobs` 1행을 같은 트랜잭션에 기록한다. profile은 계속 deleted다.
   identity가 나중에 바뀌어도 재생이 다른 외부 email을 선택하지 않는다.
2. route 또는 `content-maintain` worker가 `request_id + admin_id + user_id` 전부를
   대조해 job을 claim한다. lease token/version/expiry는 완료·실패 기록에 다시 필요하며,
   실패는 지수 backoff의 pending으로 돌아간다. due job을 이번 실행에서 claim하지
   못했더라도 queue-health RPC가 durable pending/leased 수를 세므로 cron은 200을 내지
   않는다. claim 전 의미 검증에서 identity/Auth drift가 발견된 행도 lease를 얻은 뒤
   `preflight_error`로 fenced backoff되므로 queue 선두에서 뒤 job을 영구 굶기지 않는다.
3. worker는 GoTrue의 현재 exact user를 먼저 읽는다. 정확한
   `deleted+<uid>@deleted.invalid` marker일 때만 receipt email로 변경하며, 같은
   `app_metadata.bp_reactivation_fence`에 request/admin/user, lease token/version,
   삭제 timestamp/세대를 함께 기록한다. `auth.users` BEFORE UPDATE trigger가 그 순간
   DB의 live lease·receipt·profile·identity를 다시 검증하므로 lease가 끝난 오래된
   worker는 이후 탈퇴 marker를 되돌릴 수 없다. 다른 실제 email은 절대 덮어쓰지 않으며,
   resolved error/throw 뒤 fresh exact-ID/email/fence read만 커밋 증거다.
4. `finish_account_reactivation_job`이 살아 있는 exact lease와 receipt/job 상관관계,
   원래 `deleted_at`/탈퇴 세대, identity email, `auth.users.email` 및 동일 Auth
   metadata fence를 다시 검증한다. 그 뒤
   job 완료, profile/member 복원, 재동의 표시, 계정 감사, receipt 완료를 한
   트랜잭션에 커밋한다. pending/leased job이 존재하는 동안 profile deletion timestamp
   변경을 trigger가 거부한다. timestamp가 수학적으로 같아도 다음 active→deleted
   전이는 세대를 증가시키므로 이전 intent가 다음 탈퇴 주기를 침범하지 않는다.
5. 브라우저 응답 유실·새로고침으로 React state가 사라져도 관리자 상세는
   `get_pending_account_reactivation`의 단일 job+receipt snapshot에서 request ID,
   삭제 timestamp/세대, cancel intent 여부만 다시 받는다. RPC 내부와 페이지 게이트가
   모두 현재 active admin을 검증하며 다른 target은 `found=false`, 비관리자는
   `not_admin`이다. pending 중 새 activate 입력은 비활성화한다.
6. 취소는 기존 activation lease를 먼저 무효화하고 새 `action=cancel` lease를 만든다.
   Auth가 exact restored email이면 fixed deletion marker로만 되돌리고, 이미 marker면
   Auth 쓰기 없이 끝내며, Auth user가 정확히 없을 때도 삭제 상태를 안전하게 종결한다.
   제3의 실제 email은 절대 덮어쓰지 않는다. 취소 intent의 최초 actor/reason은 불변이고,
   응답 유실 뒤 어느 active admin도 같은 intent의 보상 실행만 재개할 수 있다. terminal
   `cancelled`는 profile 삭제·세대를 유지하고 exact private metadata fence를 지운 뒤
   감사와 receipt/job을 한 트랜잭션에 종결한다.

`lease_version`/`attempt_count`가 int4 최댓값에 도달한 due row는 overflow시키지 않고
finite sentinel 시각과 `lease_counter_exhausted`로 격리해 뒤 job을 막지 않는다. 이미
durable cancel intent인 exact row만 counter epoch를 0으로 되돌려 marker 보상을 끝낼 수
있다.

구 서버가 살아 있는 expand 단계에서는 기존 DB-first route가 profile을 먼저 활성화한
뒤 정확한 `member_accounts.email`을 복원하는 경우만 Auth trigger의 한시 호환 branch가
허용하며, 기존 `admin_complete_account_reactivation`도 legacy 내부 완료 경로를
호출한다. 이 DB-first transaction과 같은 경계에서
`account_reactivation_legacy_repairs`가 active profile의 최종 member email과 탈퇴 세대를
영구 outbox로 캡처하며, migration 이전 orphan과 늦게 commit한 구 transaction도
backfill/deferred trigger가 잡는다. legacy worker는 marker→캡처한 exact email만 별도
lease fence로 복구한다. 제3의 실제 Auth email은 visible backlog로 남고 `0092` drain
gate를 통과하지 못한다. marker→real Auth update와 새 `admin_soft_delete_account`는
전용 advisory transition lock으로 직렬화되어 Auth-first면 새 탈퇴 cleanup outbox가
marker로 다시 scrub하고, withdrawal-first면 늦은 Auth update가 원자 rollback된다.
completed·superseded terminal과 retry 뒤 supersede는 immutable legacy
job/user/generation에 속한 private fence만 제거한다.

profile이 deleted인 새 worker 경로는 expand 중에도 live lease fence가 필수다. 새 route와
background worker 배포 및 old-request/legacy-repair drain 뒤 `0092`가 호환 branch와 직접
완료 권한을 회수하고 permanent claim/arm/finish/status/queue-health/pending-read RPC만
남긴다. 모든 job 테이블 권한은 service role에도 없으며 SECURITY DEFINER RPC만 접근한다.

stuck-order 정산은 반대 유형의 외부 경계다. PortOne 단건 조회는 DB 변경 전에 필요하지만
이미 DB가 커밋된 응답 유실 재시도에서 PortOne 장애가 결과 복구를 막아서는 안 된다.
그래서 라우트는 먼저 read-only settlement receipt를 확인하고, 영수증이 없을 때만
PortOne을 조회한 뒤 mutation RPC를 호출한다. 이 peek는 새 요청을 abort하지 않는다.
정산 결과는 지급 여부를 암시로 판단하지 않는다. 신규 commit, exact request replay,
다른 request가 기존 금융 ledger로 수렴하는 no-op 모두 `requestedCredits`와
`quarantined`를 보존한다. 정상 지급은 요청량 전부와 정확한 잔액 증가를, 격리는
0 지급과 동일한 전후 잔액만 허용한다. receipt proof도 이 두 필드를 비교하며 관리자
UI는 격리를 지급 성공으로 닫지 않고 대사/환불 후속을 표시한다.

Storage upload/삭제는 intent 또는 outbox가 먼저 커밋되는 기존 0078/0079 계약을 따른다.
영구삭제 begin은 exact-payload 영수증을 먼저 확정하고, 그 결과에 0078의 purge job ID를
보존한다. 동일 요청은 물리삭제 완료로 `moderationVersion`이 바뀐 뒤에도 저장된 begin
결과를 재생한다. 완료 job은 더 이상 claim되지 않으므로 retry의 `idle`만 보고 pending으로
판정하지 않고, job+doll이 정확히 결합된 읽기 전용 status RPC가 `completed`일 때만 HTTP
200으로 복구한다. pending/leased 또는 malformed status는 완료로 승격하지 않는다. 다른
요청은 현재 `hidden` 상태와 version을 다시 만족해야 하므로 hidden→restore→hidden ABA를
통과하지 못한다. 이벤트 이미지와 site asset 업로드 자체는 0085 영수증 대상이 아니며,
발행 config/event row가 attach 의도의 권위가 된다.

## 오류 의미

- `idempotency_conflict`: UUID 또는 create intent가 다른 관리자·작업·대상·payload에 이미
  결합됐다. 자동 새 UUID 재시도 금지, 기존 결과와 사용자의 현재 의도를 확인한다.
- `request_aborted`: 복구가 먼저 도착해 해당 전송은 적용되지 않았음이 확정됐다. UI가
  새로운 사용자 의도를 받아 새 request ID로 다시 제출할 수 있다.
- `version_conflict` / `state_conflict`: 다른 작업이 상태를 바꿨다. 최신 행을 다시 읽고
  운영자가 재판단해야 한다.
- `auth_email_not_synchronized`: GoTrue 단계가 아직 완료되지 않았다. DB 계정은 삭제 상태로
  유지되며 같은 operation을 외부 단계부터 재개한다.
- `auth_identity_conflict` / `reactivation_email_changed`: 현재 Auth/identity가 영수증의
  정확한 대상과 다르다. worker는 email을 덮어쓰지 않고 오류를 노출한다. identity와
  `auth.users`가 동시에 어긋난 경우에는 재시도로 회복할 수 없는 이 영구 충돌을 먼저
  반환하고, identity가 그대로인 email 동기화 지연만 `auth_email_not_synchronized`로
  분류한다.
- `stale_lease`: token/version이 바뀌었거나 lease가 만료됐다. 해당 worker는 성공을
  주장할 수 없고 새 claim이 exact 상태를 다시 읽는다.
- `reactivation_in_progress`: 같은 계정에 payload 또는 관리자가 다른 pending saga가 있다.
  관리자 상세에서 복구된 기존 operation의 status/cancel 표면을 사용한다.
- `reactivation_already_completed`: 취소보다 activate finish가 먼저 terminal commit했다.
  이미 활성인 계정을 오래된 취소 intent로 marker화하지 않는다.
- `stale_reactivation_auth_fence`: lease/action/lifecycle가 바뀌었거나 legacy repair보다
  새 탈퇴가 먼저 완료됐다. GoTrue user/identity transaction 전체가 rollback되어야 한다.
- `not_settleable`: PortOne 검증과 별개로 DB 주문이 더 이상 pending/failed 지급 후보가
  아니다. 자동 우회하지 않는다.

## 검증

빈 disposable Supabase에 모든 migration을 번호순으로 적용한 뒤 실행한다.

```bash
npm run test:db
npm run qa:db:admin-mutation-race
npm run qa:db:reactivation-auth-api
```

`admin_mutation_idempotency.pgtap.sql`은 catalog/ACL, exact-payload 충돌, recovery
reordering, event ABA, integrity·moderation 상태 순환, permanent-delete ABA·재생,
terminal 응답 유실 복구, Auth-first 재활성화 activate/cancel
job/lease/generation/Auth-trigger ABA/queue health, rolling legacy repair, counter exhaustion,
정산 단일 지급을 146개 assertion으로
검증한다. race harness는 실제
PostgreSQL 두 세션을 멈춰 세워
다음 12개 interleaving의 lock wait와 최종 행·감사·영수증 cardinality, deadlock counter
불변을 확인한다.

1. 서로 다른 delivery UUID의 동일 event-create intent
2. event POST가 먼저인 receipt recovery
3. 같은 event version의 상충 edit
4. recovery가 먼저인 late event POST
5. 같은 score snapshot의 clear 대 void
6. 같은 moderation snapshot의 dismiss 대 takedown
7. 두 탭의 account reactivation begin
8. activate finish 선착 대 뒤늦은 cancel
9. cancel 선착 대 멈춰 있던 stale activate finish
10. 두 request UUID의 동일 order settlement
11. legacy marker→real 선착 대 새 account withdrawal
12. 새 account withdrawal 선착 대 늦은 legacy marker→real

별도 Auth API harness는 로컬 GoTrue의 실제 Admin `updateUserById`를 사용한다.
email+google 두 identity의 cardinality와 durable identity ID를 고정한 채
marker→exact activate와 exact→marker cancel에서 `auth.users`와 email identity만 함께
수렴하고, google identity 전체와 app/user metadata가 보존되는지 확인한다. activate는
DB finish까지 이어 profile/member/receipt/job/audit/reconsent/fence 최종 상태도 검증한다.
stale token과 exact fence가 있어도 receipt와 다른 제3 실제 email 변경은 trigger 오류 뒤
user/두 identity/app/user-metadata 전부가 원상태인지 검증한다.

테스트는 로컬 Docker Supabase container만 허용하고 네트워크 DSN을 받지 않는다. 실제
fal.ai 생성, 실제 PG 취소·결제, 운영 DB destructive lifecycle, 실기기 동작은 이
자동화 범위에 포함하지 않는다.
