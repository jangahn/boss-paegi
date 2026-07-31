# Boss-paegi 전면 QA 검증 보고서

검증 기준일: 2026-07-31 (Asia/Seoul)

## 합격 기준과 증명 범위

이 보고서의 “전면 검증”은 외부 세계의 무한한 입력을 전부 열거했다는 뜻이 아니다. 유한하게 모델링할 수 있는 입력·상태·전이·경계·오류·재시도·동시성 동치류를 다음 방식으로 닫았다는 뜻이다.

- 작은 유한 도메인은 전수 열거한다.
- 큰 정수/문자열 도메인은 경계값, 동치분할, 불변식, property test로 검증한다.
- 분산 작업은 durable intent/receipt, idempotency key, version CAS, fencing token, DB lock order로 모델링한다.
- 의존성의 resolved error, throw, null, 부분·손상 success를 각각 주입한다.
- 서로 다른 트랜잭션 순서는 실제 PostgreSQL 두 세션으로 양방향 실행한다.
- 브라우저·서버·DB가 서로 다른 버전인 배포 중간 상태도 expand/contract 단계로 별도 검증한다.
- 외부 제공자가 보장하지 않은 동작은 성공으로 가정하지 않고 `pending` 또는 명시적 실패로 보존한다.

하나의 관측 가능한 입력만으로 “응답 유실 재시도”와 “별개의 완전히 동일한 새 요청”을 구분할 수 없는 경우처럼 정보이론적으로 정확한 판별이 불가능한 상태는 임의 추정하지 않는다. 예를 들어 구형 점수 요청에 `submissionId`와 텔레메트리 UUID가 모두 없으면 행을 만들지 않고 `client_upgrade_required`로 fail-closed한다.

## 검증 대상

| 영역 | 검증한 핵심 계약 |
|---|---|
| 인증·OAuth·동의 | 세션/프로필/회원/법무 권위 조회, 익명→회원 이전, callback 재시도, 탈퇴 계정 차단, PII scrub |
| 계정 lifecycle | 가입, 재동의, 탈퇴, 외부 Auth 정리, final Storage sweep, 재활성, reviewer 계정 saga |
| 게임 수학 | 9개 무기/6개 입력 category, 경계 속도, pointer lifecycle, 종료·blur·hidden atomic score fence, 궁극기, resize, 장기 낙서/투사체 자원 상한 |
| 점수·랭킹·뱃지 | 판별 규칙, 제출 exactly-once, report/badge 원자성, ban/void/clear, public visibility |
| 텔레메트리 | 입력 크기·형태·sequence, 익명 binding, 소유권, budget/degrade, 점수 연결 |
| 캐릭터 생성 | 입력 판정, 크레딧 소비/환급, 후보별 FAL submit intent, webhook ACK, terminal CAS, artifact cleanup |
| Storage | signed-upload intent, owner/path/MIME/size, attach, avatar/doll/highlight 삭제 outbox, orphan sweep |
| 신고·모더레이션 | 원자 report, first-pending election, takedown/dismiss/restore, fenced permanent purge |
| 결제·환불·크레딧 | checkout, PortOne 증거 봉투, lot/cache 불변식, 부분환불, reconciliation, 탈퇴 경합 |
| 법무·설정·이벤트 | draft/publish/unpublish/rollback, exact version CAS, operation receipt, 이미지 attach |
| 어드민 | 모든 권위 read의 exact shape/count, mutation idempotency, ABA 방지, 감사원장 |
| 운영 작업 | generation/content/telemetry/reconcile/expire cron의 false-green·pagination·bounded-work 처리 |
| UI·접근성 | modal label/focus/escape, 오류와 빈 상태 구분, retry 표면, 404, stale bundle 호환 |
| HTTP·외부 I/O | 요청 stream 상한, strict UTF-8/JSON, 응답 상한, 인증 fetch redirect 거부, cron secret 비교 |
| 권한 | RLS, table/column/function ACL, default deny, service-role read/write 표면의 exact manifest |

## 자동 검증

정적·단위·계약 검증:

```bash
npm run audit
npm run lint
npm run typecheck
npm test
npm run test:goldens
npm run test:eslint-rule
npm run build
```

현재 source의 Node.js 계약은 major 22다. `.nvmrc`의 `22`,
`package.json`의 `engines.node=22.x`, build보다 먼저 실행되는
`scripts/qa/assert-node-major.mjs`가 로컬·CI·Vercel의 major drift를 차단한다.
2026-07-30 read-only 확인에서 Vercel 프로젝트 설정은 Node 24로 보였으나 package
engine override만으로 배포 완료를 추정하지 않는다. 최종 production build log와
runtime에서 실제 Node 22를 확인한 결과는 배포 후 별도로 기록한다.

빈 disposable Supabase에서 실제 배포 순서 검증:

```bash
npm run qa:db:apply:expand
npm run qa:db:rollout-expand
# 이 harness는 exact expand stage가 아니면 fixture를 만들지 않고 종료한다.
npm run qa:db:checkout-convergence-race
npm run qa:db:apply:contract
npm run qa:db:rollout-contract
npm run qa:db:apply:oauth-expand
npm run qa:db:oauth-expand
npm run test:db:oauth-expand-compat
npm run qa:db:oauth-prune-lock-race
npm run qa:db:apply:oauth-contract
npm run qa:db:oauth-contract
npm run qa:db:analytics-maintenance-raw-guard
npm run qa:db:apply:oauth-post-contract
npm run test:db:analytics-maintenance-bounds
npm run test:db:dead-service-rpc-acl-cleanup
npm run qa:db:analytics-maintenance-acl-upgrade
npm run qa:db:analytics-maintenance-lock-race
npm run test:db
```

`supabase/config.toml`은 전체 contract의 암묵적 자동 적용을 막기 위해
`[db.migrations].enabled=false`로 고정한다. 따라서 `supabase db reset`,
`supabase db push`, `supabase migration up`의 project-migration 0개 성공은
검증 성공이 아니다. 로컬·CI의 유일한 권위 경로는 `supabase start` 뒤 위
payment expand→호환성→contract → OAuth 0093 expand→legacy compatibility
pgTAP→0094 contract→raw 0095 rollback→0095 post-contract custom runner
순서다. 운영은 결제/스토리지
`qa:prod:rollout:*`와 OAuth `qa:prod:oauth:*` 전용 runner만 사용한다.
**OAuth 0093과 0094를 한 번에 적용하거나 0094와 0095를 같은 transaction에
적용하는 명령은 운영에서 금지한다.**
공식 CLI filename 인식·정렬 호환성은
저장소 밖 임시 config에서 migrations만 활성화한 fresh-chain으로 별도 검증한다.
2026-07-30 Supabase CLI 2.107.0 교차검증에서는 그 임시 config의
`db reset --local --debug`가 101개를 적용했고, 문제 구간도
`0087`→`008800`→`008899`→`008900`…`008907`→`0090`…`0092` 순서였으며
`supabase_migrations.schema_migrations` 101행과 seed 1회까지 확인했다. 원본
config의 staged-runner 권위는 바꾸지 않았다.

실제 PostgreSQL 동시성 검증:

```bash
npm run qa:db:race
npm run qa:db:account-child-delete-race
npm run qa:db:anon-reassign-race
npm run qa:db:anon-reassign-write-race
npm run qa:db:score-ban-race
npm run qa:db:report-race
npm run qa:db:legal-race
npm run qa:db:moderation-purge-race
npm run qa:db:consent-delete-race
npm run qa:db:admin-adjust-race
npm run qa:db:admin-mutation-race
npm run qa:db:user-mutation-lock-race
npm run qa:db:fal-submit-race
npm run qa:db:legacy-upload-race
npm run qa:db:checkout-convergence-race
npm run qa:db:public-write-race
npm run qa:db:score-report-quota-race
npm run qa:db:order-observation-race
```

실제 disposable local GoTrue Auth 트랜잭션 검증:

```bash
npm run qa:db:reactivation-auth-api
```

`qa:db:reactivation-auth-api`는 운영 Auth가 아니라 disposable local GoTrue의
실제 Admin `updateUserById`를 호출한다. email+google 두 identity의 cardinality와
stable identity ID를 고정하고, activate marker→exact email은 DB finish까지 이어
profile/member/receipt/job/audit/reconsent/fence의 terminal commit을 확인한다. cancel
exact→marker는 email identity만 함께 수렴하고 google identity와 app/user metadata를
그대로 보존해야 한다. stale fence와 정상 exact fence 바깥의 제3 실제 email 거부는
user·두 identity·app/user metadata를 포함한 GoTrue transaction 전체 rollback을
확인한다.

2026-07-29 fresh-chain 회차의 관측 결과다. 아래 수치는 당시 source snapshot의
역사적 증거이며, 이후 추가된 `008905`~`008907`과 최종 release의 합격을 소급해
의미하지 않는다.

- expand SQL/protocol/ACL 통과, PostgREST service read 25/25
- contract SQL/protocol/ACL 통과, PostgREST service read 25/25
- pgTAP 25파일, 1,388 assertion 전부 통과
- exact expand stage에서 checkout 수렴 6개 race 전부 통과
- contract stage에서 checkout↔탈퇴 race 통과
- 이전 13개 실제 PostgreSQL race harness 안정 회차 전부 통과, 관측 deadlock 0
- 현재 구성(18개 race harness + local GoTrue Auth harness)의 최종 fresh-chain
  결과는 이번 배포 검증 회차에서 아래 종료 조건에 따라 새로 기록한다.
- `npm audit --audit-level=moderate`: 알려진 취약점 0
- 구 앱을 expand DB에 production build한 결과 75개 build-time page artifact 생성 통과
- 신 앱 production build 76개 build-time page artifact 생성 통과
- 구 앱의 텔레메트리 기반 동일 점수 요청 2회가 같은 `scoreId`, DB 점수 1행, stats 1행으로 수렴
- 2026-07-30 이른 운영 read-only rollout preflight에서는 당시 runner 범위인
  `0072`~`008904` 23개 expand 파일이 모두 pending이었다. 이후 현재 source 범위가
  `008905`~`008907`까지 26개로 늘어난 뒤 재실행한 독립 read-only audit에서도
  26개가 모두 pending이고 운영 journal은 기존 `0062`~`0064`만 있음을 확인했다.
  두 관측 모두 checkout exact 503/body/frozen header와 unresolved-intent index를
  확인했을 뿐 운영 migration·배포를 적용하지 않았다.
- 안정 회차와 프로덕션 배포·smoke 결과는 최종 배포 직후 이 문서에 덧붙인다.

2026-07-30 최종 release-v4 source freeze의 새 빈 DB 안정 회차 결과다.

- cleanup 대상 19개 파일의 SHA-256 manifest 19/19가 실행 전후 정확히 일치했고
  freeze hash는
  `3be97b6702044221ba3c298a4d65cbea0d20d32135f390420ed6dd32bea35e04`다.
- expand migration 98개와 contract migration 3개를 실제 순서로 적용했다.
- expand/contract 각각 PostgREST service read 25/25, rollout SQL·protocol·ACL을
  통과했다.
- pgTAP 28파일, 1,453 assertion을 전체 상태 검증과 함께 2회 실행해
  2,906/2,906을 통과했다.
- 18개 실제 PostgreSQL race harness 각각에서 core assertion뿐 아니라 실행
  전후 74개 DB/Auth/Storage 관측 표면이 exact match했고 관측 deadlock은 0이다.
- checkout-delete, admin-adjust, admin-mutation, user-lock 고위험 4종은 같은
  무잔여 조건으로 각각 2회 더 반복해 모두 통과했다.
- 최종 상태는 74/74 baseline exact match이고 `auth.users=0`,
  `auth.identities=0`, `storage.objects=0`, PostgREST HTTP 200이었다.
- 첫 회차에서 드러난 report/quota, admin mutation graph, user financial graph,
  FAL reference ledger 등의 잔여는 제품 결함으로 숨기지 않고 각 race harness
  cleanup 결함으로 분류해 수정했다. 수정 뒤 새 volume에서 전체 chain을 처음부터
  다시 실행한 위 결과만 release 증거로 채택했다.
- Vector sidecar만 로컬 Colima Docker logs API 연결 문제로 health aggregate에서
  격리했다. 실제 DB/Kong/PostgREST는 healthy/HTTP 200이었고 CI는 해당 비제품
  sidecar를 명시적으로 제외한다.

같은 frozen source를 Node.js 22.14.0에서 `npm ci`한 뒤 실행한 최종 소스
게이트는 다음과 같다.

- Node test 182파일, 1,069/1,069 통과
- TypeScript typecheck와 ESLint 통과
- refund golden vector 8/8과 custom ESLint rule self-test 통과
- `npm audit --audit-level=moderate` 취약점 0
- Next.js 16.2.12 production build 통과, static page artifact 77개 생성

릴리스 독립 보안 점검에서 발견한 mutable GitHub Action tag, 임의
`PORTONE_API_BASE_URL`을 통한 인증 헤더 외부 전송 가능성, Node 24에서
`--ignore-scripts`로 lifecycle guard를 우회할 수 있던 경로도 차단했다. CI Action은
검증한 exact commit SHA로 allowlist하고, PortOne API origin은 운영에서
`https://api.portone.io`만 허용한다. 비운영 override도 credential·path·query 없는
loopback HTTP origin만 허용한다. dev/build/start는 lifecycle hook 실행 여부와
무관하게 본문에서 Node 22를 직접 검증하거나 설치된 exact v22 executable로
재실행하며, 빈 PATH나 v24 fallback은 실패한다. hostile URL, workflow pinning,
직접 entry-point, `npm --ignore-scripts` 우회 회귀를 자동 테스트에 포함했다.
독립 재감사에서 선택된 nvm `bin`의 가짜 global `next`가 dev를 false-green으로
가로채는 P2도 실제 fixture로 발견했다. dev 명령을 선택된 Node 22의 `node`가
저장소의 `node_modules/next/dist/bin/next`를 exact path로 실행하도록 수정했다.
real Node 22와 가짜 `next`를 같은 격리 `bin`에 둔 원래 공격을 Node 24에서
`npm --ignore-scripts`로 다시 실행해 실제 Next help가 나오고 가짜 signature는
호출되지 않음을 확인했다. 최종 독립 재감사 결과는 P0/P1/P2 모두 0이고 릴리스
승인이다.

## 게임 입력·점수 lifecycle

게임 회귀는 테스트용 재구현이 아니라 실제 `PlayScene`, 네 입력 클래스, Zustand
`gameStore`, PixiJS와 Matter.js 모듈을 직접 import한다. 9개 무기와 6개 category,
던지기 240px/s 정확 경계와 1600px/s finite cap, 싸대기 500px/s·150ms 경계,
사격 즉시/180ms 경계, pointer identity, `pointerupoutside`, cancel, 같은 category
무기 전환 중 gesture 폐기를 검증한다.

종료와 blur/hidden은 held 입력, fling, 궁극기, pellet/projectile을 먼저 폐기하고
scene producer와 store receiver의 점수 gate를 모두 닫는다. 이미 비행 중인
projectile의 중복 충돌은 최초 1회만 처리하며 종료 뒤 충돌·직접 callback·
`charge=false` 궁극기 hit도 점수/콤보/타격수를 바꿀 수 없다. `resume`은 ended
상태를 열지 못하고 명시적 `start`만 새 판을 연다. delta `0`/`100ms`, 0×0→양수
resize, 상·하·좌·우 projectile 정리, destroy 뒤 listener/timer 해제도 직접
검증한다. 낙서는 입력 샘플당 Graphics 1개, segment당 128점, FIFO 256 segment로
제한하고 4,000회 장기 입력에서도 retained segment/dot 상한을 넘지 않는다.

## 배포 호환성

배포는 bootstrap freeze → exact release SHA/tree 고정 → DB-first expand → 같은
SHA의 `main` fast-forward/Vercel frozen 배포 → provider backfill과 drain →
contract → checkout reopen 순서를 강제한다.

1. 전체 신 앱은 expand DB surface를 먼저 요구하므로 DB보다 먼저 배포하지 않는다.
   현재 운영 코드에 outer checkout gate만 넣은 최소 배포로 먼저 동결한다. anonymous
   `POST /api/pay/checkout`이 exact `503 {"error":"payment_unavailable"}`와
   `X-Boss-Paegi-Payment-Rollout: frozen`을 인증/config/주문 mutation 전에
   반환해야 한다. `creditsEnabled=false`는 reviewer 우회가 있어 freeze 증거가 아니다.
2. 운영 `orders`의 unresolved-intent duplicate가 0임을 증명한 뒤
   `qa:payments:ensure-intent-index`로 partial unique index를 독립
   `CREATE UNIQUE INDEX CONCURRENTLY` 요청에서 선빌드하고 exact valid/ready
   postflight한다. Supabase CLI의 암묵적 migration transaction 안에서는 이
   statement를 실행하지 않는다. active build는 절대 drop하지 않고, 응답 중단으로
   남은 exact-definition invalid index만 progress 부재를 확인한 뒤 독립 concurrent
   drop→duplicate 재검증→rebuild로 수렴시킨다.
3. 최종 release branch를 unchanged `origin/main` 위로 rebase하고 PR CI가 green인
   clean HEAD의 exact commit과 tree를 고정한다. 운영 mutation 직전에 다시 fetch해
   `origin/main`이 rebase 기준에서 움직이지 않았음을 확인한다.
4. 그 exact source에서 `0072`~`0086`에 이어 짧은 DDL인
   `0087_payment_evidence_expand_ddl.sql`, 별도 validation인
   `008800_payment_evidence_expand_validate.sql`,
   `008899_server_read_surface_rollout_gate.sql`,
   `008900_public_write_quotas.sql`,
   `008901_generation_storage_cost_controls.sql`,
   `008902_financial_projection_bounds.sql`,
   `008903_bounded_asset_cleanup_sagas.sql`,
   `008904_privacy_retention_controls.sql`,
   `008905_legal_commerce_generation_compliance.sql`,
   `008906_admin_search_helper_acl.sql`,
   `008907_atomic_active_event_snapshot.sql`을 순서대로 **DB 먼저** 적용한다. 운영
   runner는 `0072`~`008907`의 26개 expand 파일을 한 요청씩 적용하고 각
   transaction의 atomic migration journal receipt를 exact release commit/tree에
   결속해 응답 유실을 복구한다. 연속 receipt prefix가 아니면 중단한다.
5. 구 9-arg RPC, expand-only 12-arg compatibility wrapper, 영구 19-arg RPC, 임시
   DML, PostgREST read, rollout flag와 동일 checkout의 신↔신, 구→신, 신→구 및
   checkout↔설정 양방향 실제 lock wait를 검증한다.
6. expand pending=0 뒤 다시 fetch한다. `origin/main`이 계속 같은 base일 때만 exact
   clean `HEAD`를 `main`에 **fast-forward** push한다. force-push·merge commit·다른
   SHA 대체는 금지하고, PR이 merged로 귀결되며 Vercel 자동 배포가 같은 release
   SHA를 가리키는지 확인한다. `main`이 움직였으면 push하지 않고 additive expand를
   유지한 채 release를 다시 평가한다.
7. 영구 19-arg `create_or_reuse_pending_order` caller를 포함한 신 앱에서도 canonical
   checkout을 exact outer gate로 frozen 상태로 유지한다. 그 exact release
   commit/tree에서 read-only `qa:prod:rollout:app-postflight`를 실행해
   checkout·FAL·doll의 동일 production project/commit frozen identity,
   migration/source/manifest hash receipt를 재검증하고, 별도 production build
   log와 runtime 증거로 실제 Node 22도 확인한다.
8. frozen deployment에서 발견한 Store ID와 구성된 live/test channel key subset을
   로컬 runtime secret과 교차검증하고, 기존 PortOne 주문을 fresh provider 조회로
   dry-run한 뒤 exact evidence backfill한다. 구성되지 않은 mode/channel이 provider
   inventory에 등장하면 blocker다. production wrapper는 clean source commit을
   권위로 삼아 bundle 추출 전·후와 backfill 종료 뒤 동일 project/commit의
   checkout·FAL·doll frozen identity를 재검증한다.
9. partial/all-NULL evidence와 duplicate intent를 0으로 만들고, production alias
   전환 뒤 route 최대 실행시간 이상 기다린다. background worker,
   `account_reactivation_legacy_repairs`, active profile/Auth email mismatch를
   drain한다. 장기 생존 구 브라우저는 전수 열거를 가정하지 않고 신 route strict
   input과 contract의 구 RPC/DML 회수로 fail-closed한다.
10. `0090_payment_evidence_contract_constraint.sql` →
   `0091_payment_evidence_contract_validate.sql` →
   `0092_rollout_contract_cleanup.sql` 순서로 required evidence CHECK를 확정하고
   임시 backfill/DML·구 9-arg RPC·expand-only 12-arg wrapper·구 브라우저 직접
   DELETE·rollout flag를 회수해 영구 19-arg checkout surface만 남긴다.
11. contract runner가 pending=0이고 contract probe가 통과한 뒤에만
   `PAYMENT_CHECKOUT_ENABLED=1`로 같은 신 앱을 redeploy해 checkout을 연다. reviewer
   test checkout과 최종 smoke를 반복한다.

`0071`은 이미 운영에 적용된 Storage ACL 선행 변경이다. 나머지 마이그레이션은 위
순서를 깨지 않고 적용한다. 과거 `0012a`/`0012b` suffix 파일은 공식 Supabase
filename 규칙에서 유효하지 않으므로 각각 고유 숫자 버전
`001200_score_highlights.sql`/`001201_drop_score_highlight_cols.sql`로 교체했다.
두 파일은 기존 의미대로 `0013`보다 먼저 적용하며 suffix 이름을 다시 만들지 않는다.

checkout convergence harness는 `0090`~`0092` 적용 뒤 실행하는 contract 테스트가
아니다. 구 9-arg exact replay, frozen 구 앱을 위한 expand-only 12-arg
frozen-receipt reuse, 영구 19-arg 주문+청약철회 evidence 수렴이 동시에 존재하는
expand 경계를 검증한다. harness는 rollout flag와 세 RPC surface의 ACL을 fixture
생성 전에 exact 비교하고 expand가 아니면 종료 코드 2와 재구축 명령을 반환한다.
contract 검증은 `qa:db:rollout-contract`, pgTAP, 나머지 PostgreSQL race harness가
담당한다.

### OAuth 0093/0094 staged rollout과 0095 post-contract

OAuth flow ledger는 기존 `0090`~`0092` contract와 별개의 두 번째
expand/contract 경계다. `0093_oauth_flow_intents.sql`은 새 flow-scoped
`consume_oauth_flow_intent_migration`, pre-ledger cookie를 exact target
session·TTL·append-only receipt에 묶는
`consume_legacy_signup_migration`, generation-fenced 익명 Auth cleanup
queue를 추가하면서 구 앱의 raw
`reassign_anon_data` `service_role EXECUTE`도 유지한다. CI는 0093만 적용한
상태에서 stage verifier와 legacy `score_submission_integrity.pgtap.sql`을 실행해
이 호환 창을 실제로 검증한다. 별도 2-session harness는 eligible terminal row의
flow advisory lock을 한 세션이 보유할 때 prune이 삭제 성공을 가장하지 않고
`terminalRetentionBacklog=1`을 반환하며, lock release 뒤
`prunedTerminal=1`·backlog 0으로 수렴하는지도 증명한다. 이후에만
`0094_oauth_flow_migration_contract.sql`을
단독 적용하고, stage verifier와 전체 pgTAP으로 raw와 legacy bridge 실행권이
service_role/anon/authenticated/PUBLIC 모두에서 회수됐는지 확인한다.
stage verifier와 production runner는 flow, cleanup, reassignment winner,
quarantine-highlight marker, score-owner/session-ID tombstone, legacy receipt,
provider qualification의 여덟 critical private relation과 25개 service-only
scoped RPC exact inventory, 별도 legacy bridge 단일 signature·ACL·contract
comment를 함께 검사한다. row-level append-only/delete-capture trigger뿐 아니라
여덟 relation 모두의 owner-only `BEFORE TRUNCATE FOR EACH STATEMENT` guard와
전체 21개 trigger inventory도 exact relation·function·tgtype으로 고정하므로,
owner 실수로 receipt·marker·session reuse fence를 일괄 지운 상태나 일부
surface가 빠진 0093/0094를 정상 stage로 오판하지 않는다.

운영 runner도 `expand`, read-only `app-postflight`, `contract`,
`post-contract` 중 한 stage만 받는다. exact production project, clean source commit/tree, immutable historical
migration blob/manifest, Git ancestry, 원자 journal receipt를 확인하고 0093
receipt가 없으면 contract SQL을 보내지 않는다. Vercel API는 canonical alias가
exact GitHub `main` SHA의 immutable production `READY/PROMOTED` deployment를
가리키는지 직접 증명한다. 제거된 `gitSource` 대신 exact `gitRepo`
repo/owner ID·path·default branch와 Git metadata를 검증하고 GitHub API의 현재
`main` branch SHA를 별도로 조회해 다른 branch·CLI 배포를 차단한다. canonical
alias와 immutable URL 각각에서 OAuth status route를 세 번, frozen
checkout·FAL·doll을 모두 probe하며 exact Supabase/build/
Vercel deployment identity headers가 하나라도 다르면 실패한다.
같은 immutable deployment의 `config.functionTimeout=300`도 evidence hash와
append-only DB qualification에 저장해 1505초 계산이 mutable provider 기본값에
의존하지 않게 한다.

release branch는 unchanged `origin/main`의 후손인 clean HEAD로 CI를 끝낸 뒤 그
exact source에서 0093을 먼저 적용하고, base 불변이면 동일 `HEAD:main`을 force
없이 fast-forward push한다. 이후 main drift가 있으면 0093 receipt commit을
조상으로 보존하는 merge fix-forward만 허용하고, rebase/cherry-pick/squash로 그
조상을 제거하거나 0093 bytes를 수정하면 차단한다. alias-current 뒤에는 legacy
구 issuer invocation timeout 300초 + cookie TTL 900초 + expiry 직전 검증한
consumer invocation timeout 300초 + clock margin 5초인
**1505초(25분 5초)**를 drain한다. runner는
`0093 applied_at < Git deployment/Ready/alias-current <
alias-current+1505초 ≤ qualification ≤ 0094 applied_at`을 검증하고, contract
직전·직후 provider/route 증거가 같은지도 재확인한다. qualification과 0094
journal은 한 transaction에 기록된다. 0094 원본 SQL의 intrinsic assert 때문에
raw SQL, `db push`, `migration up`도 qualification 없이 rollback한다. 한 migration
range나 Management API 요청에 0093+0094를 함께 넣는 것은
금지한다.

0094 contract 검증 뒤에는 원본
`0095_analytics_maintenance_argument_bounds.sql`의 unconditional raw guard가
함수/ACL/journal을 하나도 바꾸지 않고 rollback하는지 먼저 증명한다. 운영
`post-contract` runner만 marker+exact guard를 OAuth catalog transaction lock과
contract fingerprint assertion으로 교체한다. 0095 함수 body/default/security/
search_path/owner/exact service-only ACL fingerprint, OAuth catalog pre/post
fingerprint, 0095 source/manifest/lineage receipt가 0094보다 늦은 별도
transaction에서 모두 일치할 때만 성공이다. raw-applied 함수만 있거나 receipt만
있는 상태는 실제 적용 commit을 위조하는 사후 repair 없이 mismatch로 차단한다.
같은 migration에 접힌 six superseded service RPC의 exact signature와 zero
non-owner EXECUTE도 snapshot이 확인하며, 별도 16-assertion pgTAP이
service_role/anon/authenticated/PUBLIC·임의 역할 grant 제거를 고정한다.
0095 적용 전·직후까지 checkout/FAL/doll frozen identity를 유지한다. 완료 재진입은
비용 기능 재개를 허용하면서도 current Vercel canonical/immutable attestation과
두 origin의 OAuth status 400/no-store/Supabase·build·deployment identity
headers를 검증해 구 앱 rollback을 차단한다. 상세 명령과 중단/복구 조건은
`docs/oauth-flow-rollout.md`가 정본이다.

`prune_oauth_flow_intents`는 exact 11-key ACK만 성공이다:
`expiredPending`, `boundRecoveryConverged`, `prunedTerminal`,
`targetAuthorityLossConverged`, `targetAuthorityLossBacklog`,
`pendingExpiryBacklog`, `terminalRetentionBacklog`,
`unconsumedMigrationBacklog`, `unreleasedContinueBacklog`,
`unboundClaimBacklog`, `boundRecoveryBacklog`.
추가/누락/비정수/음수는 system error이고, 일곱
backlog 필드 중 하나라도 양수면 `content-maintain`은 200
false-green이 아니라 429를 반환한다. terminal retention의 advisory-lock 경합도
실제 남은 eligible row count로 노출한다. phase별 lock skip은 `p_limit`을
소비하지 않아 잠긴 선두가 뒤의 eligible row를 굶기지 않는다. unbound claim은
signed lease 경계에서 자동 expire하고, bound claim/sign-out은 원래 lease와
target-session 생성시각 양쪽보다 5분이 지난 뒤 exact session revoke 또는 부재
증명으로 종결한다. 완료됐지만 release 전인 continue와 35일을 넘긴 미소비
migration receipt는 retention 삭제 대상으로 강등하지 않고 운영 backlog로
보존한다.

익명 Auth 삭제는 외부 side effect이므로 재할당 성공과 한 번의 삭제 응답을
atomic success로 추정하지 않는다. `begin_oauth_flow_intent`가 원본
`auth.users.created_at+instance_id`를 dormant receipt에 보존하고,
`consume_oauth_flow_intent_migration`이 데이터 재할당·migration receipt·cleanup
arm을 한 transaction에서 커밋한다. worker는 fresh Admin Auth read와 lease-scoped
DB 검증 전후에만 삭제를 시도하고, delete throw/응답 유실 뒤에도 다시 읽은
`user_not_found`와 DB 부재가 모두 맞아야 `completed`다. UUID가 다른 세대로
재사용됐거나 비익명으로 승격됐으면 `protected`로 끝내고 삭제하지 않으며,
pending/leased 중에는 Auth INSERT/UPDATE trigger가 그 재사용 자체를 차단한다.
target session discovery는 query/body가 벗겨진 두 번째 `/consent` 탭도
released+unconsumed anonymous flow에 다시 결속한다. target session 회전·소실은
terminal 사유가 아니며, release 뒤 원래 session 부재가 24시간 지속되면 source
profile을 generic shell로 바꾸고 highlight를 숨기며 source session을 revoke한
quarantine으로 전이한다. 동일 target principal의 현재 live session은 flow
expiry + 30일 + 5초인 exact deadline까지 recovery/consume할 수 있다. strict
deadline 경과 또는 target profile 탈퇴·부재 시 score/Auth/profile shell은
비식별 보존하고 badge·highlight·telemetry·source session은 제거·비식별화한
`scrubbed`로 수렴한다.

기존 target member와 target 선점은 닫힌 exact no-transfer receipt 뒤 source를
즉시 quarantine하고 같은 recovery/scrub deadline으로 보낸다. source 비익명
승격·회원화, 금지 source 데이터, source Auth 세대 변경은 별도 principal을
보존하면서 cleanup을 `blocked/migration_blocked`로 남기고 privacy cron을
non-green으로 만든다. source 이미 다른 target으로 이전됐거나 이미 사라진
경우만 exact receipt 뒤 `completed`다. 미증명 reason·RPC/receipt 오류는 member
mutation 전에 fail-closed한다. pgTAP은 모든 닫힌 skip reason, query-stripping
discovery, quarantine recovery/scrub, 멱등 replay를 검증하고 실제 2-session
harness는 target member INSERT와 finalize/consume의 lock wait 및 no-transfer
수렴을 검증한다.

flow authority가 없는 pre-ledger 3-part cookie는 신 앱이 raw RPC를 직접 호출하지
않고 expand-only legacy bridge로 보낸다. bridge는 exact target Auth session,
`issued_at + 15분 = expires_at`, DB clock의 5초 future margin, source/target
단일 winner를 잠금 아래 재검증하고 transfer 또는 exact no-transfer 결과를
append-only receipt에 남긴다. 응답 유실 재시도는 같은 target/session에만 exact
ACK를 재생하며, 다른 target은 충돌한다. 구 배포의 raw RPC 재시도도 영구
source UUID tombstone과 winner receipt에 의해 같은 네 count ACK로 수렴한다.
0094는 1505초 drain 뒤 raw와 bridge 실행권을 함께 회수한다.
모호한 결과는 최대 1시간 exponential backoff로 남고, due lease가 없는 다음
cron도 claim idle ACK의 authoritative `pendingBacklog`를 보존해 429를 유지한다.
Node fault injection은 resolved delete error, throw-after-commit, malformed/missing
Auth read, Admin/DB divergence, finish 응답 유실, stale/future retry backlog를
분리하며, `oauth_anon_auth_cleanup.pgtap.sql`은 transaction arm, exact generation,
lease token/version, UUID reuse/promotion trigger, 재시도, fresh absence,
protected terminal, 35일 retention을 rollback-only DB에서 검증한다.
`attempt_count`/`lease_version`은 int4 최댓값 `2147483647`에서 wrap하지 않는다.
마지막 representable 실패 또는 crash 뒤 만료된 마지막 lease는
`protected/cleanup_attempt_limit_exhausted`로 안전 정지하고
`oauthAnonAuthCleanupFailed`와 service-only exact 6-key privacy status의
`failures`에 노출되어 503/non-green이 된다.

old JWT는 현재 `auth.sessions`의 exact session/user/created-at 세대가 살아 있을
때만 public RLS와 server read를 통과한다. flow/cleanup 삭제 때 session-ID를 영구
tombstone하고 Auth trigger가 같은 UUID의 session 재사용을 거부한다. 공개
leaderboard와 doll/share OG는 application/Vercel의 stale PII 재노출을 막도록
`force-dynamic`, `private, no-store`, CDN별 `no-store`를 사용한다. 외부
플랫폼이 이미 저장한 OG 사본은 서비스 권한 밖이므로 플랫폼별 cache purge가
별도 운영 경계다.

2026-07-31에는 별도 disposable DB를 새로 만들고 전체 migration chain을 적용한
뒤 0093 직후 expand catalog=`ready`, local qualification을 넣은 0094 직후
contract catalog=`ready`를 각각 확인했다. 이 격리 상태에서
`oauth_flow_intents.pgtap.sql` 362/362,
`oauth_anon_auth_cleanup.pgtap.sql` 71/71을 통과했다. relation fingerprint
inventory는 13개 relation 전부 일치(13/13)했고, 별도의 14개 tamper case는 모두
expected rejection으로 통과(14/14)했다. 이는 `13/14` 성공률이나 한 건 실패라는
뜻이 아니다.

같은 DB에서 terminal-prune locked-head starvation race와 target-member
finalize→release/consume 양방향 실제 PostgreSQL session 경합도 통과했다. race
harness는 영구 session-ID tombstone을 삭제하거나 재사용하지 않고 매 실행 새
UUID를 사용한다. old/no/missing/deleted/other/tombstoned/malformed session의 RLS
read는 모두 0행, exact live own-session만 허용되며 session tombstone append-only와
UUID reuse 거부도 통과했다. 관련 focused Node 회귀는 7파일 87/87이었다. 이
검증에서는 fal.ai 실제 생성·과금 요청을 수행하지 않았다.

2026-07-31 오후 세션이 중단된 뒤 인수 재검증에서 release 후보 소스를 다시
전체 게이트에 통과시켰고, 이 과정에서 결함 2건을 발견해 같은 release에
수정했다. ① `test-analytics-maintenance-acl-upgrade.sh`가 package script와
CI에 배선되지 않아 harness-coverage 인벤토리 테스트가 실패했다 —
`qa:db:analytics-maintenance-acl-upgrade`로 배선하고 CI의 dead-service RPC
검증 직후 단계로 추가했다. ② `lib/supabase/client.ts`가 module 평가 시점에
`PUBLIC_ENV.SUPABASE_URL`을 `new URL`로 파싱해(storage key 파생과
`createAuthTransportFetch` scope 초기화 2곳) env 없는 CI production build가
`/_not-found`·`/badges` prerender에서 `ERR_INVALID_URL`로 실패했다 — storage
key·code-verifier·SDK lock 이름과 auth transport scope를 첫 사용 시점의
memoized lazy 파생으로 전환했다. globalThis 유지 singleton 의미는 그대로이며,
env가 없는 실제 사용은 여전히 fail-closed로 throw한다. 소스 형태를 고정하는
테스트 4파일을 같은 형태로 동기화했다. 재검증 결과: 새 빈 disposable DB
fresh chain 43단계(expand 98 → contract 3 → 0093→0094→0095 staged 순서와
신규 ACL-upgrade 단계 포함) 전부 통과, pgTAP 32파일 1,953 assertion 통과,
실제 2-session race harness 전부 통과, env 없는 CI-mirror production build
static page 89/89 생성 통과.

구 서버에서 signed-upload token을 받은 뒤 새 서버에서 finalize하는 in-flight
요청도 별도 계약으로 검증한다. avatar·highlight·event image·site asset은 새
서버가 인증 주체, canonical path, 실제 object size/MIME, token 수명을 먼저
확인한 뒤 exact `upload_intent_forbidden`에만 legacy intent 생성을 시도한다.
생성 ACK와 2차 confirm ACK가 모두 정확해야 하며, 생성 응답 유실·동시 채택·
재시도는 수렴하고 다른 owner/subject/purpose가 점유한 경로는 fail-closed한다.
intent 생성 자체가 DB 장애로 커밋되지 않은 뒤 사용자가 재시도를 포기하는
경우에는 요청 프로세스만으로 영속 증거를 남길 수 없다. 이를 위해 0079가
expand 시각을 기록하고 `0092`가 old-request drain 뒤 기존 token 수명만큼의
유한 inventory window를 연다. 2시간15분 이상 지난 canonical object 중
window 안·무intent인 것만 scanner가 경로 advisory lock 아래 검사한다.
reference가 먼저면 protection ledger, scanner가 먼저면 기존 fenced pending
receipt로 수렴해 후속 attach를 거부한다. 실제 두 PostgreSQL 세션에서
reference→scanner와 scanner→reference 양방향 lock wait를 실행한다.

결제 checkout은 앱의 분리된 pending 조회를 권위로 쓰지 않는다. 시간 또는 상품별
재사용 window도 없다. PortOne 주문이 `pending` 또는 `failed`이고
`paid_at`/`canceled_at`이 모두 null이면 동일 payment ID로 나중에 PAID가 될 수 있는
사용자 전역 미해결 intent다. partial unique index가 이 집합을 사용자당 최대 1행으로
강제한다.

영구 19-arg `create_or_reuse_pending_order`는 12개 주문 인자에 stable checkout
request UUID, 상품명, 표시 증거 UUID/hash, 청약철회 문구 version·exact copy·적극
확인을 더한다. private 12-arg core가 candidate order object, `growth_levers`
config, member user 순서의 advisory boundary 안에서 active 요청을 검증한 뒤, 같은
transaction에서 `checkout_withdrawal_acceptance_evidence`를 주문에 결속한다. 같은
payment ID는 exact replay한다. 새 payment ID이지만 상품·test-mode·pay channel이
같으면 config나 배포 env가 달라졌어도 기존 주문의 amount·credits와
`expected_store_id`/`expected_currency`/`expected_channel_key`가 든 불변 영수증을
그대로 reuse한다. 다른 상품·mode·channel은 `checkout_prior_intent_unresolved`,
두 후보는 `checkout_reuse_ambiguous`로 실패한다. route는 주문·표시·청약철회
evidence를 모두 재조회하기 전에는 PortOne 파라미터를 반환하지 않는다.

공개 12-arg overload는 frozen 구 앱을 위한 expand-only compatibility wrapper다.
신 앱은 이를 호출하지 않으며 production checkout은 expand 전체에서 outer gate로
닫혀 있다. `0092`는 이 wrapper와 private core 실행권을 회수하고 영구 19-arg
signature만 남긴다.

`008905`는 `generation_provider_acceptance_evidence`와 그 status/record/bounded
prune RPC도 구현한다. 이 증거는 사용자, 탈퇴 세대(`withdrawal_generation`), 현재
효력 있는 서비스 terms/privacy version, fal bundle version, 별도 만 19세 확인과
fal Terms/AUP 각각의 적극 동의를 불변 결속하고 5년 보존한다. 관련 UI/API와 DB
경계가 source에 구현됐으므로 생성 연령/flow-down은 더 이상 법무 v2의 코드
publication blocker가 아니다. 다만 `FAL_EXTERNAL_COMPLIANCE_APPROVED=false`인
compile-time fence는 유지한다. fal의 exact 하위처리자·국가·보존기간, 얼굴/PII
서면 허용·DPA, private ACL/owner-token 계약과 Vercel·Google OAuth의 exact 국외
이전 inventory라는 외부 증거가 모두 해소되기 전에는 fal 생성과 법무 v2 발행을
성공으로 판정하지 않는다.

expand 동안 구 9-arg `create_pending_order`는 미해결 후보가 0이면
`checkout_upgrade_required`, 정확히 같은 payment ID의 pending transport replay만
성공, 다른 ID이면 `checkout_reuse_required`다. 신규 all-NULL evidence 주문은 만들지
않는다. all-NULL 레거시 증거 행은 호환 지급 대상이 아니다. webhook·order-status·
reconcile·관리자 settle을 포함한 모든 지급 경로가 `payment_evidence_incomplete`로
fail-closed하며 크레딧을 주지 않는다. fresh PortOne 조회가 order UUID에서 파생한
payment ID, 금액, test-mode, 로컬 `pay_channel`과 provider의 store/currency/channel
key를 exact 입증한 경우에만 expand-only RPC로 한 번 backfill한다. 로컬
`pay_channel=null`도 임의로 고치지 않고 exact row identity로 보존한다. `0090`은
미backfill 행이 하나라도 남으면 contract를 거부하고, `0091`이 required CHECK를
검증하며, `0092`가 backfill, 구 9-arg RPC, expand-only 12-arg wrapper를 제거한다.

PAID 상태도 지급 성공과 동일시하지 않는다. 금융 RPC가 탈퇴자·취소 의도 후 PAID·
organic late PAID를 무지급 quarantine으로 흡수하면 `error_message`가 남는다.
order-status는 정상 지급만 `paid`, marker가 있는 PAID는 `paid_review`로 반환한다.
따라서 완료 화면은 생성권 충전을 주장하거나 잔액 refresh를 발생시키지 않고 결제
내역의 운영 확인으로 안내한다. 결제내역 read 계약도 `error_message`를 필수로 보존하고
알려진/향후 모든 non-null marker를 `지급검토`와 “요청 N개 · 지급 검토 중”으로
표시해 구매량을 실제 지급량처럼 표현하지 않는다. 관리자 전체 주문·대시보드 경고·
회원별 주문 read도 exact row enrichment로 marker를 보존하고, 주문 표는
`paid_review`와 `지급 0 · 요청 N`으로 렌더한다. reconcile 역시 이 분기를 `manualReview`로 집계하고
`granted`를 증가시키지 않는다. durable 대사 이슈가 원자 생성되더라도 운영 후속은
미완료다. reconcile은 매 실행 open `reconciliation_issues` exact count를 다시 읽고,
하나라도 남아 있는 동안 HTTP `429 + Retry-After: 60`/`ok:false`와 failure heartbeat를 유지한다. count
오류·null·비정수는 0으로 축소하지 않고 503이며, 새 manual review 직후 open issue가
0인 모순도 system error다.
알려진 세 marker와 알 수 없는 향후 marker를 모두 같은 fail-closed 분기로 검증한다.

관리자 verified settlement도 동일한 postcondition을 보존한다. SQL 신규 결과,
exact request replay, 다른 request UUID가 기존 정산 ledger에 수렴하는 no-op 결과는
모두 `requestedCredits`와 `quarantined`를 반환한다. 런타임 parser는
`quarantined:false`일 때 `credits=requestedCredits=after-before>0`,
`quarantined:true`일 때 `credits=0`과 `after=before`만 허용하며 receipt proof도 두
필드를 비교한다. UI는 격리 결과를 지급 성공으로 닫지 않고 0개 지급과 대사/환불 후속을
명시한다. pgTAP은 취소 의도 뒤 PAID 정산의 신규·동일 request replay·다른 request
ledger replay가 모두 무지급으로 수렴하는지 검증한다.

공개 콘텐츠 신고는 브라우저가 dialog 수명 동안 stable `submissionId`를
재사용하고 DB가 그 ID를 exact payload receipt에 결속한다. 응답 유실·동시
재전송은 신고 1행과 first-pending 알림 1회로 수렴하며, 같은 ID의 다른 payload는
충돌한다. submission identity가 없는 구 bundle은 서로 다른 신고와 재시도를
정확히 구분할 수 없으므로 임의 dedup하지 않고 새로고침이 필요한 409로
fail-closed한다.

## 운영 배치 완료성

운영 cron의 200은 단순히 “함수가 예외 없이 끝남”이 아니라 해당 실행이 확인한
권위 작업 집합이 비었다는 증거다.

- `reconcile`은 미해결 주문과 refund `pending`/`blocked`/`outstanding`을
  retry pending으로, 항목 예외·권위 의존성 실패를 system error로 집계한다.
  주문 또는 refund 조회가 정확히 배치 상한에 닿아 뒤 작업의 부재를 증명하지
  못한 경우도 `429 + Retry-After: 60`이다. 200일 때만 success heartbeat를 기록하며, 취소 관측이
  만든 reconciliation issue 수를 0으로 덮어쓰지 않는다.
- `credit-expire`는 공통 20초 soft deadline에 닿아 `done:false`이면
  `429 + Retry-After: 60`과
  `time_budget_backlog` failure heartbeat를 반환한다. 빈 큐까지 확인한
  `done:true`만 200이다.
- `gen-recover`의 4시간 회수 window와 stale queued scan은 정렬된
  `(created_at,id)` keyset을 사용한다. 첫 페이지의 행이 동시 완료·실패로
  predicate에서 빠져도 다음 페이지는 마지막 key 다음부터 시작하므로 offset
  축소에 따른 영구 누락이 없다. 새 실행 시작 이후 생성된 행은 고정된 상한 밖에
  두어 현재 scan을 무한히 늘리지 않고 다음 주기가 처리한다.

현재 8개 ops route는 공통 20초 monotonic soft deadline, 25초 Vercel
`maxDuration`, 외부 scheduler 90초 request timeout을 쓴다. 회귀 검증은 정상
empty=200, 정확한 batch/time-budget 경계=`429 + Retry-After: 60`, resolved
error·throw·손상 응답=503, timeout이 abort-aware work보다 먼저 결과를 소유하는
race와 2,000행 scan 중 앞 500행 predicate 이탈을 포함한다. cron-job.org가
success로 취급하는 207은 사용하지 않는다. route 목록은 상수로 복제하지 않고
`app/api/ops/**/route.ts`에서 동적으로 산출하므로 새 route도 공통 auth, deadline,
retry header와 207 금지 gate에 자동 편입된다.

2026-07-30 운영 read-only cron inventory에서는 `privacy-maintain`을 제외한 기존
7개 route의 외부 잡이 등록·활성 상태였다. `telemetry-maintain`과
`analytics-maintain`은 각각 KST 09:00 일 1회, `gen-recover`는 5분 주기다.
`privacy-maintain`은 아직 미등록이므로 `008904`·`008905`와 같은 release 앱을
배포한 뒤 POST 방식으로 등록하고, 연속 두 성공 사이 26시간 이내와 queue drain
HTTP 200을 실제 이력으로 확인하기 전에는 운영 cron 완료로 판정하지 않는다.

유지보수 RPC의 정수 인자도 파괴적 작업의 권한 경계로 검증한다.
`telemetry_rollup_days`는 1..31, `maintain_analytics_rollups`는 1..91,
`prune_analytics_events`는 1..90만 허용한다. 31/91은 각각 오늘을 포함한 raw
30/90일 전체 재집계 범위이고, 보존 90일은 공개된 개인정보 정책의 상한이다.
NULL·`INT_MIN`·음수·0·상한+1·`INT_MAX`는 advisory lock, 날짜 산술, delete보다
먼저 SQLSTATE `22023`으로 실패하며 기존 rollup/raw 행을 한 건도 바꾸지 않는다.
`analytics_maintenance_bounds.pgtap.sql`은 양쪽 유효 경계, 기본값 3/7/90,
KST cutoff 포함/제외, 상한 loop의 정확한 날짜 수와 비어 있지 않은 집계의
기존 의미 보존, 사전 임의 역할 EXECUTE grant 제거와 exact service-only ACL까지
50개 assertion으로 고정한다. telemetry rebuild는 전용 transaction advisory
lock, analytics rebuild와 raw prune은 공유 lock을 validation 직후 DML 전에
획득한다. 실제 2-session harness는 각 동일/교차 호출이 lock을 기다린 뒤
성공하고 rollup/raw 결과를 손상시키지 않는지 검증한다.
`dead_service_rpc_acl_cleanup.pgtap.sql`은 더 이상 직접 호출되지 않는 admin,
legal, generation 내부 primitive 여섯 개가 owner-only인지 16개 assertion으로
별도 검증한다.

## 관리자 page 권한 경계

Next.js layout과 page는 병렬 렌더될 수 있으므로 layout gate만 privileged read의
선행조건으로 간주하지 않는다. 모든 `app/admin/**/page.tsx`는 첫 async 작업으로
`requireAdmin()`을 실행하고 실패를 처리한 뒤 service-role client나 DAL read를
시작한다. layout과 page의 중복 호출은 React `cache`의 동일 render-pass memoization으로
한 authority read에 수렴한다. `__tests__/admin/page-auth-boundary.test.ts`는 admin
page inventory 전체와 gate→denial→후속 async/service-role read 순서를 정적으로 고정한다.

## HTTP·외부 응답 경계

모든 API route는 편의 body reader를 직접 쓰지 않는다. source inventory 테스트가
현재 deployable 페이지 exact 56개와 API route exact 58개를 manifest로 고정한다.
모든 API는 명시적 HTTP method를 export하고 임시 local-QA route/payload가 없어야 한다.
또한 58개 route의 `request/req.json()`, `text()`, `arrayBuffer()`,
`blob()`, `formData()` 직접 호출 0개를 함께 고정한다.

| 표면 | wire 상한과 판정 |
|---|---|
| 공개·회원 JSON | 64KiB, strict UTF-8 JSON object만 허용 |
| 관리자 JSON | 기본 64KiB, 설정·이벤트·법무 문서는 1MiB |
| 신고 / 점수 / 텔레메트리 | 각각 32KiB / 64KiB / 64KiB |
| 분석 track | 4KiB, invalid·oversize는 무PII 204 drop |
| 생성 multipart | 이미지 10MiB + multipart overhead 64KiB를 stream에서 먼저 제한 |
| PortOne / FAL webhook | 각각 64KiB strict UTF-8 raw text / 512KiB raw bytes |

`Content-Length`가 있으면 canonical non-negative decimal과 상한을 body read 전에
검사하고, 없거나 거짓인 경우도 stream 누적 바이트에서 같은 상한을 다시 적용한다.
청크·UTF-8 경계, 길이보다 큰 실제 body, stream throw/cancel, 배열·scalar·null JSON을
fault injection으로 검증한다. 인증/권한 검사를 먼저 해야 하는 관리자 route는
unauthenticated peer가 body buffer 예산을 쓰지 못한 뒤에 parser를 호출한다.

공개 쓰기인 telemetry/track/score/report와 `008901`의 doll signed URL은
`008900_public_write_quotas.sql`의
DB-authoritative global→actor row lock 순서와 원자 quota RPC를 추가로 통과한다.
telemetry는 actor/global 요청 1,000/50,000, 신규 세션 30/2,000, 세션 write 400,
track은 actor/global 200/2,000, score는 owner/network/global 100/300/5,000,
report는 network/global 20/500, signed URL은 actor/global 1,000/10,000 units가
exact KST 일일 상한이다. Vercel이
`X-Forwarded-For`를 spoof 방지를 위해 overwrite하고 동일 client IP alias를
제공한다는 [공식 request-header 계약](https://vercel.com/docs/headers/request-headers)을
근거로 DB에서 회원임이 확인된 telemetry/conversion만 Auth UUID를 사용하고,
track·score·report·signed URL·익명 telemetry는 edge IP를 메모리에서만
HMAC-SHA-256한다. 원본 UUID/IP는 저장·로그하지 않는다.

HMAC actor는 `analytics_events`의 무식별 데이터와 결합되지 않는 별도
pseudonymous abuse-control counter다. `(day_kst, endpoint, actor_key)` retention
index와 opaque score/report attempt의 day-leading index 아래 공개 요청당 256행
opportunistic quota prune과 일일 cron 80,000행 필수 batch(최대 2회)를 함께
사용한다. quota bucket 72,505행과 accepted score/report attempt 5,500행을 합친
exact 일일 최대 78,005행보다 첫 batch가 크고 호출당 catch-up capacity는
160,000행이다. `done:false`는 503 backlog로 노출되어 public traffic이
0이어도 current+직전 2개 KST 날짜 보존 목표의 미수렴을 green으로 숨기지 않는다.
개인정보처리방침의 단기 security identifier 문구 검토·발행은 법무 후속이며 QA가
운영 법무 config를 변경하지 않는다. 상세 근거와 상한 산식은
[`docs/public-write-quotas.md`](public-write-quotas.md)다.

`public_write_quotas.pgtap.sql`은 RLS/ACL, raw identifier column 부재,
day-leading exact index, 상한 ±1, legacy wrapper, scheduled prune
`done:false→true`를 검증한다. `test-public-write-quota-races.sh`는 독립 DB
연결로 같은 absent telemetry session, global 신규 세션 마지막 한 개,
track global/actor 마지막 한 개와 lock timeout을 실제 충돌시킨다.
`public_score_report_quotas.pgtap.sql`과
`test-public-score-report-quota-races.sh`는 별도 pre-core reservation,
마지막 global slot, 성공 receipt replay, invalid score/unauthorized doll/
missing report target의 terminal failure exact replay, payload conflict와
concurrent `quota_busy`가 추가 quota/core 실행 없이 수렴하는지 검증한다.

외부 응답도 PortOne 256KiB, FAL queue ACK 16KiB, FAL billing/JWKS 64KiB,
OG doll image 2MiB 상한을 넘으면 정상 success로 축소하지 않는다. PortOne API,
FAL queue/JWKS/billing처럼 credential이 붙는 fetch와 OG media fetch는
`redirect:"error"`로 다른 origin에 secret 또는 signed URL을 전달하지 않는다.
현재 8개 ops route의 `x-cron-secret`은 4KiB를 넘으면 거부하고 SHA-256 고정길이 digest를
`timingSafeEqual`로 비교한다.

## 캐시·signed URL 검증 경계

- 전역 HTTP 회귀 테스트는 CSP의 `base-uri 'self'`·`frame-ancestors 'none'`·
  `object-src 'none'`, HSTS, `nosniff`, `DENY`, referrer/permissions 정책과
  `X-Powered-By` 비활성화를 고정한다. nonce 없이 정적/ISR 렌더링을 유지해야 하므로
  `script-src`/`style-src`는 이 단계에서 허위로 완화해 선언하지 않는다.
- 모든 `/api/**` 응답은 브라우저 기준 `private, no-store, max-age=0`을 fail-closed
  기본값으로 갖는다. leaderboard의 짧은 공유 캐시만
  `Vercel-CDN-Cache-Control`에 분리한다. 예약 event와 legal version API는 edge도
  `no-store`다. event 목록·상세·sitemap은 force-dynamic exact wall-clock query다.
  팝업·배너는 service-role 전용 STABLE SQL RPC 한 statement의 단일 MVCC snapshot에서
  4지면 deterministic pick과 common `serverNow`·`nextTransitionAt`을 함께 산출한다.
  DB mutation 도중 지면이 갈라지지 않으며, server/client 왕복이 전환 interval 이상이면
  그 snapshot을 렌더하지 않고 유한 재조회 후 fail-closed해 start inclusive/end
  exclusive 1ms 경계를 지킨다. dev raw HTTP probe에서 성공·400·401·403 API 응답
  모두 browser `no-store`이며 ETag가 없고, edge-cache 대상 응답도 browser cache와
  분리됨을 확인했다.
- cookie-auth API의 POST/PUT/PATCH/DELETE는 proxy가 session·body·DB보다 먼저 exact
  `Origin`과 `Sec-Fetch-Site`를 검사한다. scheme/host/port·sibling subdomain·
  `cross-site`·opaque/malformed origin은 403이고, same-origin과 headerless cron은
  통과한다. signed PortOne/FAL webhook은 각 route의 서명 검증이 권위이므로 선행
  bypass 목록으로 격리한다. cross-origin OPTIONS에는 ACAO가 없어 브라우저 preflight도
  허용되지 않는다.
- Supabase auth cookie 옵션은 browser/server/proxy client가 같은 `Path=/`,
  `SameSite=Lax`를 쓰며 production/preview에서는 `Secure`를 강제한다. 브라우저
  Supabase SDK가 token cookie를 읽는 현재 구조 때문에 `HttpOnly=false`인 한계는
  명시적으로 테스트·문서화한다.
- next/image optimizer는 원격 URL을 전부 거부하고 query 없는 로컬 `/logo.png`,
  quality 75만 허용하며 redirect를 따라가지 않는다. 동적 Supabase 로고는 기존
  640px transform URL을 `unoptimized`로 직접 전달한다. raw probe에서 허용 로고
  200, 다른 local path·fal.media·임의 Supabase·quality 76은 모두 400이었다.
- `dollPath`는 확정 PNG와 후보 JPG의 exact UUID object-key 문법 및 레거시 Supabase
  HTTPS URL만 canonicalize한다. 임의 외부 URL, dot traversal, `%2f`/`%2e`, backslash,
  double slash, control byte, 잘못된 확장자·후보 index·UUID는 signing 전에 null로
  닫힌다.
- private Storage signed URL이 HTML에 직접 들어가는 `/doll`, `/share`, history 상세는
  `force-dynamic`이다. ISR TTL을 signed URL보다 짧게 두더라도 장기간 무방문 뒤 첫
  요청에는 stale HTML을 먼저 줄 수 있으므로, 요청마다 새 URL을 발급한다.
- doll/share OG 이미지는 signed image를 서버에서 bounded download해 data URI로
  렌더하되 제작자 탈퇴·quarantine/scrub 직후 stale identity/highlight를 다시
  노출하지 않도록 `force-dynamic`, `revalidate=0`, `private, no-store`와 CDN별
  `no-store`를 사용한다. 공개 leaderboard도 같은 no-store 계약이다.
  takedown/restore/permanent-delete는 관련 동적 경로를 명시적으로 무효화한다.
  카카오 등 외부 crawler가 보유한 OG 사본은 서비스가 직접 무효화할 수 없으므로
  플랫폼별 cache purge를 운영 경계로 둔다.
- config 일반 read는 tag SWR와 1시간 backstop을 쓴다. 발행은
  `revalidateTag(tag,"max")`로 다음 읽기부터 갱신하며, 결제·가입 보너스·생성 제출처럼
  불변 금융/외부 효과를 만드는 경로는 uncached strict read를 사용해 DB 오류나 손상된
  발행값을 코드 기본값으로 축소하지 않는다.
- 결제 화면과 checkout API는 각각 최신 `growth_levers`를 uncached strict read한다.
  화면이 표시한 TEST/LIVE mode와 상품 스냅샷(productId·가격·지급량·주문명)은
  `expectedMode`/`expectedProduct`로 fresh 서버 판정과 exact 비교하며,
  reviewer/config가 render→click 사이에 바뀐 불일치는 409로 결제창 호출 전에
  중단한다. 따라서 stale TEST 화면이 LIVE 채널로, 표시 가격이 다른 청구액으로
  조용히 재분류되지 않는다.
- proxy의 법무 버전 캐시는 edge isolate별 최대 60초이지만 KST 날짜가 cache identity라
  예약 시행 자정에 전날 항목을 재사용하지 않는다. 최종 member API/RSC와 동의 제출
  transaction은 uncached 권위 판정을 다시 한다.
- 이미 외부 플랫폼이 가져간 카카오 등 OG cache는 앱의 `revalidatePath` 권한 밖이다.
  자동 QA는 이 외부 cache의 즉시 소거를 보장한다고 주장하지 않는다.

## 브라우저 전달·SDK·asset 경계

`__tests__/qa/client-mutation-inventory.test.ts`는 현재 브라우저가 유발하는
first-party 도메인 변경을 method+endpoint 기준 exact 46개로 고정한다. 이 중
`GET /api/generations`와 `GET /api/pay/order-status`는 조회처럼 보이지만 만료·지급·
취소 관찰을 확정할 수 있으므로 side-effecting recovery로 분류한다. signed URL batch,
admin mutation receipt와 제거된 onboard/reconsent 410 endpoint 등 domain-read-only
POST 4개는 변경 inventory와 겹치지 않는 별도 exclusion이다.

일반 변경은 20초 hard total deadline, 12초 attempt deadline, component lifecycle
abort, 최대 64KiB strict UTF-8 JSON receipt와 byte-equivalent payload 재전송을 공통
`client-mutation` 계층에서 적용한다. score 제출, 생성 submit/pick, admin
adjust/cancel/refund처럼 브라우저 영수증이 필요한 흐름은 먼저 durable intent를 기록하고
권위 receipt 확인 전에는 지우지 않는다. telemetry/track은 bounded best-effort이며
성공을 추측하지 않는다. 브라우저 코드의 직접 `response.json()` 호출은 inventory
검사상 0개다.

HTTP 바깥 SDK 경계도 별도로 검증한다. Supabase Auth의 session read, 익명 로그인,
OAuth user/start, reviewer password login과 signout은 auth cookie, refresh
single-flight, storage event, auto-refresh lifecycle을 소유하는 단 하나의
GoTrueClient browser singleton을 공유한다. 설치된 SDK가 호출의 동기 구간에서
`fetch`를 시작하는 익명 로그인과 reviewer password login만 FIFO로 직렬화한
operation-scoped `AbortSignal`을 transport와 response body 종료까지 결합한다.
`getSession`/`getUser`, OAuth URL 생성, local signout은 같은 singleton에서
실행하고 deadline과 component lifecycle fence가 늦은 결과·이동·UI publish를
폐기한다. 필수 server signout POST는 별도 abortable fetch와 exact replay로
수렴한다. fresh login은 SessionBootstrap의 익명 session single-flight에 먼저
합류하므로 늦은 익명 응답이 member session을 덮거나 이른 OAuth click이
missing-session으로 실패하지 않는다. LoginForm unmount·bfcache 복원 뒤 늦은
OAuth 이동도 막는다. profile, gallery, badge, play doll PostgREST read는 shared
client에 query별 `.abortSignal`을 적용한다. nickname PostgREST update는 같은
normalized 값의 exact replay이고, avatar/highlight/event/site asset signed
upload는 60초/45초 단일 bounded attempt다.

2026-07-31 auth singleton hotfix source 안정 회차에서는 직전 production
`d1d6c91b8de2e379fefdeb3de0117ee26167c6fc` 홈 reload마다 동일 storage key의
GoTrueClient 7개와 SDK 경고 6개가 생기는 것을 브라우저에서 재현했다. 원인은
signal마다 `isSingleton:false` client를 새로 만들던 경로였다. 수정 source는
반복 7회 생성의 identity 1개, 경고 0개, BroadcastChannel/visibility lifecycle
owner 수 불변, Fast Refresh scope 재사용, 두 session-establishing mutation의
동기 fetch 포착, FIFO, pre-aborted queued mutation의 network 0회, 서로 다른
signal 격리, header 이후 느린 body abort, anonymous→password 순서의 최종 member
session을 설치된 `@supabase/ssr 0.10.3`·`@supabase/auth-js 2.107.0`으로 직접
검증했다. 전체 source gate는 Node 22.14.0에서 182파일 1,076/1,076, TypeScript,
ESLint, golden vector 8/8, custom rule self-test, 취약점 0, Next.js 16.2.12
production build 77 artifact를 통과했다. 로컬 실제 hydration의 desktop↔gallery
SPA 전환과 390×844 reload도 성공했고 horizontal overflow 0, H1 1개, image
load 2/2였다. production 재배포 뒤 동일 console 경고 6→0 증거와 exact release
SHA는 배포 postflight에서 이 블록에 덧붙인다.

Root layout의 `SessionBootstrap`은 OAuth discovery와 안정 Auth baseline이 끝날
때까지 ordinary client subtree의 **hydration만** Suspense로 보류한다. 서버
렌더에서는 같은 subtree를 그대로 통과시키므로 인증 API/Web Locks 장애가
지속돼도 홈·FAQ·이용약관·개인정보처리방침의 H1과 본문은 initial HTML에 남고,
검색·열람·native link navigation이 bootstrap spinner에 대체되지 않는다.
브라우저 첫 hydration은 완료된 SSR DOM을 유지한 채 descendant effect를 0개로
묶고, exact null-flow discovery와 `ensureAuth` 성공 뒤에만 subtree를 hydrate한다.
`/auth/**`는 기존대로 ordinary bootstrap owner를 아예 mount하지 않는다.

초기 discovery/Auth 실패는 안정 identity change가 아니므로 document
invalidation 경로를 호출하지 않는다. 해당 attempt의 reconciliation owner와
subscription을 clean release하고 5초 local retry를 예약한다. 실제 owner
harness는 이 경로에서 `reload=0`, `body.inert=false`, profile/Sentry clear 0,
unsubscribe 1을 확인하고 다음 attempt가 새 owner를 얻는 것도 검증한다.
production build 뒤
`BOSS_PAEGI_VERIFY_BUILT_HTML=1 node --experimental-strip-types --test __tests__/qa/session-bootstrap-initial-html.test.ts`
를 실행하면 built Next server의 `/`, `/faq`, `/terms`, `/privacy` 응답에서 script
payload를 제외한 실제 initial markup의 route별 H1과 non-blocking shell을
검증한다.

`/auth/reconcile`은 직접 URL 방문이 auth storage mutation 권한을 얻지 못하도록
random nonce·reason·next·exact user/session CAS·원래 query/fragment 없는 pathname·
proxy가 raw Cookie header에서 본 Supabase auth-token/code-verifier cookie 이름의
canonical exact set을 SHA-256으로 묶어 HttpOnly capability cookie와 대조한다. cookie
값은 URL·React payload·digest 입력에 포함하지 않는다. canonical name 목록은 4KiB가
상한이며, 비-GET/HEAD 요청은 303으로 전환해 원 mutation method/body가 복구 페이지로
재전송되지 않는다. 브라우저는 H→S 안에서 원 pathname의 non-root RFC path-match 경계
(`/account/settings/`이면 `/account`, `/account/`, `/account/settings`,
`/account/settings/`)에 capability-bound exact names를 지우고, 동시에 복구 페이지에서
보이는 auth/verifier names도 `/auth`·`/auth/`·`/auth/reconcile` non-root 경계에서
먼저 지운다. OAuth marker/barrier 부재를 확인한 뒤 verifier의 root/current 변형까지
제거하고 나서만 root auth를 재판정한다. valid root는 보존하고 corrupt/absent root만
visible exact names와 verifier를 지운다.

구조상 유효하고 만료 전이어도 서버에서 폐기된 세션은 실제 storage와 분리된
non-persisting Auth probe로 조회한다. `session_not_found`/invalid JWT처럼 명시적인
rejection만 폐기로 분류하고, raw-cookie bytes/fingerprint·access/refresh token·
user/session ID가 최초 snapshot 및 SDK session과 exact 일치하는지 SDK S lock 안에서
다시 확인한 뒤 로컬 세션을 지운다. 같은 UUID의 token rotation을 포함한 새 세션 경합,
network/429/5xx/모호 응답은 mutation 없이 보존·재시도한다.

마지막 same-origin HEAD probe는 원 pathname과 현재 `/auth/reconcile` 양쪽에서 auth와
verifier raw pair의 order-independent·multiplicity-preserving fingerprint가 보존한
root 또는 empty와 같은지 proxy에서 확인한다. 따라서 원 path stale cookie와 `/auth`
scoped cookie의 역방향 조합, 동일 이름의 root+scoped duplicate, arbitrary safe suffix
`.64`/`.foo`, Domain tombstone 실패, JS에 보이지 않는 HttpOnly verifier가 정상 root
오삭제나 다음 원 pathname redirect loop로 넘어가지 않고 재시도 UI에서 fail-closed한다.
단일 capability cookie를 두 탭이 경합하면 digest가 다른 losing query는 mutation-capable
client를 받지 못한다. 이 계약은
`__tests__/auth/auth-session-reconcile.test.ts`의 parser/digest/path/name/fingerprint와
source-order 회귀로 고정한다.

Pixi `Assets.load`는 20초/19초 단일 attempt로 제한한다. asset cache/load를 독립
두 작업으로 재실행하지 않고, 실패를 기본 캐릭터나 성공으로 축소하지 않으며, play
component가 사라지면 결과 publish를 중단한다. PortOne browser SDK 역시 별도 bounded
single-attempt 결제창 계층에서 lifecycle과 request correlation을 유지한다.

## 자동화로 증명하지 않은 외부 경계

다음 항목은 사용자의 명시적 범위에 따라 실행하지 않았으며, 결함이 없다고 허위 판정하지 않는다.

- 실제 fal.ai 이미지 생성·과금 호출
- 실제 현금이 이동하는 PortOne 결제·취소·계좌 환급
- 실제 카카오/Google 제공자 로그인 UI와 제공자 장애
- 실기기 고주사율·터보 입력·모바일 background lifecycle
- Safari/모바일 브라우저의 장기 storage eviction과 OS 메모리 압박
- 이메일 수신 사업자, CDN, DNS, Vercel/Supabase 리전 장애

FAL은 로컬 cryptographic/fault stub, raw HTTP contract, ED25519/JWKS와 DB saga로
검증하고 실제 이미지 생성은 호출하지 않는다. 결제는 PortOne wire-contract,
cryptographic/fault stub, DB saga 및 돈이 이동하지 않는 sandbox 경로만 허용한다.
실기기 항목은 이 문서와 KB에 수동 검증 경계로 남긴다.

## 종료 조건

작업은 다음 조건을 모두 만족할 때만 완료로 판정한다.

- fresh-chain 전체 gate가 연속 안정 회차에서 새 결함 없이 통과
- 변경과 관련 문서가 동기화
- PR CI 통과 및 `main` 병합
- 운영 bootstrap freeze → expand → 신 앱 frozen 배포 → provider backfill/drain →
  contract → reopen → 재-smoke 완료
- 운영 데이터/권한 postflight 위반 0
- 기존 7개 cron 재확인과 신규 `privacy-maintain` 등록·drain 200·SLA 증거 확보
- 임시 QA 세션·로컬 비밀 파일 정리
- 실행하지 않은 외부·실기기 경계를 KB와 이 문서에 명시
