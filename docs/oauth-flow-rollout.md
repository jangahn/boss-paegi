# OAuth flow ledger 0093 → app → 0094 → 0095 rollout

## 불변 배포 순서

OAuth callback·세션 교체·익명 데이터 이전을 durable flow ledger로 전환할 때의
유일한 운영 순서는 다음과 같다.

1. `0093_oauth_flow_intents.sql`만 적용한다.
2. 0093 RPC를 사용하는 새 앱의 exact Git `main` release commit을 production
   alias에 배포한다. 배포 commit은 0093 receipt commit과 같거나 그 진짜 후손이어야
   하고, 후손에서도 0093 파일 bytes는 바뀌면 안 된다.
3. Vercel API가 canonical alias를 같은 immutable `READY/PROMOTED` Git deployment로
   확인한다. 제거된 `gitSource` 필드에는 의존하지 않고 provider의 exact
   `gitRepo` repo/owner ID·path·default branch와 Git metadata를 검증한 뒤 GitHub
   API의 현재 `main` branch SHA를 독립 교차검증한다. 그 deployment의
   `config.functionTimeout=300`도 증거 hash와 DB qualification에 결속하는 동안
   canonical·immutable URL을 모두 probe한다.
   alias가 current가 된
   시점부터 구 issuer invocation 최대 300초 + legacy cookie 15분 + 만료 직전
   검증한 consumer invocation 최대 300초 + clock margin 5초인
   **1505초(25분 5초)** 이상을 drain한다.
4. expand ACL, 공급자 증명, 앱 postflight가 모두 통과하고 append-only
   qualification receipt가 0094와 같은 트랜잭션에 기록될 때만
   `0094_oauth_flow_migration_contract.sql`만 적용한다.
5. contract ACL과 OAuth smoke를 다시 검증한다. 이어 원본
   `0095_analytics_maintenance_argument_bounds.sql`이 staged-runner guard에서
   전부 rollback하는지 먼저 증명한다.
6. 0094와 **다른 Management API 요청·다른 DB transaction**으로 0095만 적용한다.
   0095 함수 본문·인자 기본값·SECURITY DEFINER/search_path·owner·exact ACL
   fingerprint와 0095 journal receipt가 일치해야 한다.
7. analytics bounds pgTAP, maintenance lock race, 전체 pgTAP을 통과한 뒤에만
   frozen 결제·생성 surface를 재개한다.

**0093과 0094를 한 요청, 한 migration range, 한 배포 단계에서 함께 적용하는 것은
금지하며, 0094와 0095도 반드시 서로 다른 transaction으로 적용한다.** 0093은 구 앱이 쓰는 raw
`reassign_anon_data(uuid,uuid)`의 `service_role EXECUTE`를 유지하는 expand
단계이고, 0094는 모든 앱 instance가 flow-scoped
`consume_oauth_flow_intent_migration`을 쓰는 것이 확인된 뒤 그 권한을 회수하는
contract 단계다. 둘을 같이 적용하면 아직 실행 중인 구 앱 요청이 익명 데이터 이전을
끝내지 못한다.

`supabase db push`, `supabase migration up`, `supabase db reset`과
`qa:db:apply`는 이 운영 rollout의 실행 명령이 아니다. 특히
`qa:db:apply`가 0093·0094를 순서대로 적용하는 것은 **빈 disposable DB에서 최종
스키마를 검증하기 위한 단축 경로**일 뿐 staged compatibility 증거가 아니다.
로컬 0094 단계는 먼저 원본 SQL이 qualification 없이 실패하고 전부 rollback하는지
증명한 뒤, `render-local-oauth-contract.mjs`가 명시적으로 표시된 disposable
fixture를 intrinsic guard 앞에 주입한다. 이 fixture는 production evidence가 아니며
운영 runner는 이를 수용하지 않는다. 원본 0095도 staged post-contract
authorization 없이 항상 실패한다. disposable DB에서만
`render-local-analytics-maintenance-bounds.mjs`가 marker와 exact raw guard를
함께 제거하며, 그 local fixture는 journal/lineage 증거가 아니다.

## disposable DB / CI

0092까지 검증된 로컬 Supabase에서 아래 순서를 그대로 실행한다.

```bash
npm run qa:db:apply:oauth-expand
npm run qa:db:oauth-expand
npm run test:db:oauth-expand-compat
npm run qa:db:oauth-prune-lock-race

npm run qa:db:oauth-contract-raw-guard
npm run qa:db:apply:oauth-contract
npm run qa:db:oauth-contract

npm run qa:db:analytics-maintenance-raw-guard
npm run qa:db:apply:oauth-post-contract
npm run test:db:analytics-maintenance-bounds
npm run test:db:dead-service-rpc-acl-cleanup
npm run qa:db:analytics-maintenance-lock-race
npm run test:db
```

expand 단계에서는 legacy `score_submission_integrity.pgtap.sql`을 별도로 실행해
raw reassignment의 `service_role` 실행권이 유지됨을 증명한다. 0094 뒤 전체
pgTAP은 같은 테스트의 contract branch와 `oauth_flow_intents.pgtap.sql`을 통해
raw 실행권이 회수되고 flow-scoped RPC만 남았음을 증명한다. CI workflow도 두
`--only` 적용 사이에 이 compatibility test와 실제 2-session terminal-lock
backlog race를 배치한다. 0094 검증 뒤에는 raw 0095 rollback을 먼저 확인하고,
0095만 적용한 뒤 focused 50-assertion bounds/maintenance ACL pgTAP,
six superseded service RPC의 owner-only closure를 고정하는 16-assertion
pgTAP과 실제 telemetry rebuild·analytics rebuild·prune 직렬화 race를 전체
pgTAP보다 먼저 실행한다.

## production runner

운영 적용은 raw SQL 복사나 migration range 대신 stage가 하나뿐인 전용 runner를
사용한다. runner는 exact production project ref, clean source commit/tree,
migration source/manifest hash와 원자 migration journal receipt를 확인한다.
Management API 자격은 zshenv의 `BOSS_PAEGI_SUPABASE_ACCESS_TOKEN`만 읽고
출력하지 않는다. `BOSS_PAEGI_SUPABASE_PROJECT_REF`가 설정돼 있으면 고정
production ref와 정확히 같아야 하며 다른 project에는 요청을 보내지 않는다.
Vercel 자격은 `BOSS_PAEGI_VERCEL_API_TOKEN`,
`BOSS_PAEGI_VERCEL_ORG_ID`, `BOSS_PAEGI_VERCEL_PROJECT_ID`만 읽는다.
operator가 입력한 commit·Ready 시각은 권위로 사용하지 않는다. runner가 Vercel
alias/deployment API에서 canonical alias, immutable deployment ID/URL, GitHub
`main` source/repository/SHA, production `READY/PROMOTED`, Node 22.x와 alias-current
시각을 직접 결속한다.

runner는 0093 receipt commit의 실제 Git blob/tree를 local object database에서
읽고, deployed commit이 그 조상 관계를 보존하는지 확인한다. 현재/deployed tree의
0093 bytes hash도 receipt와 같아야 하므로 fix-forward DB 변경은 0093 수정이 아니라
새 migration이어야 한다. 0094 직전에는 provider evidence와 canonical·immutable
route identity를 다시 읽고, provider qualification과 0094 journal receipt를 같은
DB transaction에 기록한다. 0094 원본 SQL 자체도 qualification assert를 먼저
호출하므로 raw SQL·`supabase db push`·`migration up`은 receipt 없이 fail-closed한다.
응답이 유실되어도 qualification, journal, DB ACL postcondition이 모두 정확한
경우에만 성공으로 수렴하며, transaction 직후 provider/route evidence가 바뀌어도
성공으로 축소하지 않는다. 0095 runner는 0094 historical qualification과
0093/0094 receipt lineage를 다시 검증하고, OAuth catalog의 contract fingerprint를
transaction 시작과 0095 DDL 뒤에 각각 확인한다. 그 사이에는 catalog advisory/
relation/function lock을 보유한다. 0095 함수의 exact source hash·인자/기본값·
result/language/security/search_path/volatility/strict/parallel/owner/ACL
fingerprint와 0095 receipt도 동일 transaction에서만 전진한다.
같은 0095에 접힌 여섯 superseded service RPC는 owner 외 모든 explicit/PUBLIC
EXECUTE grant를 동적으로 제거한다. runner 재진입 snapshot도 여섯 exact
signature의 존재와 zero non-owner EXECUTE를 확인하므로, receipt 뒤 ACL drift가
green으로 숨지 않는다.

```bash
# 0) CI가 green인 final release branch를 unchanged origin/main 위에 두고
#    clean HEAD/HEAD^{tree}를 고정한다. mutation 직전 fetch로 base 불변을 재확인한다.

# 1) 그 exact clean HEAD에서 0093만 dry-run 후 적용
npm run qa:prod:oauth:expand
npm run qa:prod:oauth:expand:apply

# 2) origin/main이 계속 같은 base일 때 동일 HEAD를 main에 fast-forward push한다.
#    이 Git push로 Vercel production 자동 배포를 시작한다.
#    CLI deploy/redeploy/promote나 다른 source의 alias 변경은 금지한다.

# alias-current 이후 1505초 이상 지난 다음 read-only provider/app/drain 검증
npm run qa:prod:oauth:app-postflight

# 3) 같은 postflight를 다시 통과해야만 0094 dry-run/apply 가능
npm run qa:prod:oauth:contract
npm run qa:prod:oauth:contract:apply

# 4) 0094 검증 뒤에도 checkout/FAL/doll은 frozen 상태를 유지한다.
#    0095를 별도 transaction으로 dry-run/apply한다.
npm run qa:prod:oauth:post-contract
npm run qa:prod:oauth:post-contract:apply

# 5) 0095 receipt/fingerprint와 전체 QA를 확인한 뒤에만 비용 surface를 재개한다.
```

0093을 적용하는 release branch는 `origin/main`의 후손이어야 한다. expand
직전과 직후에 `git fetch origin main`을 다시 실행해 base가 움직이지 않았음을
확인하고, 그 경우에만 exact `HEAD:main`을 force 없이 **fast-forward** push한다.
이 fast-forward가 Vercel Git production 배포를 시작해야 한다. 0093 뒤
`origin/main`이 움직이면 force-push, rebase, cherry-pick, squash merge처럼 0093
receipt 조상을 제거하는 이력 재작성은 금지한다. additive expand를 유지하고 새
main과 release를 merge해 0093 receipt commit을 조상으로 보존한 새 clean
fix-forward commit을 만든 뒤 CI를 다시 통과한다. 그 후에도 0093 bytes는 receipt
hash와 같아야 한다. ordinary merge commit 자체는 이 조상·bytes 불변을 만족할 때만
허용된다.

postflight는 Vercel API의 current alias evidence가 0093 적용 뒤 생성된 exact Git
deployment이며 immutable `functionTimeout=300`인지 확인하고, alias-current 시각이
1505초 이상 24시간 이하인 경우에만
진행한다. production alias와 immutable deployment URL 각각에서 OAuth status
route를 서로 다른 cache-buster로 세 번 호출해 exact
`400 {"error":"invalid_body"}`와 `no-store`를 확인한다. checkout·FAL·doll도 두
origin에서 exact Supabase ref, build commit, Vercel project/deployment/URL,
production environment headers가 모두 같은 frozen deployment인지 검증한다.
CLI deployment, 수동 redeploy/promote, Git이 아닌 `source`, PR preview, 다른 repo,
다른 `main` SHA는 qualification 대상이 아니다.

runner는 한 번에 `expand`, `app-postflight`, `contract`, `post-contract` 중
정확히 하나만 받는다.
`app-postflight --apply`, 복수 `--stage`, 다른 project ref는 실행 전에 거부한다.
contract는 0093 journal과 expand ACL이 없거나 live probe가 하나라도 다르면 0094
SQL을 전송하지 않는다. deployment/alias 증거가 0093 적용 전이거나 이미 존재하는
0094 영수증이 1505초 drain 종료 전이면 timeline drift로 차단한다. production
qualification table은 RLS/no-grant·append-only이며 exact provider/Git/runtime/time
evidence 한 행만 허용한다. 0093 적용 뒤
문제가 발견되면 additive expand 상태를
유지한 채 fix-forward한다. 0094 뒤에는 구 앱으로 rollback하지 않는다.

0095 전 dry-run/apply와 apply 직후까지는 canonical·immutable deployment의 OAuth
status뿐 아니라 checkout·FAL·doll frozen identity도 계속 확인한다. 반면 0095가
완료된 뒤의 `contract`/`post-contract` 재진입은 비용 surface가 정상 재개되어도
green이어야 하므로 frozen 503을 영구 요구하지 않는다. 대신 Vercel current
canonical alias와 immutable deployment가 현재 clean `main` source commit에
정확히 결속됐는지 확인하고, 두 origin의 OAuth status를 각각 세 번 호출해
`400 {"error":"invalid_body"}`, `no-store`, exact Supabase/build/Vercel
project/deployment/URL/environment identity headers를 검증한다. 따라서 정상
checkout open은 허용하지만 0094 비호환 구 앱 rollback, 404 route, stale build
header, alias 교체는 재진입 green으로 숨지 않는다.

원본 0095를 직접 실행해 함수만 바뀌고 receipt가 없거나, receipt만 있고 함수
fingerprint가 다르거나, `0095.applied_at <= 0094.applied_at`이면 runner는
`oauth_database_journal_mismatch`/timeline 오류로 멈춘다. 실제 적용 commit과
시각을 증명할 수 없는 사후 receipt를 만들어 “수리”하지 않는다.

## `content-maintain` 운영 계약

0093 이후 `prune_oauth_flow_intents(100)`의 성공 응답은 다음 exact 11-key
객체다. 키 누락·추가, 음수, 비정수는 모두 503-class system error다.

| 키 | 의미 | non-green 조건 |
|---|---|---|
| `expiredPending` | 이번 호출에서 만료 처리한 pre-exchange pending 수 | batch limit 도달 |
| `boundRecoveryConverged` | 결속된 claim/sign-out을 5분 grace 뒤 exact target session revoke 또는 부재 증명으로 종결한 수 | 관측값 |
| `prunedTerminal` | 이번 호출에서 retention 삭제한 terminal 수 | batch limit 도달 |
| `targetAuthorityLossConverged` | target 탈퇴 또는 recovery deadline 경과로 source privacy scrub을 완료한 수 | 관측값 |
| `targetAuthorityLossBacklog` | 지금 처리해야 하지만 lock/batch/blocked 상태로 남은 target-authority-loss 수 | `> 0` |
| `pendingExpiryBacklog` | 아직 남은 만료 대상 pending 수 | `> 0` |
| `terminalRetentionBacklog` | lock 경합·batch limit을 포함해 아직 남은 삭제 가능 terminal 수 | `> 0` |
| `unconsumedMigrationBacklog` | 35일을 넘긴 미소비 익명이전 receipt 수 | `> 0` |
| `unreleasedContinueBacklog` | 완료됐지만 브라우저 release가 확인되지 않은 continue 수 | `> 0` |
| `unboundClaimBacklog` | signed lease가 끝났지만 lock/batch 때문에 아직 expire되지 않은 unbound claim 수 | `> 0` |
| `boundRecoveryBacklog` | 5분 recovery grace가 끝났지만 아직 종결되지 않은 bound claim/sign-out 수 | `> 0` |

일곱 backlog 필드 중 하나라도 양수면 `content-maintain`은
`boundedBacklogs`를 증가시켜 `429 + Retry-After: 60`, `ok:false`로 응답한다.
`terminalRetentionBacklog`는 `pg_try_advisory_xact_lock` 경합으로 선택 row를
건너뛴 경우에도 남은 실제 eligible row를 다시 세어 200 false-green을 막는다.
각 phase의 `p_limit`은 실제 lock을 획득한 row에만 소비되므로 잠긴 선두 row가
뒤의 처리 가능한 row를 굶기지 않는다. target session이 결속되지 않은 claim은
signed lease 경계에서 자동 expire되고, 결속된 claim과 sign-out 중단 상태는
원래 lease와 target-session 생성시각 양쪽보다 5분이 지난 뒤 exact session을
폐기하거나 부재를 증명해 terminal 상태로 수렴한다.
특히 `unreleasedContinueBacklog`는 terminal retention으로 삭제해 숨기면 안 되는
세션 복구 fence다. `unconsumedMigrationBacklog`도 자동 삭제 대상이 아니라 운영
조사 대상으로 계속 노출한다. exact 11-key 응답을 확인하지 못한 호출을 성공
heartbeat로 기록하지 않는다.

익명→회원 재할당은 같은 transaction에서
`oauth_anon_auth_cleanup_jobs`의 원본 `auth.users.created_at+instance_id`
세대 receipt를 `pending`으로 arm한다. 즉시 Admin Auth 삭제가 성공했다고
응답해도 그것만으로 job을 완료하지 않는다. `content-maintain`은 최대 10개를
lease하고 각 job마다 fresh Admin Auth read → lease·세대 DB 검증 → 삭제 시도 →
fresh Admin Auth read → 잠금 아래 DB 검증 순서로 실행한다. 삭제 호출의
resolved `{ error }`, throw, malformed success, 응답 유실은 모두 같은 후속
검증으로 수렴한다. fresh `user_not_found`와 DB 부재가 함께 확인된 경우만
`completed`, 비익명 승격이나 다른 `created_at/instance_id` 세대면 삭제하지 않고
`protected`(`source_generation_changed`), 나머지는 bounded exponential
backoff의 `pending`이다. target session 기반 discovery는 URL/body에서
`migrationFlow`가 사라져도 released+unconsumed anonymous flow를 다시 찾아
회원 mutation 전에 복구한다.

target session의 회전·소실 자체는 terminal 사유가 아니다. release 후 24시간
동안 원래 target session이 없으면 source profile을 generic withdrawn shell로
바꾸고 score highlight를 숨기며 source session을 전부 revoke한 뒤 quarantine한다.
동일 target principal의 현재 live session은 flow expiry + 30일 + 5초인 exact
`recover_until`까지 authority를 복구해 migration을 소비할 수 있다. deadline을
엄격히 지난 경우에는 점수와 Auth/profile shell은 비식별 상태로 보존하고
badge·highlight·telemetry·source session을 제거하거나 비식별화해 `scrubbed`로
종결한다. target profile이 삭제됐거나 없으면 deadline을 기다리지 않고 같은
scrub을 수행한다. old JWT는 현재 `auth.sessions`의 exact `(session,user,
created_at)`가 살아 있을 때만 RLS/server read를 통과하며, flow/cleanup 삭제가
남긴 영구 session-ID tombstone은 같은 UUID의 Auth session 재사용도 막는다.

target 기존회원 또는 이미 다른 source가 target을 선점한 경우에는 exact
no-transfer receipt를 남기고 source를 즉시 quarantine한 뒤 같은 recovery/scrub
deadline으로 보낸다. source 비익명 승격·회원화, 금지 source 데이터, source Auth
세대 변경은 보존할 별도 principal일 수 있으므로 cleanup을
`blocked/migration_blocked`로 만들고 privacy status를 non-green으로 유지한다.
`complete_oauth_flow_intent_migration_without_transfer`와 consume 자체가
Auth → source advisory → reassignment claim → 정렬 member lock 아래 사유를
DB에서 다시 증명하고 migration receipt와 위 cleanup 전이를 같은 transaction에
쓴다. 미증명·모호·손상 응답은 consent member INSERT 전에
fail-closed하며, finalize/consume와 concurrent member INSERT의 실제 2-session
harness도 lock wait 뒤 no-transfer 수렴을 검증한다.

pending/leased 동안 `auth.users` INSERT와 generation/anonymous-state UPDATE는
같은 source advisory lock과 trigger를 거쳐 동일 UUID 재사용·승격을 거부한다.
cleanup이 끝나지 않은 flow는 terminal retention 삭제 대상이 아니며,
completed/protected receipt도 완료 뒤 35일간 보존한다. claim할 due row가 없어도
exact idle ACK의 `pendingBacklog`는 미래 `next_attempt_at`과 아직 유효한 lease를
모두 세므로 재시도 대기 queue를 200 false-green으로 숨기지 않는다.
`content-maintain` 응답의 관련 필드는 다음과 같다.

| 키 | 의미 | scheduler 처리 |
|---|---|---|
| `oauthAnonAuthCleanupClaimed` | 이번 호출에서 획득한 lease 수 | 10이면 bounded backlog로 429 |
| `oauthAnonAuthCleanupCompleted` | fresh Auth+DB 부재로 완료한 수 | 관측값 |
| `oauthAnonAuthCleanupProtected` | source Auth 세대 변경을 보호해 삭제하지 않은 수 | `last_error`별 분리 감사 |
| `oauthAnonAuthCleanupFailed` | int4 attempt/lease counter 상한에서 안전 정지한 수 | `> 0`이면 503 |
| `oauthAnonAuthCleanupPending` | 이번 호출에서 재시도로 돌린 수 | backlog에 포함 |
| `oauthAnonAuthCleanupBacklog` | 호출 종료 시 남은 pending/leased 수 또는 full-batch 하한 | `> 0`이면 429 |
| `oauthAnonAuthCleanupClaimErrors` | claim/RPC/응답 계약 오류 수 | `> 0`이면 503 |

`attempt_count`/`lease_version`의 최댓값 `2147483647`에서 더한 뒤 wrap하거나
unclaimable leased row를 남기지 않는다. 마지막 representable attempt의 실패와
만료된 마지막 lease는 `protected/cleanup_attempt_limit_exhausted`로
terminalize하고 `oauthAnonAuthCleanupFailed` 및 service-only exact 6-key
`oauth_anon_privacy_status.failures`에 노출한다. privacy status의
`due`, `blocked`, `failures`, `capped` 중 하나라도 non-zero/true이면
`privacy-maintain`은 성공 heartbeat를 내지 않는다.

공개 leaderboard JSON과 doll/share OG 응답은 `force-dynamic` 및
`Cache-Control: private, no-store`와 CDN별 `no-store`를 사용해 scrub 직후
애플리케이션·Vercel 캐시가 이전 identity/highlight를 다시 제공하지 않게 한다.
다만 카카오 등 외부 crawler가 이미 저장한 OG 사본은 서비스가 직접 무효화할 수
없는 경계이므로 해당 플랫폼의 cache purge 절차를 별도로 수행한다.

## 완료 증거

- production journal에 0093, 0094, 0095가 각각
  `expand`, `contract`, `post-contract` stage manifest로 존재
- 0093 receipt 시각 < Git deployment 생성/`Ready`/alias-current <
  alias-current+1505초 ≤ DB qualification 시각 ≤ 0094 receipt 시각
- qualification은 0093 receipt commit/tree/hash, deployed descendant
  commit/tree, exact Vercel team/project/deployment/immutable URL/alias/evidence hash를
  exact 300초 function timeout과 함께 append-only 한 행으로 결속
- 0093 단계: raw reassignment와 pre-ledger
  `consume_legacy_signup_migration` bridge는
  `service_role EXECUTE=true`, anon/authenticated/PUBLIC=false
- 0094 단계: raw reassignment와 legacy bridge 모두
  `service_role/anon/authenticated/PUBLIC EXECUTE=false`이며 각 contract comment가
  정확히 일치
- 새 flow/cleanup scoped RPC는 `service_role`만 실행 가능하다. flow, cleanup,
  reassignment winner, quarantine-highlight marker, score-owner/session-ID tombstone,
  legacy migration receipt, qualification의 여덟 critical private relation은
  RLS/direct-ACL 계약과 owner-only `BEFORE TRUNCATE` guard를 갖는다. verifier는
  8개 trigger의 exact relation·function·statement tgtype과 전체 21개 trigger
  inventory를 함께 검사해 owner 실수로 receipt·marker·tombstone을 일괄 삭제하는
  경로도 차단한다.
- flow/cleanup scoped RPC exact inventory는 25개이고 no-transfer completion
  RPC 누락·추가·overload도 stage mismatch. 이 inventory와 별도로 legacy
  bridge의 단일 exact signature·ACL 및 receipt append-only trigger의
  `BEFORE ROW UPDATE OR DELETE` 형태도 stage verifier가 검사
- 전체 pgTAP, Auth cleanup Node fault-injection, OAuth route tests, 실제
  PostgreSQL race harness 통과
- raw 0094는 qualification 없이 실패하고 raw reassignment와 legacy bridge의
  모든 ACL/comment mutation이 rollback; disposable local fixture를 주입한 전용
  local runner만 contract 검증에 사용
- raw 0095는 staged-runner authorization 없이 실패하고 세 maintenance 함수와
  journal이 모두 불변. 운영 적용은 0094보다 늦은 별도 transaction receipt,
  OAuth contract catalog pre/post fingerprint, exact maintenance function/ACL
  fingerprint가 모두 일치
- 0095에 접힌 six superseded RPC exact inventory는 전부 owner-only이고
  `service_role`/anon/authenticated/PUBLIC 및 임의 역할 EXECUTE가 0
- telemetry rollup은 전용 advisory lock, analytics rollup과 raw prune은 공유
  advisory lock으로 직렬화되며 실제 2-session race가 wait→성공과 결과 불변을 증명
- production OAuth 로그인/취소/콜백 복구/로그아웃 smoke 통과
- `content-maintain` exact 11-key prune parse, Auth cleanup idle backlog, 완전
  empty-backlog 200 또는 backlog가 있는 경우의 의도된 429 확인
