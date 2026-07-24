# 크레딧 환불 saga v0.76 — 배포 runbook (§44)

```
status: generated / statically-checked / runtime-unverified
runtime-unverified: 실 Supabase DB·PortOne·cron 미실행. 아래 명령·기대값·게이트는 authoring 환경에서
                    실행되지 않았다. 각 단계의 "합격 기준"은 배포자가 실측으로 충족해야 하는 조건이다.
scope: 0062 additive → v2 앱(closed) → 0063 hardening → (안정화) 0064 stub 제거
repo-baseline: main @ 86fba4ce99deeffe63fc33ff4f80d8a9ce3d504c (PR #178 병합 후)
정본: 이 runbook 이 배포 순서·중단·fix-forward·증거의 단일 정본(§44). 배포 원칙은
      docs/refund-saga/boss-paegi-credit-refund-saga-final.md §23·§25, 파일 인벤토리는
      docs/refund-saga/traceability.md 를 참조한다. 게이트 SQL 은 scripts/refund/post-0062-go-no-go.sql 이 유일 정본(§32).
```

---

## 0. 사전 준비 (배포 착수 전)

### 0.1 실행 채널

- **DB 마이그레이션·게이트 SQL**: Supabase Management API query 엔드포인트로 **파일 전문**을 실행한다(read-only 게이트는 데이터 무변경). `psql` 직접 접속이 아니라 curl 경유 — urllib 은 Cloudflare 1010 으로 차단되므로 curl 을 쓴다.

  ```sh
  # 재사용 헬퍼 — 파일 전문을 {query:...} 로 감싸 POST.
  # 필요 env(zshenv): BOSS_PAEGI_SUPABASE_ACCESS_TOKEN · BOSS_PAEGI_SUPABASE_PROJECT_REF
  sbq() {  # sbq <sql-file>
    jq -Rs '{query: .}' "$1" | curl -sS -X POST \
      "https://api.supabase.com/v1/projects/${BOSS_PAEGI_SUPABASE_PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${BOSS_PAEGI_SUPABASE_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" --data @-
  }
  ```

- **preflight/drain 스크립트**: Node 22+ (레포는 node22 필요). `node --env-file=.env.local scripts/refund/<script>.mjs`. 필요 env 는 위 두 개 + `PORTONE_V2_API_SECRET`(preflight 만).
- **앱 배포**: Vercel(기존 파이프라인). Phase-A 게이트 값 전이는 배포 절차이지 코드가 아니다.

### 0.2 lock_timeout / statement_timeout (§22)

0062·0063·0064 를 적용하기 전 같은 세션에서 아래를 선행한다(긴 EXCLUSIVE LOCK 대기로 인한 커넥션 폭주 방지):

```sql
set lock_timeout = '5s';
set statement_timeout = '60s';
```

Management API query 는 요청마다 세션이 분리되므로, 이 SET 을 마이그레이션 파일 본문 앞에 **같은 query 페이로드**로 포함해 실행하거나, 파일을 그대로 실행하되 실패 시 재시도한다. 0062 는 단일 트랜잭션이므로 `lock_timeout` 초과 시 전체가 자동 롤백된다(부분 적용 0).

### 0.3 멱등·재실행 규약 (§22 migration journal)

각 마이그레이션은 마지막에 `public.schema_migration_journal(version)` 에 `on conflict (version) do nothing` 으로 원자 기록한다. 응답 유실 시 **재실행 전** journal 을 먼저 조회한다:

```sql
select version, applied_at, app_commit from public.schema_migration_journal order by applied_at;
```

- 같은 `version` 행 존재 → 이미 성공. 재실행 금지(멱등이지만 불필요).
- 행 없음 → 미적용. 안전하게 재실행.
- unknown commit(응답을 못 받음) → journal 확인 전 재실행 금지.

### 0.4 전역 rollback 정책 (§21·§14.4 — 반드시 준수)

| 시점 | rollback 허용 |
|---|---|
| Phase-A gate 도입~closed (0062 전) | gate 되돌림(open) 가능 — schema 무변경이라 무해 |
| 0062 적용 **중** 실패 | 단일 트랜잭션 자동 rollback(부분 적용 0) |
| 0062 성공 후 ~ v2 앱 배포 전 | **schema rollback 금지** — `closed` 유지 fix-forward(스키마 추가 위주라 구코드와 공존) |
| PG 부분취소 POST **이후** | **destructive rollback 금지** — money movement 가 발생했으면 증빙 없이 reservation release 금지. reconcile 로 수렴 |
| canary 실패 | gate off(→open) 진행 금지 — `closed`/`canary` 유지 후 reconcile 수렴 |

**money movement 이후에는 어떤 파괴적 롤백도 하지 않는다.** 문제는 언제나 앞으로(fix-forward)만 해소하며, PG 이동이 발생한 attempt 는 `admin_refund_replan_after_pg`·reconcile 로만 재계획한다.

---

## 1. 배포 단계 (21스텝)

각 스텝은 ① 목적 ② 실행 명령 ③ 합격 기준 ④ 중단(abort) 조건 ⑤ fix-forward vs rollback ⑥ 증거 수집으로 기술한다.

### 스텝 1 — Phase-A 게이트 도입 배포 (gate-only)

- **① 목적**: 신규 money 진입을 차단할 수 있는 스위치를 도입한다(0062 를 참조하지 않는 순수 앱 배포).
- **② 실행**: `lib/env.server.ts` 에 `CREDITS_MAINTENANCE_MODE`(`open`|`closed`|`canary`, default `open`) 추가 + `lib/credits-gate.ts` 신설(`assertWriteAllowed()` — closed 면 write-entry 라우트가 503 `service_maintenance`). Vercel 배포. **이 스텝은 `open` 으로 배포**(동작 무변화).
- **③ 합격 기준**: 배포 성공·기존 결제/생성 흐름 정상(회귀 0). `CREDITS_MAINTENANCE_MODE` 미설정 시 `open` 동작.
- **④ 중단 조건**: 게이트 도입으로 인한 기존 라우트 회귀.
- **⑤ 판단**: gate off(코드 revert) 가능 — schema 무변경.
- **⑥ 증거**: commit SHA · 배포 URL · env 전이 타임라인 시작점(`open`).

### 스텝 2 — closed 전환

- **① 목적**: drain 을 위해 신규 진입을 멈춘다(§14.2).
- **② 실행**: Vercel env `CREDITS_MAINTENANCE_MODE=closed` 로 설정 후 재배포/재시작.
- **③ 합격 기준**: write-entry 라우트(checkout·fal consume·signup bonus·admin adjust·refund begin·신규 cancel intent·credit-mutating account delete·직접 credit write)가 503 `service_maintenance`. **허용 경로는 계속 동작**: `mark_paid_and_grant` finalizer·webhook·reconcile·order-status·credit-expire drain·이미 시작된 generation 종결.
- **④ 중단 조건**: 허용 경로(finalizer/webhook/reconcile)까지 막히면 drain 불가 → 즉시 중단·게이트 범위 재점검.
- **⑤ 판단**: open 되돌림 가능.
- **⑥ 증거**: env 전이 타임라인(`open→closed` 시각) · closed 라우트 503 샘플 응답.

### 스텝 3 — pre-0062 legacy drain (open money op 0 실측, §23·§14.1)

- **① 목적**: **기존 테이블만** 보고 열린 금융 연산이 0 임을 실측한다(신규 0062 객체 무참조).
- **② 실행**:
  ```sh
  node --env-file=.env.local scripts/refund/pre-0062-drain.mjs
  ```
  5개 카테고리(`pending_with_attempt`·`refund_in_flight`·`unreconciled_canceled_paid`·`queued_generations`·`failed_unrefunded_generations`)의 window count 를 조회하고 `scripts/refund/pre-0062-drain.json` 을 출력한다.
- **③ 합격 기준**: `open_total = 0` 및 `malformed = 0` → exit 0, `[OK] drained`. 잔여가 있으면 reconcile·gen-recover 스윕으로 소진 후 재실행.
- **④ 중단 조건**: 스윕으로도 `open_total` 이 0 으로 수렴하지 못함(특히 늦은 PAID 가능 pending / VIRTUAL_ACCOUNT). exit 1(`[NO-GO]`).
- **⑤ 판단**: 0062 미적용(gate 유지). 앞으로 진행(drain 계속) — rollback 대상 없음.
- **⑥ 증거**: `pre-0062-drain.json`(manifest_hash · 카테고리별 count · sample_ids · open_total).

### 스텝 4 — PortOne pending 전수 분류 (§23·§27)

- **① 목적**: 로컬 상태만 믿지 않고 PortOne fresh GET 으로 pending/canceled 를 실제 상태로 분류한다.
- **② 실행**:
  ```sh
  node --env-file=.env.local scripts/refund/preflight-portone-legacy.mjs
  ```
  레거시 `canceled` universe(paid→`pg_refunded_full`·unpaid→`local_only_canceled`) 양방향 exact 분류 + canceled+paid 건 PortOne 확정(CANCELLED/PARTIAL_CANCELLED) + cancellation ID 중복 0 + 로컬 pending 의 fresh GET 분류(PAID/CANCELLED/PARTIAL_CANCELLED/FAILED/READY/PENDING/VIRTUAL_ACCOUNT). 비공식 `PAY_PENDING→PENDING`·`VIRTUAL_ACCOUNT_ISSUED→VIRTUAL_ACCOUNT` 정규화. `scripts/refund/preflight-portone-legacy.json` 출력.
- **③ 합격 기준**: `unclear = 0` · `duplicate_cancellation_ids = 0` · pending 이 전부 종단(CANCELLED/FAILED) → exit 0. 알 수 없는 status·NOT_FOUND·진행형(READY/PENDING/VA)·늦은 PAID·PARTIAL 은 운영자 결정 대상.
- **④ 중단 조건**: blocker 1건 이상(임의 failed/canceled 확정 금지 — 운영자가 증빙으로 해결 후 재실행). PortOne 검증 대상(canceled+paid 또는 pending)이 있는데 `PORTONE_V2_API_SECRET` 미설정이면 `portone_unconfigured` blocker.
- **⑤ 판단**: 0062 미적용. 운영자 해결 → 재실행(fix-forward).
- **⑥ 증거**: `preflight-portone-legacy.json`(manifest_hash · 버킷별 분류 · portone_confirm · pending 분류 · blockers).

### 스텝 5 — 레거시 유료 잔액 재구성 manifest 생성·서명·hash (§24·§25·§26)

- **① 목적**: 주문별 유료 크레딧 잔액을 **유일하게** 재구성해 lot 백필 근거를 확정한다(추정 금지).
- **② 실행**:
  ```sh
  node --env-file=.env.local scripts/refund/paid-credit-allocation-manifest.mjs
  ```
  `buildAllocationManifest` 가 주문별 `delivered / proven consumed / proven refunded / remaining paid / evidence source·hash / confirmed_by` 를 산출하고, user 별 `Σ(proven remaining paid) + proven free = gen_credits` 등식을 검증한다. header(§25 — hash·row_count·generated_at·source_env·script_version)는 0-row 여도 1행 유효. safe-stage cast(§26 — `asInt/asUuid/asStr/asTimestamp` 로 malformed 격리).
- **③ 합격 기준**: 유일 재구성 성공(`ok:true`)·`row_count = detail count`. non-canceled paid remaining→purchase lot·canceled-paid→expired purchase lot·증명된 free→`legacy_free`.
- **④ 중단 조건**: 유일 증명 불가 1건이라도 → exit nonzero(균등분배·최신우선·전량 free·전량 consumed 추정 금지). 스텝 4 preflight 도 이 manifest 를 embed 검증한다.
- **⑤ 판단**: 0062 미적용. 증빙 확정 후 재생성(fix-forward).
- **⑥ 증거**: allocation manifest(header.manifest_hash) — 스텝 4 preflight manifest 의 `allocation_hash` 로 상호 봉인.

### 스텝 6 — unclear 1건이라도 중단 (게이트)

- **① 목적**: 스텝 3~5 중 하나라도 미해결이면 컷오버를 진행하지 않는다.
- **② 실행**: 스텝 3~5 의 exit code + 세 manifest 의 blocker/unclear/unproven count 합산 확인.
- **③ 합격 기준**: drain open_total 0 · preflight blocker 0 · allocation unproven 0 전부 충족.
- **④ 중단 조건**: 위 중 하나라도 > 0 → **0062 트랜잭션 시작 자체 없음**(DB 무변경). `reconciliation_issues` 로 우회하지 않는다 — 운영자 증빙 확정 후 manifest 재생성이 유일 경로.
- **⑤ 판단**: rollback 대상 없음(아직 아무것도 적용 안 함). 해결 후 스텝 3 부터 재진입.
- **⑥ 증거**: 세 manifest 의 최종 hash + go/no-go 판정 메모.

### 스텝 7 — pgcrypto 선행(P0, 잠금 밖) + 0062 additive 적용 (§12.1·A.7 S0~S12)

- **① 목적**: 해시 구현 전제(pgcrypto)를 orders EXCLUSIVE LOCK **밖**에서 선설치한 뒤, 0062 를 단일 트랜잭션으로 적용한다.
- **② 실행**:
  ```sh
  # P0 — 별도 query(0062 트랜잭션 밖). CREATE EXTENSION 을 orders 잠금 구간에 넣지 않는다.
  curl -sS -X POST \
    "https://api.supabase.com/v1/projects/${BOSS_PAEGI_SUPABASE_PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${BOSS_PAEGI_SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"query":"create extension if not exists pgcrypto with schema extensions;"}'

  # 0062 본 파일 전문(단일 트랜잭션 S0~S12).
  sbq supabase/migrations/0062_credit_lots_refund_saga.sql
  ```
  파일 내부 순서: **S0** 금융 5테이블 EXCLUSIVE LOCK → helper H1~H4(`bp_sha256_hex`·`bp_canonical_json`·`bp_versioned_hash`·`jsonb_has_sensitive_key`) → **S1** `uq_orders_uuid_user` → **S2** 신규 9테이블 → **S3** `credit_ledger`/`admin_actions_ledger` 확장 → **S5** orders/ai 컬럼 → **S6** manifest 임시 테이블 + preflight(**P10 이 `extensions.digest` 존재만 assert** — 설치 아님) → **S7** canceled-paid 백필 → S8 검증 → S10 금융 트리거 활성화 → **S11** 함수 ACL grant/revoke → **S12** postflight(Q1~Q19) → journal insert → `commit` → `notify pgrst`.
- **③ 합격 기준**: 트랜잭션 commit 성공. `schema_migration_journal` 에 `0062_credit_lots_refund_saga` 행 생성. S6 preflight·S12 postflight 의 어떤 `raise exception` 도 발생하지 않음.
- **④ 중단 조건**: S6 preflight 실패(`preflight_P10_pgcrypto_schema` 등)·S12 postflight 실패(Q1~Q19 위반)·`lock_timeout` 초과 → 트랜잭션 전체 자동 롤백.
- **⑤ 판단**: 적용 중 실패는 자동 롤백(부분 적용 0) → 원인 교정 후 재실행. **적용 성공 후에는 schema rollback 금지**(fix-forward). 재실행 전 journal 확인(0.3).
- **⑥ 증거**: 0062 파일 SHA-256 · 적용 시작/종료 시각 · journal 행(applied_at) · commit 응답.

### 스텝 8 — 0062 postflight 확인 (Q1~Q19)

- **① 목적**: 컷오버 직후 봉투 불변식을 재확인한다(S12 가 트랜잭션 내에서 이미 강제했으나 결과를 증거로 남긴다).
- **② 실행**: S12 는 0062 트랜잭션의 일부라 실패 시 이미 롤백된다. 적용 후 별도로 상시 게이트에서 동일 항목을 재확인(스텝 17 의 부분집합)하거나 `post-0062-go-no-go.sql` 의 대응 게이트(G-1~G-13·G-30·G-33·G-43)를 실행한다.
- **③ 합격 기준**: Q1(캐시≡Σlive)·Q2(reserved≡Σopen)·Q3/Q4(refunded 분해)·Q5(shortfall≤consumed)·Q6(canceled-paid live 0)·Q7(open 0)·Q10(cross-user 0)·Q11(중복 원장 0)·Q12(시각 CHECK 0)·Q13(권한 leak 0)·Q14(strict CHECK validated)·Q16(open issue 0) 전부 통과.
- **④ 중단 조건**: 이미 적용된 상태에서 재확인 위반 발견 → 데이터 정합 조사(운영자). money movement 전이므로 아직 fix-forward 여지 큼.
- **⑤ 판단**: 위반 원인이 백필 로직이면 데이터 교정(0062 자체는 additive 라 유지). destructive rollback 금지.
- **⑥ 증거**: postflight 게이트 결과 스냅샷.

### 스텝 9 — v2 앱 배포 (closed 유지)

- **① 목적**: 모든 금융 write 를 0062 의 SECURITY DEFINER RPC 로 전환한 앱을 배포한다. **게이트는 계속 `closed`**.
- **② 실행**: P2~P9 코드(포트원 adapter·refund-saga·webhook/order-status/reconcile 직접 UPDATE 제거·refund-credits/resolve-* 라우트·fal/recovery v2 소비·환급·어드민 UI·account 표면) 배포. `logCreditEvent` best-effort 제거.
- **③ 합격 기준**: 빌드·타입체크 통과. 앱이 orders/member_accounts/ai_generations/credit_ledger/admin_actions_ledger 및 신규 9테이블에 직접 DML 하지 않음(RPC 경유).
- **④ 중단 조건**: 빌드 실패·타입 오류·직접 DML 잔존.
- **⑤ 판단**: 앱 배포는 되돌림 가능(schema 무관). 게이트 `closed` 유지.
- **⑥ 증거**: v2 commit SHA · 배포 URL.

### 스텝 10 — 신규 RPC 로 drain/reconcile (post-0062)

- **① 목적**: 0062 신규 객체 기준으로 남은 in-flight 를 종결한다.
- **② 실행**: reconcile 라우트(attempt 폴링·이벤트 대사 확장)·credit-expire·gen-recover 를 유효 `x-cron-secret` 으로 호출해 잔여 pending/attempt 를 수렴시킨다.
- **③ 합격 기준**: `post-0062-go-no-go.sql` 의 컷오버 항목(open attempt·building request 0)이 0 으로 수렴(0062 postflight Q7 과 동치).
- **④ 중단 조건**: 수렴 실패 → 원인(미귀속 event·stale attempt) 조사.
- **⑤ 판단**: fix-forward(reconcile 반복). PG 이동 attempt 는 destructive rollback 금지.
- **⑥ 증거**: reconcile 응답(`attemptsChecked·transitions·issuesOpened`) · drain count.

### 스텝 11 — build · SQL 게이트 parse · 해시 계약 테스트

- **① 목적**: 정적 검증(빌드·SQL parse·해시 golden 재현)을 통과한다.
- **② 실행**:
  ```sh
  npm run typecheck && npm run build
  node --test __tests__/refund/hash-contract.test.ts          # §10 해시 계약 (Node 24+ / Node 22 는 --experimental-strip-types)
  node --test __tests__/refund/saga.test.ts                    # §9·§27·§38·§7 계약면 (mock DB adapter)
  node scripts/refund/hash-golden-vectors.mjs --check          # goldens 최신 여부
  sbq scripts/refund/post-0062-go-no-go.sql                    # 48개 게이트 parse·execute (읽기 전용)
  # stub E2E — 라이브 PortOne 없이 취소 경로 구동:
  #   __tests__/refund/portone-stub.ts(PortOneStub)를 baseUrl 로 향하게 해 preflight GET → cancel POST 계약 검증.
  # pgTAP(DB 있을 때) — Part A 스키마/ACL + Part B RPC savepoint 픽스처:
  #   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/refund_saga.pgtap.sql   # (create extension if not exists pgtap; 선행)
  ```
- **③ 합격 기준**: 타입체크·빌드 성공. `hash-contract.test.ts`(8 golden 재현·base==key_order·delimiter 비이스케이프·timestamp UTC·UUID lowercase)·`saga.test.ts`(멱등 no_op/conflict·§38 전수 매핑·marker·PG body 3필드) pass. `--check` OK. 게이트 SQL 이 실 스키마에서 parse·execute(각 게이트 1행 `gate|violations|scope|detail`). DB 접속 가능 시 `refund_saga.pgtap.sql` 146 assertion pass.
- **④ 중단 조건**: 해시 재현 불일치(golden/canonical drift)·계약면 테스트 실패·게이트 SQL 또는 pgTAP 컴파일 실패(존재하지 않는 컬럼/함수 참조).
- **⑤ 판단**: 코드/게이트 수정 후 재실행(fix-forward).
- **⑥ 증거**: 테스트 출력 · `--check` 결과 · 게이트 실행 로그.

### 스텝 12 — direct DML 0 실측 (AST + 카탈로그, §17·§37)

- **① 목적**: 앱이 금융 테이블·컬럼에 직접 write 하지 않음을 CI·런타임 양쪽에서 확인한다.
- **② 실행**: `eslint-rules/no-direct-financial-write.js`(rule `no-direct-financial-write`)를 eslint config 에 등재해 lint. 카탈로그로 `has_table_privilege`/`has_column_privilege` 확인(스텝 17 의 G-43 이 담당).
- **③ 합격 기준**: eslint 위반 0(`directWrite`·`deniedCall`·`deniedRpc`·`notAllowlisted`·`dynamicRpc` 메시지 0). 금융/금융인접 컬럼 앱 직접 write 0.
- **④ 중단 조건**: 위반 1건 이상 → CI 실패(0063 이전에 반드시 0).
- **⑤ 판단**: 위반 호출부를 RPC 로 교체(fix-forward).
- **⑥ 증거**: eslint 리포트 · direct-write inventory(traceability.md 참조).

### 스텝 13 — 0063 hardening 적용 (§17·§21)

- **① 목적**: 0062 가 drain 을 위해 남겨둔 구코드 직접 DML grant 를 회수하고 구 함수를 fail-closed stub 으로 굳힌다(파괴적 단계).
- **② 실행**:
  ```sh
  sbq supabase/migrations/0063_write_hardening.sql
  ```
  S0 대상 3테이블 EXCLUSIVE LOCK → S1 orders/member_accounts/ai_generations `revoke all` 후 **§13 operational 컬럼만 exact-set 재부여**(orders: pg_status·raw·error_message / member_accounts: email / ai_generations: status·fail_reason·candidate_urls·fal_request_id·fal_request_ids·picked_doll_id·picked_index·cost_cents·role — refund_state·consent 계열은 회수) → S2 구 함수 3종 fail-closed stub(`mark_paid_and_grant(uuid,text,int,jsonb)`·`consume_gen_credit(uuid)`·`refund_gen_credit(uuid)` → RAISE P0001 + `revoke all`) → S4 postflight(H1~H7) → S5 journal.
- **③ 합격 기준**: commit 성공. S4 postflight 통과(H1 테이블 DML grant 0·H2 컬럼 UPDATE grant = operational exact set(초과·부족 양방향 0)·H3 SELECT 3개 유지·H4 anon/auth/PUBLIC DML 0·H5 stub 의 owner 외 EXECUTE 0·H6 keeper 존재·H7 keeper service_role EXECUTE 유지). journal 에 `0063_write_hardening` 행.
- **④ 중단 조건**: **전제 미충족 시 적용 금지** — v2 앱 배포·canary·direct DML 0 실측(스텝 9·12·15) 완료 전에는 적용하지 않는다(권한만 먼저 죄면 구 라우트 즉사). H1~H7 위반 시 자동 롤백.
- **⑤ 판단**: 데이터 무변경(권한·함수 본문만) → 문제 시 **0062 grant 재부여로 즉시 복구**(canary off). fix-forward 우선.
- **⑥ 증거**: 0063 SHA-256 · postflight `hardening postflight OK` notice · journal 행.

### 스텝 14 — hardening postflight · ACL probe

- **① 목적**: 0063 적용 후 함수 ACL/권한 최종 상태를 전수 검증한다.
- **② 실행**: `post-0062-go-no-go.sql` 의 G-31(함수 ACL/owner/definer/search_path VALUES manifest)·G-43(금융 direct DML 권한 leak, `has_table_privilege` probe 포함) 실행.
- **③ 합격 기준**: G-31 violations 0(external RPC 는 definer+owner+`search_path=''`+service_role EXECUTE·PUBLIC/anon/auth 누출 0 / internal core·helper·trigger EXECUTE 0 / 미예상 overload 0). G-43 violations 0(신규 12테이블 service_role SELECT-only·orders/member/ai service_role write 0).
- **④ 중단 조건**: G-31/G-43 violations > 0.
- **⑤ 판단**: ACL 위반은 grant/revoke 재적용으로 fix-forward.
- **⑥ 증거**: G-31·G-43 결과 행.

### 스텝 15 — canary (명시 ID)

- **① 목적**: 소수 실계정으로 신규 saga 를 검증한다.
- **② 실행**: `CREDITS_MAINTENANCE_MODE=canary` 로 전환하고, 사전 지정한 **canary 계정/주문 ID 목록**(배포 증거에 명시)에만 신규 진입을 허용한다. 나머지는 계속 차단.
- **③ 합격 기준**: canary 계정의 checkout→지급→소비→환불 흐름 정상. 봉투 불변식 위반 0.
- **④ 중단 조건**: canary 에서 불변식 위반·PG 오류 → **gate off(→open) 금지**. `canary`/`closed` 유지하고 reconcile 로 수렴.
- **⑤ 판단**: money movement 발생 시 destructive rollback 금지 — `admin_refund_replan_after_pg`·reconcile 로만 처리.
- **⑥ 증거**: canary ID 목록 · 각 흐름 결과 · Sentry 이벤트.

### 스텝 16 — 실제 purchase → lot → consume → refund E2E

- **① 목적**: 지급부터 부분환불까지 전 체인을 실 PortOne 로 검증한다.
- **② 실행**: canary 계정으로 실제 결제 → `mark_paid_and_grant`(purchase lot 생성) → `create_generation_and_consume`(소비) → `admin_refund_begin`→`mark_pg_requested`→`record_pg_result`→`commit`(부분취소). 필요 시 `switch_to_manual`·`resolve_external_cancellation` 경로도.
- **③ 합격 기준**: attempt saga 가 committed 로 종단·`credit_ledger` v2 원장 정확·`orders.refunded_credits`/`refunded_amount` 분해 일치(G-3/G-4)·shortfall 정합(G-5/G-12/G-13).
- **④ 중단 조건**: 체인 중 불변식 위반·`invariant_violation` RAISE.
- **⑤ 판단**: PG POST 후이므로 destructive rollback 금지. reconcile/replan 로 fix-forward.
- **⑥ 증거**: E2E 주문/attempt/cancellation ID · 원장 스냅샷.

### 스텝 17 — 전 go/no-go (G-1 ~ G-48)

- **① 목적**: 상시·컷오버 게이트 전체를 실측 통과한다.
- **② 실행**:
  ```sh
  sbq scripts/refund/post-0062-go-no-go.sql
  ```
- **③ 합격 기준**: G-1 ~ G-48 각 행의 `violations = 0`(scope 조건부 — 아래 §2 게이트 scope 표). 특히 봉투 불변식(G-1~G-13)·구조(G-14~G-29)·ACL/권한(G-31·G-43)·해시(G-44)·legal(G-46)·journal(G-48) 전부 0.
- **④ 중단 조건**: 어떤 게이트든 violations > 0 → NO-GO. 모든 게이트는 malformed JSON 에 abort 하지 않고 위반을 count 에 포함하므로, count>0 은 실제 위반이다.
- **⑤ 판단**: 게이트별 원인 조사·데이터/권한 fix-forward. money movement 후 destructive rollback 금지.
- **⑥ 증거**: 48개 게이트 결과 전체(gate|violations|scope|detail) — G-48 배포 증거의 핵심 입력.

### 스텝 18 — cron heartbeat · auth probe · Sentry alert 증거 (G-47·§29)

- **① 목적**: cron 2종과 경보 채널이 **실제로 동작**함을 증거로 남긴다("설정한다" 로 통과 불가).
- **② 실행**:
  - `credit-expire`(신규·일 1회): 유효 `x-cron-secret` POST → 200 + snake_case 응답(`{ok,expired_lots,iterations,done}` — sweep_expired(p_limit) 반복 drain), 무효 secret → 401 실측.
  - `reconcile`(5분 주기): refund-sweep 확장 경로 200 실측(`{ok,attemptsChecked,transitions,issuesOpened}`).
  - `ops_cron_heartbeat` RPC 가 두 job 의 `last_started_at`/`last_succeeded_at`/`last_failed_at` 기록.
  - 실패 alert test(의도적 실패 주입 → 경보 발화)·Sentry 이벤트 확인.
- **③ 합격 기준**: G-47 violations 0 — `ops_cron_heartbeats` 에 `reconcile`(성공 ≤15분)·`credit-expire`(성공 ≤26h) 행 존재·`last_succeeded_at` 최신. 중복 호출 멱등.
- **④ 중단 조건**: heartbeat 행 부재·미성공·SLA 초과.
- **⑤ 판단**: cron 설정 교정 후 재실행(fix-forward).
- **⑥ 증거**: cron probe 응답(200/401) · last-success timestamp · alert test 결과.
- **⑥-note (Sentry 경보 룰)**: `pay.refund_invariant_violation`(policy-cap RPC 의 `invariant_violation` RAISE)은 **issue 큐 항목이 아니다** — `reconciliation_issues` 나 어드민 경고 카드에 렌더하지 않고 **Sentry `pay.refund_invariant_violation` 경보로만** 보고한다. 이 이벤트가 실제 Sentry 에 생성·전달됨을 별도로 확인하고, 알림 룰(온콜 전파)이 이 fatal 을 즉시 통지하도록 등록한다. `pay.refund_attempt_outstanding`·`pay.late_paid` 도 동일하게 실 생성 확인.

### 스텝 19 — off (→ open)

- **① 목적**: 전 게이트·cron·Sentry 증거 통과 후 정상 운영으로 전환한다.
- **② 실행**: `CREDITS_MAINTENANCE_MODE=open`.
- **③ 합격 기준**: 스텝 17·18 전부 통과가 **선행 조건**. 전환 후 일반 사용자 흐름 정상.
- **④ 중단 조건**: 스텝 17·18 미통과 시 open 금지 — `closed`/`canary` 유지.
- **⑤ 판단**: 문제 발견 시 다시 `closed` 로(신규 진입 차단) 후 fix-forward.
- **⑥ 증거**: env 전이 타임라인 종료점(`open`).

### 스텝 20 — 안정화 후 0064 stub 제거 (§21·§30)

- **① 목적**: 충분한 안정화 기간 동안 구 함수 호출 0 을 확인한 뒤 fail-closed stub 을 물리적으로 제거한다.
- **② 실행**:
  ```sh
  sbq supabase/migrations/0064_legacy_stub_removal.sql
  ```
  `mark_paid_and_grant(uuid,text,int,jsonb)`·`consume_gen_credit(uuid)`·`refund_gen_credit(uuid)` drop + postflight(stub 소멸·keeper 존치) + journal.
- **③ 합격 기준**: 안정화 기간 동안 3 stub 호출 0(Sentry/로그). commit 성공·postflight 통과(`legacy stub removal OK`)·journal 에 `0064_legacy_stub_removal` 행. **canary 에는 미적용 가능**(§30 — phase manifest 는 after-0062/after-0063/after-0064 분리, 적용 여부는 로컬 glob 이 아니라 journal 기준).
- **④ 중단 조건**: stub 호출이 관측되면 제거 연기. postflight 위반 시 자동 롤백.
- **⑤ 판단**: **drop 은 되돌릴 수 없다** — 문제 시 fix-forward = 0062 정의 재적용(함수 재생성).
- **⑥ 증거**: 안정화 기간 stub 호출 0 로그 · 0064 SHA-256 · journal 행.

### 스텝 21 — 0064 직전 전 게이트 재실행

- **① 목적**: 되돌릴 수 없는 drop 직전 최종 안전 확인.
- **② 실행**: 스텝 20 **직전**에 `sbq scripts/refund/post-0062-go-no-go.sql` 재실행(순서상 스텝 20 의 선행 게이트).
- **③ 합격 기준**: G-1~G-48 violations 0(스텝 17 과 동일 기준).
- **④ 중단 조건**: 위반 1건이라도 → 0064 미적용.
- **⑤ 판단**: 위반 해소(fix-forward) 후에만 0064 진행.
- **⑥ 증거**: 재실행 게이트 결과(0064 배포 증거에 첨부).

---

## 2. 게이트 scope 참조 (합격 기준 조건)

`post-0062-go-no-go.sql` 각 게이트는 `scope` 열로 적용 시점을 구분한다. `violations=0` 판정은 scope 를 고려한다.

| scope | 의미 | 언제 0 이어야 하나 |
|---|---|---|
| `structural` | 스키마·데이터 구조 불변식 | 항상 |
| `normal+cutover` | 금융 봉투/데이터 불변식 | 항상(상시·컷오버) |
| `cutover` | 컷오버 시점 잔존 0 | 컷오버·0063 직전(예: G-48 journal 존재) |
| `cutover/normal` | ACL/권한 | 0063 적용 후 clean(G-31·G-43) |
| `live` | cron 실가동 후 SLA | cron 가동 후에만(G-47) |

- 컷오버 전용 "open 잔존 0"(open attempt·building request)은 0062 postflight **Q7·Q16** 이 담당(게이트 파일 아님).
- 상시 운영의 unmatched REQUESTED 는 즉시 no-go 가 아니라 age 기반 경보(3시간)로 분리한다. 컷오버·0063 직전에만 `origin='live' and resolution_state='unmatched'` 전 상태 0 을 강제한다.

---

## 3. 배포 증거 단일 산출물 (G-48 입력)

아래를 하나의 배포 증거 파일로 수집한다. 이것이 G-48(migration/build/deploy artifact checksum)의 입력이다:

- `CREDITS_MAINTENANCE_MODE` 전이 타임라인(`open→closed→canary→open` 각 시각).
- canary 계정/주문 ID 목록(스텝 15).
- 세 preflight manifest hash: `pre-0062-drain.json`·`preflight-portone-legacy.json`·allocation manifest.
- 마이그레이션 파일 SHA-256: `0062_credit_lots_refund_saga.sql`·`0063_write_hardening.sql`·`0064_legacy_stub_removal.sql`.
- 각 마이그레이션 시작/종료 시각 + `schema_migration_journal` 행(applied_at).
- preflight count(스텝 3~5 각 0 실측치)·drain count(스텝 10).
- postflight 결과: 0062 Q1~Q19 + `post-0062-go-no-go.sql` G-1~G-48(스텝 17·21).
- v2 앱 commit SHA(스텝 9) + repo baseline `86fba4ce99deeffe63fc33ff4f80d8a9ce3d504c`.
- cron probe 결과(스텝 18, 200/401)·last-success timestamp·alert test 결과·Sentry 이벤트 확인.

---

## 4. 미실행 검증 (runtime-unverified)

이 runbook 은 authoring 환경에서 **실행되지 않았다**. 아래는 배포자가 실 환경에서 충족해야 하는 필수 실행 조건이며, GO 의 선행이다(§46 PRODUCTION GO: NO):

- 0062·0063·0064 의 실 적용(라이브 DB) 및 트랜잭션 성공.
- `post-0062-go-no-go.sql` G-1~G-48 의 실 DB 실행 결과 violations 0.
- `supabase/tests/refund_saga.pgtap.sql` 146 assertion 의 실 DB 실행(pgTAP 확장 + 0062 적용 DB 필요).
- PortOne 실 GET/POST 를 통한 preflight·canary·E2E(스텝 4·15·16).
- cron `credit-expire`/`reconcile` 실 가동 + Sentry 경보 실 발화(스텝 18, G-47).

정적으로/mock 으로만 검증된 항목: 마이그레이션·게이트 SQL·pgTAP 의 parse, `hash-contract.test.ts`(Node 실행·golden 재현), `saga.test.ts`(mock DB 계약면), `portone-stub.ts`(wire stub), `hash-golden-vectors.mjs --check`.
