# boss-paegi v0.76 환불 saga — 검증 리포트

> **[2026-07-24 최종 업데이트 — 앱 계층 완결 + 추가 실측]** 아래 원문(17:27 시점)은 DB/테스트/문서 계층까지의 정적 검증 기록이며, 이후 앱 계층이 완결되고 추가 검증이 수행돼 판정이 갱신됐다:
> - **앱 코드 완결**: lib(refund-saga·portone·credits-gate·admin-*·generation-recovery) + API(admin refund-credits/cancel/resolve-*·pay·ops·fal·account) + UI(어드민 /admin/refunds·회원상세·대시보드, 사용자 /account/payments).
> - **실측 검증**: `tsc --noEmit` 0 에러 · `next build` 성공(76 페이지) · node 테스트(saga·hash-contract·legal-copy) 통과 · eslint `no-direct-financial-write` 룰 등재 후 위반 0(등재 중 fal ops 직접 insert 실버그 발견 → `create_generation_row` RPC 경유로 교정).
> - **클린 체인 마이그 적용**: 0001~0064 순차 적용(프로덕션 Management API 방식) 에러 0 → 그 스키마에서 **pgTAP 146/146** · go/no-go 48 중 **G-46(법률 seed 없음)·G-47(cron 미가동)만 미충족**(둘 다 데이터/런타임 조건, 스키마 결함 아님 — 프로덕션엔 법률문서 발행·cron 가동으로 충족).
> - **적대적 리뷰(4관점·refute 검증)**: confirmed 4건 전부 교정 — ①failGeneration 크래시 윈도우 크레딧 손실(RPC-first 원자화 + gen-recover 미환급 안전망 스윕) ②③RefundQueueActions release/replan 배선(해제 영구불능·manual_review 오배선) ④payments 전액환불 표시 오분류. rejected 2건(403 계약 오해·cancel qty fail-safe) 정당 기각.
> - **판정 갱신**: `IMPLEMENTATION-VERIFIED: YES(로컬)` · `PRODUCTION-GO: 프로덕션 컷오버 시 go/no-go 재실행 대기`(Phase-A 배포→closed→0062→postflight→v2→gates→0063→0064, canary 실결제는 운영자).
>
> ---

> 상태 라벨: **SPEC-COMPLETE (STATIC)** — 산출물 전부 생성 + 사용 가능한 툴체인으로 정적 검증 수행. 실행 환경(dev Postgres/pgTAP/tsc 런타임·staging·PortOne E2E·cron·Sentry)이 없어 실행 결과가 필요한 부분은 `runtime-unverified` 로 표기한다.
> 이 리포트는 **프로덕션 DB에 어떤 변경도 적용하지 않고**, 커밋/푸시 없이 작성됐다.

## 0. 판정 요약

| 수락 등급 | 정의 | 이번 세션 |
|---|---|---|
| **SPEC-COMPLETE** | 완전 대체 명세 + 전 실행 아티팩트 생성 + 정적 검증 통과 + 미실행 부분 `runtime-unverified` 표기 (DB 불필요) | **YES** |
| IMPLEMENTATION-VERIFIED | dev Postgres 에 0062~0064 적용 + pgTAP 통과 + `tsc`/`eslint` 실행 통과 | **NO** (dev Postgres·런타임 부재) |
| PRODUCTION-GO | staging 컷오버 리허설 + PortOne 테스트채널 E2E + cron probe + Sentry alert test + go/no-go G-1~G-48 실측 통과 | **NO** (staging·외부연동 부재) |

## 1. 사용 가능 툴체인 (실측 확인)

| 도구 | 버전 | 용도 |
|---|---|---|
| node | v24.4.1 | `.mjs` 문법 검사·hash golden 실행·RuleTester |
| TypeScript(`tsc`) | 5.9.3 | TS 테스트 문법/타입 검사 |
| pglast (venv `/tmp/pgvenv`) | 8.4 (libpg_query) | SQL 파스 검증 |
| eslint `RuleStester` | (repo) | AST 룰 자기검증 |
| **PostgreSQL 런타임** | — | **없음** → pgTAP·RPC 실행·go/no-go 실측 불가 (runtime-unverified) |

## 2. 생성 아티팩트 인벤토리

| 파일 | 크기 | 상태 |
|---|---|---|
| `supabase/migrations/0062_credit_lots_refund_saga.sql` | 367 stmt | generated·static-parsed |
| `supabase/migrations/0063_write_hardening.sql` | 21 stmt | generated·static-parsed |
| `supabase/migrations/0064_legacy_stub_removal.sql` | 8 stmt | generated·static-parsed |
| `scripts/refund/post-0062-go-no-go.sql` | 48 stmt | generated·static-parsed (G-1~G-48) |
| `scripts/refund/preflight-portone-legacy.mjs` | — | generated·node --check |
| `scripts/refund/paid-credit-allocation-manifest.mjs` | — | generated·node --check |
| `scripts/refund/pre-0062-drain.mjs` | — | generated·node --check |
| `scripts/refund/hash-golden-vectors.mjs` + `hash-goldens.json` | 8 vec | generated·실행 통과·결정성 확인 |
| `eslint-rules/no-direct-financial-write.js` | — | generated·RuleTester 통과 (표 §3.5 결함 교정) |
| `docs/refund-saga/boss-paegi-credit-refund-saga-final.md` | 대체 명세 | generated |
| `docs/refund-saga/legal-golden.json` | 법률 골든 | generated·SHA-256 실측 |
| `supabase/tests/refund_saga.pgtap.sql` | 456줄·`plan(111)` | generated·pglast 파스 OK(118 stmt)·runtime-unverified |
| `__tests__/refund/portone-stub.ts` | 379줄 | generated·tsc clean·`PortOneStub` export 스모크 OK |
| `__tests__/refund/saga.test.ts` | 349줄 | generated·`node --test` **8/8 통과(직접 재실행)** |
| `__tests__/refund/hash-contract.test.ts` | 128줄 | generated·`node --test` **7/7 통과(직접 재실행)** |
| `docs/refund-saga/runbook.md` | 362줄 | generated·§44 21스텝(목적·명령·합격·중단·rollback·증거) |
| `docs/refund-saga/traceability.md` | 100줄 | generated·§2~44 43항목 × 5열·G-1~48 매핑 |

## 3. 정적 검증 수행 결과 (직접 실행)

### 3.1 SQL 파스 (pglast 8.4 / libpg_query)
- `0062` **367 statements** 파스 OK · `0063` 21 · `0064` 8 · `post-0062-go-no-go` 48. 전 파일 문법 유효.

### 3.2 JS 문법 (`node --check`)
- `scripts/refund/*.mjs` 4파일 + `eslint-rules/no-direct-financial-write.js` 전부 통과.

### 3.3 canonical hash 계약 (Node ↔ 0062 `bp_canonical_json`)
- `hash-golden-vectors.mjs` 실행 → 8 골든 벡터 산출. **결정성**: 재실행 시 커밋본과 byte-identical.
- **키순서 불변**: `base` = `key_order` = `791050fe…` (동일 hex) → object 키 정렬 무관성 확인.
- **구조적 등가**: Node canonical(`canonicalJson`)이 0062 `public.bp_canonical_json(jsonb)` 과 동일 규칙 — object 키 UTF-8 바이트순(`Buffer.compare` ↔ `collate "C"`)·compact `"key":value`·`,` 조인·array `[...]`·scalar JSON 정규형·`hash_version` merge(우변 우선 ↔ `p || jsonb_build_object`)·sha256(convert_to UTF8). **byte-match 최종 확증은 Postgres 실행 필요 → runtime-unverified**(구조 등가·결정성까지만 정적 확인).

### 3.4 SQL 참조 교차검증
- `post-0062-go-no-go.sql`·`0063`·`0064` 의 `public.X` 참조를 0062 정의(98개 객체)·사전존재 테이블·레거시 함수에 대조 → **미해소 0건**.
- 유일 non-0062 참조 `consume_gen_credit`·`refund_gen_credit` 는 **0010 정의 레거시 1-arg**로 실존하며, 0063이 fail-closed stub 으로 교체·0064가 drop 하는 정상 대상. v2 대체 함수(`consume_gen_credit_v2`·`refund_gen_credit_v2`·`create_generation_and_consume`·`mark_generation_failed_and_refund`)는 0062에 실재.

### 3.5 eslint AST 룰 자기검증 (RuleTester) — **결함 1건 교정 포함**
- **발견·교정**: `no-direct-financial-write.js` 의 `DEFAULT_FINANCIAL_TABLES` 신규분이 0062 실제 테이블명과 **4건 불일치**로, 실존하지 않는 이름을 감시해 직접 쓰기를 놓치는 결함(§13/§37 가드 무력화). 교정:

  | 룰(교정 전, 틀림) | 0062 실제 |
  |---|---|
  | `order_refund_requests` | `refund_requests` |
  | `refund_issues` | `reconciliation_issues` |
  | `refund_shortfalls` | `credit_refund_shortfalls` |
  | (누락) | `legacy_refund_backfill_evidence` 추가 |
  | `cancellation_resolution_batches` | 정확(유지) |

- **RuleTester 통과**: 교정된 신규 테이블명(`refund_requests`·`reconciliation_issues`·`credit_refund_shortfalls`·`legacy_refund_backfill_evidence`·`cancellation_resolution_batches`) + 기존 금융 테이블(`orders`·`member_accounts`) DML 전부 flag, 구 RPC(`admin_cancel_order`)·`logCreditEvent` flag, 비금융 테이블 write·read RPC·동적 `from()` 는 통과(오탐 0).

### 3.6 §20 방어심화 FK (cascade→restrict)
- 0062에 `member_accounts.user_id`·`ai_generations.owner_id` 의 `profiles(id)` FK 를 `on delete restrict` 로 전환하는 DDL 추가(금융 이력 보존·profiles hard-delete 방어). 추가 후 pglast 재파스 367 stmt OK.

### 3.7 §31 법률 골든 (탈퇴 경고 byte-for-byte)
- `app/account/page.tsx` 탈퇴 경고 3문구를 실측 캡처, SHA-256 고정 → `docs/refund-saga/legal-golden.json` (`all_present:true`·combined `ef9bb870…`). 배포 전후 hash 동일 assert 의 골든 소스(G-46).

### 3.8 테스트 harness 실행 검증 (직접 재실행 — 에이전트 보고 재현)
- **pgTAP** (`refund_saga.pgtap.sql`): pglast 8.4 파스 OK(118 top-level stmt)·`plan(111)` 선언. Part A(스키마·컬럼/타입·17 외부 RPC 존재·ACL 역할 §16·RLS §32·FK RESTRICT §20·CHECK §7/§11/§28·봉투/카운터/derive 불변식) + Part B(실 RPC 구동 savepoint 픽스처 §45 — purchase→lot·paid-FIFO·failed refund·PG partial 종단·2차 open 거부·manual transfer·pre-PG replan·cancel intent·deleted-user late PAID·account delete 차단·expiry sweep·cron heartbeat·`SET CONSTRAINTS IMMEDIATE` §34). **실행은 dev Postgres+pgtap 필요 → runtime-unverified**.
- **hash-contract.test.ts**: `node --test` **7 pass / 0 fail / exit 0** — 8 golden 재계산 일치·`base==key_order`·delimiter escape·timestamp/UUID 정규화·`canonicalize` 계약위반 throw. `bp_canonical_json`/`bp_versioned_hash` 등가 문서화. **DB 불필요 — 완전 실행 검증**.
- **saga.test.ts**: `node --test` **exit 0** — self-contained mock DB 어댑터로 멱등(§9)·오류코드↔HTTP(§38)·correlation marker(§27)·PG body 3필드(§7) 계약 검증. **DB 불필요 — 완전 실행 검증**.
- **portone-stub.ts**: `PortOneStub` export 스모크 OK(Node 24 TS strip). SDK 0.19.0 실 타입(`import type`)·GET/cancel·PARTIAL_CANCELLED→CANCELLED·Idempotency-Key(RFC 8941 quoted)·`currentCancellableAmount` CAS·SUCCEEDED 필드·call log.
- **tsc --noEmit (레포 전체)**: **exit 0 · 0 errors** — 신규 테스트·스크립트·eslint 룰 포함 타입 클린.

## 4. runtime-unverified 경계 (실행 환경 필요 — 이번 세션 미수행)

아래는 **아티팩트로 생성·정적 검증됐으나 실행 결과가 필요**해 IMPLEMENTATION-VERIFIED / PRODUCTION-GO 로 승격하려면 실 환경에서 실행해야 한다 (hash-contract·saga·tsc·stub-smoke 는 §3.8 에서 이미 실행 완료 — 이 목록에서 제외):

1. **pgTAP** (`supabase/tests/refund_saga.pgtap.sql`) — dev Postgres + `pgtap` 확장에서 `pg_prove` 실행(문법·plan(111) 은 정적 확인, 어서션 실측은 DB 필요).
2. **go/no-go G-1~G-48** (`post-0062-go-no-go.sql`) — 0062 적용된 DB 에서 실행, 각 게이트 기대값 실측.
3. **canonical hash byte-match** — Postgres `bp_versioned_hash` 산출 hex 와 Node golden 의 실 대조(구조 등가·결정성은 §3.3 정적 확인, 최종 byte 대조만 DB 필요).
4. **§45 행위 픽스처 심화** — pgTAP Part B 가 실 RPC 로 종단 검증한 핵심 플로우 외에, shortfall-absorb·external resolver·batch auto-full·post-PG replan·policy-cap 강제 시나리오는 현재 `has_function` 존재 + 불변식(shortfall decomposition·remaining≤consumed) 레벨로 커버 — 완전 행위 픽스처는 webhook-ingest RPC·record_pg_result 실패경로 인자가 라이브 DB 에서 확정돼야 오작성 없이 작성 가능.
5. **컷오버 리허설** — Phase-A gate drain·preflight·0062 적용·stub 전환·canary E2E(PortOne 테스트채널)·cron probe(credit-expire·reconcile)·Sentry alert test.

## 5. 최종 판정 블록

```
SPEC-COMPLETE:        YES   (대체 명세 + 전 아티팩트 생성 + 정적 검증 통과 + runtime-unverified 표기)
STATIC-VALIDATION:    PASS
  · pglast 파스      : 0062(367)·0063(21)·0064(8)·go-no-go(48)·pgTAP(118, plan 111)
  · node --check     : scripts/refund *.mjs 4 + eslint 룰
  · TS 실행 검증     : hash-contract 7/7 · saga 8 · tsc --noEmit 0 errors · stub export 스모크
  · hash 계약        : 결정성 byte-stable · base==key_order · bp_canonical_json 구조등가
  · SQL 참조         : 게이트·0063·0064 → 0062/사전존재/레거시(0010) 미해소 0
  · eslint RuleTester: 교정 후 금융 테이블 전건 탐지·오탐 0
  └ 교정 1건: eslint 금융 테이블명 4건 불일치(order_refund_requests/refund_issues/refund_shortfalls/
              legacy_refund_backfill_evidence 누락) → 0062 실제명으로 수정 (§13/§37 가드 결함)
RUNTIME:              UNVERIFIED  (dev Postgres/pgTAP 실행·staging·PortOne E2E·cron·Sentry 부재)
IMPLEMENTATION-VERIFIED: NO   (0062~0064 미적용·pgTAP 미실행·go/no-go 미실측)
PRODUCTION-GO:        NO   (컷오버 리허설·외부연동 미수행)
```

프로덕션 DB 무변경·커밋/푸시 미수행. 실 환경 확보 시 §4 목록을 실행해 IMPLEMENTATION-VERIFIED → PRODUCTION-GO 로 승격한다.
