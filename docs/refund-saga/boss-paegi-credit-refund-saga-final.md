# boss-paegi 크레딧 환불 saga — 대체 정본 명세 (v0.76, final)

```
status: generated / (SQL 참조는) statically-checked / runtime-unverified
scope: 크레딧 로트 원장 + 부분·다건 환불 saga + 외부 PG 취소 대사 + shortfall 추적 + 레거시 백필
repo-baseline: main @ 86fba4ce99deeffe63fc33ff4f80d8a9ce3d504c (PR #178 병합 후)
supersedes: 이전 rev(6,022줄 설계 명세)의 서술 전부
```

이 문서는 **구현 명세**다 — 아키텍처·계약·상태기계·정책·불변식·gate 목록을 서술하고, 구체 DDL·RPC·gate SQL·테스트는 **아래 정본 파일을 참조**한다(§0.2 파일 인덱스). SQL·함수 본문은 이 문서에 복사하지 않는다. 이름·시그니처·gate ID 는 정본 파일이 판단 기준이며, 이 문서의 서술은 정본 파일과 한 글자도 어긋나지 않게 대조되었다(0062 실측 대조 완료). 추적표(§18 요구)는 `docs/refund-saga/traceability.md`, 배포·장애 절차는 `docs/refund-saga/runbook.md`, 검증 수행/미실행 기록은 `docs/refund-saga/verification-report.md` 로 분리한다.

---

## 0. 정본·용어

### 0.1 상태 표기 규약

이 명세의 서술은 `status: generated`(사람이 작성한 설계 정본)다. 참조하는 SQL·스크립트는 파일 헤더에 각자의 상태를 명시한다: `0062`·`0063`·`0064`·`post-0062-go-no-go.sql`·`refund_saga.pgtap.sql` 은 static parse/typecheck 대상(`statically-checked`), 라이브 DB·PG 부재로 실행 검증은 `runtime-unverified`. `hash-golden-vectors.mjs` 는 Node 에서 실제 실행되어 golden 을 재계산하므로 `statically-verifiable`. 산출물이 아니라 실행 환경의 부재로 `runtime-unverified` 이며, 이는 §46 판정에서 `RUNTIME VALIDATION: UNVERIFIED` 로 명시된다.

### 0.2 정본 파일 인덱스

| 정본 파일 | 역할 | 상태 |
|---|---|---|
| `supabase/migrations/0062_credit_lots_refund_saga.sql` | additive 단계 — 신규 테이블·컬럼·FK·CHECK·index·helper·core·외부 RPC·레거시 백필·신규 테이블 RPC-only 권한·postflight(Q1~Q19)·journal | 존재(4,063줄) |
| `supabase/migrations/0063_write_hardening.sql` | 하드닝 단계 — 기존 orders/member_accounts/ai_generations/원장 direct DML revoke·legacy consume/refund fail-closed·구 RPC overload 차단·exact ACL·postflight | 정본 companion |
| `supabase/migrations/0064_legacy_stub_removal.sql` | 안정화 후 stub 제거 | 정본 companion |
| `scripts/refund/preflight-portone-legacy.mjs` | 0062 이전 PortOne·DB 레거시 preflight(§12.3·§23·§24·§25·§27) | 존재 |
| `scripts/refund/pre-0062-drain.mjs` | 0062 무참조 — 기존 테이블만 open money op 0 실측(§23·§14.1) | 존재 |
| `scripts/refund/paid-credit-allocation-manifest.mjs` | 레거시 유료 잔액 유일 재구성 증명(§24) | 존재 |
| `scripts/refund/hash-golden-vectors.mjs` | canonical hash 규약 Node 참조 구현 + golden 재계산(§10) | 존재 |
| `scripts/refund/hash-goldens.json` | literal payload → literal hex golden 벡터(8종) | 존재 |
| `scripts/refund/post-0062-go-no-go.sql` | **gate SQL 단일 정본**(§32) — G-30~G-48·상시/컷오버 기대값 분리 | 정본 companion |
| `supabase/tests/refund_saga.pgtap.sql` | 실행 가능 pgTAP | 정본 companion |
| `__tests__/refund/*.test.ts` (+ PortOne stub) | 실행 가능 TS 테스트 harness(§42) | 정본 companion |
| `docs/refund-saga/runbook.md` | 배포 순서·fix-forward·장애(§44 상세) | 정본 companion |
| `docs/refund-saga/traceability.md` | §2~§44 → DDL/RPC/API/test/gate 추적표(§18) | 정본 companion |
| `docs/refund-saga/verification-report.md` | 수행/미실행 검증 보고 | 정본 companion |

"정본 companion" = 이 명세와 같은 산출 세트의 정본 파일. 서술이 참조하는 이름·gate ID 는 해당 파일이 판단 기준이다.

### 0.3 용어(단일 어휘 — 1개념 1용어)

- **lot** (`credit_lots`) = 크레딧 부여 단위 1행. `qty`/`consumed`/`refunded`/`refund_reserved` 추적. `source ∈ purchase|signup_bonus|cs_grant|legacy_free`. purchase 는 주문당 1행(`uq_credit_lots_purchase_order`).
- **request** (`refund_requests`) = 환불 실행 단위. `id` = HTTP 클라 생성 멱등키. 상태는 attempts 집계의 완전 함수(`derive_refund_request_state`).
- **attempt** (`order_refund_attempts`) = 주문×로트 단위 환불 시도(saga 상태기계). `id` = DB 채번 + PortOne Idempotency-Key.
- **event** (`payment_cancellation_events`) = PG 취소 관측 원장 1행. `cancellation_id` = PK.
- **batch** (`cancellation_resolution_batches`) = system auto-full 전액 자동 종결 배치(§14).
- **issue** (`reconciliation_issues`) = 대사 이슈 큐(운영자 추적).
- **shortfall** (`credit_refund_shortfalls`) = 소비 후 환불된 미회수 수량.
- **cancel intent** = 주문당 active(비종단) 1건의 취소 의도 request(`origin='cancel_intent'`).
- **rail** = attempt 정산 경로. `portone_cancel`(PG 부분취소) | `manual_transfer`(수동 계좌이체).
- **correlation marker** = `BP_REFUND:<attempt-uuid>` — reason 에 삽입해 GET 만으로 attempt 자기 귀속(§27).
- **replan** = 기존 attempt 를 명시 release_reason 으로 종결한 뒤 **별도 새 request** 로 재계획. supersede/successor 컬럼·enum 없음.

관리자 판정 정본은 `member_accounts.is_admin`(단일 소스) — profiles 기반 판정을 새로 만들지 않는다.

---

## 1. 확정 정책

1. **환불율**: `paid_at + 7일` 이내 전액(`rate_bps=10000`), 이후 90%(`rate_bps=9000`). 정본 함수 `bp_refund_rate_bps(policy_as_of, paid_at)`. 수치는 약관 제10조 단일 소스 — 명세·FAQ 재기입 금지.
2. **환불 마감**: `refund_deadline = paid_at + 5년`. 로트 잔여 수량은 5y 이내에 한해 환불 대상.
3. **부분·다건 환불 1급 지원**: request 하나가 여러 attempt(로트별)로 분해되며 각 attempt 는 독립 saga.
4. **금융 write 는 SECURITY DEFINER RPC 만**. orders/member_accounts/ai_generations/credit_ledger/admin_actions_ledger 및 신규 9테이블은 `service_role` SELECT-only.
5. **fail-closed**: `paid_at` 미상은 `now()` 대체 없이 `paid_at_required`. 미인식 PortOne status 는 event 행을 만들지 않는다. 증빙 없는 reservation release 금지.
6. **`invariant_violation` 은 issue 큐 항목이 아니다** — 사후 불변식 위반은 전체 rollback + Sentry fatal 로만 보고(§15).
7. **탈퇴·법률 문구 byte-for-byte 유지**(§31). 동적 환불 안내는 하드코딩 법률 블록 **바깥** 별도 UI 노드로만 추가.
8. **판정 표기**: 이 산출물은 `implementation-ready`. "production certified"·"완벽 검증"·"배포 GO" 를 쓰지 않는다. 미실행 검증은 go/no-go 필수 실행 조건으로 남는다(§46).

---

## 2. 아키텍처 결정

- **로트 재모델링**: 크레딧을 "부여 단위(lot)"로 재모델링하고, `member_accounts.gen_credits` 캐시는 Σ live 로트 잔여의 파생값(불변식 1, Q1).
- **saga 원자화**: request→attempt saga 로 부분·다건 환불을 원자화. PG 취소는 관측 원장(`payment_cancellation_events`)으로 화해하고, 소비 후 환불분은 shortfall 장부로 추적.
- **request 상태 = attempts 파생**: request.state 는 직접 조작 대상이 아니라 `derive_refund_request_state(request_id)` 의 완전 함수. deferred constraint trigger `trg_refund_requests_state_derive`(attempts)·`trg_refund_requests_state_derive_self`(requests)가 트랜잭션 종료 시 저장값=파생값을 강제(§4.10·gate G-30).
- **복합 소유권**: 모든 금융 FK 는 `(id, order_uuid, user_id)` 계열 복합 유니크를 경유해 cross-user·cross-order 오염을 스키마로 차단(§4).
- **direct-write 차단**: 앱은 정본 RPC 절차만 호출. eslint/AST 규칙 + 카탈로그 gate 로 금융 테이블 직접 DML 을 CI·런타임 양쪽에서 0 유지(§17·§37·G-43).
- **3단계 배포**: 0062 additive → v2 앱(closed) → 0063 하드닝 → (안정화) 0064 stub 제거. 각 단계 rollback/fix-forward 경계 분리(§21·runbook).

---

## 3. 테이블 manifest (§35)

정확한 name list 가 서술 숫자보다 정본이다. 아래 manifest 는 RLS·grants·append-only/audit·ACL gate·JSON scan·function-reference manifest·테스트가 공용으로 참조한다.

### 3.1 신규 saga 테이블 9종 (RPC-only write · `service_role` SELECT · RLS enabled · pg_policies 0)

| 테이블 | PK | 역할 | 삭제/불변 트리거 |
|---|---|---|---|
| `credit_lots` | `id` | 로트 원장 | `credit_lots_guard`(불변·전이) · `bp_forbid_delete` |
| `refund_requests` | `id` | 환불 요청 | `refund_requests_guard` · `bp_forbid_delete` |
| `order_refund_attempts` | `id` | 환불 시도 saga | `refund_attempts_lifecycle`(INSERT/DELETE) · `refund_attempts_transition`(UPDATE) · `bp_forbid_delete` |
| `cancellation_resolution_batches` | `id` | auto-full 배치(§14) | `crb_guard`(INSERT 검증 + UPDATE/DELETE 전면 차단) |
| `payment_cancellation_events` | `cancellation_id` | PG 취소 관측 원장 | `cancellation_events_guard` · `bp_forbid_delete` |
| `reconciliation_issues` | `id` | 대사 이슈 큐 | `recon_issues_guard` · `bp_forbid_delete` |
| `credit_refund_shortfalls` | `id` | 미회수 소비분 | `shortfalls_guard` · `bp_forbid_delete` |
| `legacy_refund_backfill_evidence` | `id` | 레거시 백필 증빙(영구·frozen) | `legacy_evidence_freeze`(UPDATE/DELETE 전면 차단) |
| `ops_cron_heartbeats` | `job_name` | cron 심박(§29) | append(UPDATE는 audit만) |

### 3.2 확장 원장 2종 (append-only · `service_role` SELECT-only 로 회수)

| 테이블 | 확장 | append-only 가드 | INSERT 가드 |
|---|---|---|---|
| `credit_ledger` | `ref_attempt_id`·`ref_cancellation_id`·`ref_lot_id`·`metadata`·`schema_version` 추가 · `event_type` CHECK 8종 확장 | `ledger_append_only_guard`(UPDATE/DELETE 무조건 raise) | `credit_ledger_insert_guard`(§13) |
| `admin_actions_ledger` | `ref_attempt_id`·`ref_cancellation_id`·`payload_hash`·`payload_hash_version` 추가 · `order_amount` int→bigint · `action_type` CHECK 9종 확장 | `ledger_append_only_guard` | `admin_ledger_insert_guard`(§3·§4) |

### 3.3 기존 금융 테이블 3종 (0062 확장 → 0063 SELECT-only 잠금)

- `orders`: 금융/취소 컬럼 추가 · `uq_orders_uuid_user (order_uuid, user_id)` · strict CHECK `orders_canceled_paid_refunded_check`(NOT VALID→backfill→VALIDATE, Q14) · INSERT 가드 `orders_insert_guard` · 금융 스냅샷 트리거 `orders_financial_guard`(백필 UPDATE 종료 후 활성화).
- `member_accounts`: 캐시 정본(`gen_credits`). 직접 UPDATE 0(전부 RPC).
- `ai_generations`: `credit_lot_id`·`consumed_at`·`refunded_at`·`version`·`updated_at` + 감사 트리거 추가(§4.11·§19). `status ∈ queued|done|failed|picked`, 소유 컬럼명 `owner_id`.

### 3.4 인프라 테이블

- `schema_migration_journal`(§22, `version` PK) — 적용 사실 원자 기록. `service_role` SELECT-only.
- 전이(transient) manifest 테이블: `refund_backfill_manifest_header`(§25 header) + detail. 0062 트랜잭션 내부 검증·백필 소스.

**권한 gate 대상 9테이블**(Q13·G-43 privilege leak 0): `credit_lots`·`refund_requests`·`order_refund_attempts`·`payment_cancellation_events`·`reconciliation_issues`·`credit_refund_shortfalls`·`legacy_refund_backfill_evidence`·`credit_ledger`·`admin_actions_ledger`. 이들에 `anon`/`authenticated`/`PUBLIC` grant 0, `service_role` 는 SELECT 만.

정본: `0062` S2(신규 테이블)·S3(원장 확장)·S5(orders/ai 컬럼)·S12(postflight).

---

## 4. 복합 소유권 모델

cross-user·cross-order 오염을 스키마로 차단하기 위해 모든 금융 참조는 `(id, …, user_id)` 복합 유니크를 경유한다. 정본: `0062` S1·S2 의 named constraint.

- `orders`: `uq_orders_uuid_user (order_uuid, user_id)` — 신규 복합 FK 의 전제(S1, S2 전 필수).
- `credit_lots`: `uq_credit_lots_id_user`·`uq_credit_lots_id_order`·`uq_credit_lots_id_order_user` · FK `credit_lots_order_user_fkey (order_uuid, user_id) → orders`.
- `refund_requests`: `uq_refund_requests_id_user` · FK `refund_requests_scope_user_fkey (scope_order_uuid, user_id) → orders`.
- `order_refund_attempts`: FK `refund_attempts_request_user_fkey (request_id, user_id) → refund_requests(id, user_id)` · `refund_attempts_order_user_fkey (order_uuid, user_id) → orders` · `refund_attempts_lot_order_user_fkey (credit_lot_id, order_uuid, user_id) → credit_lots(id, order_uuid, user_id)` · `uq_refund_attempts_id_order`.
- `payment_cancellation_events`: `uq_cancellation_events_id_order (cancellation_id, order_uuid)` · FK `cancellation_events_matched_order_fkey (matched_attempt_id, order_uuid) → order_refund_attempts(id, order_uuid)` + 역방향 FK `refund_attempts_pg_cancel_fkey (pg_cancel_id, order_uuid) → events`.
- `reconciliation_issues`: FK `recon_issues_order_user_fkey (order_uuid, user_id) → orders` · `recon_issues_cancellation_order_fkey (cancellation_id, order_uuid) → events`(cancellation_id null 허용 — aggregate 형).
- `credit_refund_shortfalls`: FK `shortfalls_lot_order_fkey (lot_id, order_uuid) → credit_lots` · `shortfalls_attempt_order_fkey`·`shortfalls_cancellation_order_fkey`.
- `admin_actions_ledger`: FK `admin_ledger_attempt_order_fkey (ref_attempt_id, order_uuid) → attempts` · `admin_ledger_cancellation_order_fkey (ref_cancellation_id, order_uuid) → events`. metadata 내부 id 를 FK/유니크 대용으로 쓰지 않고 실 컬럼을 참조.

gate: G-33(복합 소유권 mismatch 0) · Q10(cross-user + lot↔order 정합 0).

---

## 5. attempt 상태기계 + phase 매트릭스 (§7)

정본: `order_refund_attempts` DDL(컬럼·커플링 CHECK) + 트리거 `refund_attempts_lifecycle`·`refund_attempts_transition`(`0062` A.3.3).

### 5.1 상태 8종

`prepared` · `pg_requested` · `pg_pending` · `pg_succeeded` · `manual_pending` · `manual_review` · `committed` · `released`.

open 집합(예약 유지·`uq_refund_attempts_order_open` 대상): `prepared`·`pg_requested`·`pg_pending`·`pg_succeeded`·`manual_pending`·`manual_review`. terminal: `committed`·`released`.

### 5.2 허용 전이 16종 (화이트리스트 — 그 외 `refund_attempts_bad_transition`)

```
prepared      → pg_requested | manual_pending | manual_review | released
pg_requested  → pg_pending | pg_succeeded | manual_pending | manual_review
pg_pending    → pg_succeeded | manual_pending | manual_review
manual_review → manual_pending | pg_requested | released
pg_succeeded  → committed
manual_pending→ committed
```

`released` 진입 origin·`release_reason` 커플링(트리거 2):
- `admin_cancelled_before_pg` ← `prepared` 발.
- `replanned_before_pg` | `replanned_before_pg_external` ← `prepared`|`manual_review` 발 & `pg_requested_at is null`.
- `replanned_after_pg_reconciliation` ← `manual_review` 발 & `pg_requested_at is not null`.

### 5.3 phase 매트릭스 (CHECK + 트리거로 강제되는 필드 존재)

PG request 묶음 = `{pg_requested_at, pg_request_body, pg_idempotency_key, preflight 5필드(pg_total_before·pg_cancelled_before·pg_cancellable_before·pg_cancellation_ids_before·pg_preflight_at)}`.

| phase | PG request 묶음 | 추가 불변식 |
|---|---|---|
| `prepared` / pre-PG `manual_review` / pre-PG `manual_pending`(direct) / pre-PG `released` | 전부 null | 예약만 존재 |
| `pg_requested`·`pg_pending`·`pg_succeeded` / post-PG `manual_review`·`manual_pending` / committed(portone) / post-PG released(reconciliation) | 전부 non-null | 각 phase 조건 |
| `pg_succeeded`·committed(PG) | — | `pg_cancel_id`·`pg_cancel_status='SUCCEEDED'` + matched SUCCEEDED event 필수 |
| manual committed | — | 경로별 all-null 또는 all-non-null(5필드) |

강제 규칙(트리거·CHECK): `pg_idempotency_key = id::text` · `pg_request_body` exact `{amount, reason, currentCancellableAmount}`(`amount=attempt.amount`·`reason`=marker 포함·`currentCancellableAmount=pg_cancellable_before`) · `pg_raw`/`cancellation_receipt_url`(HTTPS·≤2048 byte)/증빙 필드 set-once · manual 5필드(`external_payout_ref`·`paid_out_at`·`payout_evidence`·`manual_commit_payload_hash`·`manual_commit_reason`) committed 커플링 · rail 전이 단방향(`portone_cancel→manual_transfer`, `manual_pending` 진입 시만) · 무이동 증빙(`reconciliation_verified_at`·`reconciliation_result='no_movement'`·`observed_cancelled_amount`·`observed_cancellation_ids`·`verification_source ∈ pg_failed_response|admin_reconcile|resolver`·`evidence_hash`) 커플링 · committed 시 request 누계 재검증(qty/amount overrun 0) · `paid_out_at`/`expired_at`/시각은 `clock_timestamp()+5m` 상한.

gate: G-40(stale pre-PG attempt ↔ 외부 resolved 동시 reservation 0) · G-41(증빙 없는 post-PG released 0) · Q2(예약 불변식) · Q7(컷오버 open 0) · Q8(amount≤0 attempt 0).

---

## 6. PG saga · PortOne 계약 (§27)

정본: `0062` `admin_refund_mark_pg_requested`·`admin_refund_record_pg_result`·`admin_refund_commit`·`admin_refund_switch_to_manual` · `lib/portone.ts`(TS adapter) · 설치 SDK `@portone/server-sdk ^0.19.0`·`browser-sdk ^0.1.9`.

- **cancellation status**: `REQUESTED|SUCCEEDED|FAILED`(+Unrecognized). 부분취소 가능 payment status = `PAID|PARTIAL_CANCELLED`. 신규 POST 금지 status = `CANCELLED|FAILED|READY|PENDING|VIRTUAL_ACCOUNT_ISSUED|NOT_FOUND`. 비공식 `PAY_PENDING` 은 정규화에서 `PENDING` 으로 매핑.
- **cancel body**: exact 3필드 `{amount, reason, currentCancellableAmount}` — SDK `CancelPaymentBody` 실 필드. `currentCancellableAmount` 는 persisted `pg_cancellable_before`(PG-side CAS). `requester:"Admin"` 미전송(사용 시 공식 enum 만).
- **correlation marker**: GET cancellation 응답에 요청 Idempotency-Key 가 미노출되므로 `reason` 에 `BP_REFUND:<attempt-uuid>` 를 `slice(0,200)` 앞머리에 배치해 자기 귀속. marker·reason 은 PG 사유·영수증·고객 화면에 노출 가능하므로 중립 문구만.
- **Idempotency-Key**: `Idempotency-Key: "<attempt-uuid>"`(RFC 8941 quoted string — 따옴표 포함). timeout 재시도는 동일 key·동일 persisted body 로만.
- **3h cutoff**: 3h 는 PortOne 보장이 아니라 **boss-paegi 내부 보수적 retry cutoff**. 최초 POST 후 3h 내 동일 key·body 재시도만 허용, 3h 후 신규 POST 금지(GET/webhook 증빙만).
- **금액 검증**: JSON 금액은 nonnegative safe integer, `cancelled_total ≤ total`, `cancellable = currentCancellableAmount` 일치. SDK vs raw fetch 를 하나의 adapter 로 통일.
- **record_pg_result outcome**: `no_op`(동일 SUCCEEDED evidence 재호출) · `pending` · `pg_succeeded`(event SUCCEEDED+unmatched upsert → attempt.pg_cancel_id → event matched) · `manual_review`(failed → request blocked). 반환 shape 는 §9 멱등 계약.

---

## 7. 멱등 계약 통일 (§9)

정본: 각 RPC 본문 + `admin_actions_ledger.payload_hash`/`payload_hash_version` + `order_refund_attempts.manual_commit_payload_hash` + `refund_requests.payload_hash`. gate: G-38(v2 ledger 중복 0)·G-44.

**통일 규약** (RAISE 아님 — 정상 JSON):
- 동일 작업·동일 canonical payload 재호출 → `{ok:true, outcome:'no_op', idempotent:true}`.
- 동일 identity·다른 payload → `request_conflict`(409).
- terminal 상태의 exact replay 를 `invalid_state` 로 부르지 않는다. terminal 에 다른 작업을 시도만 `invalid_state`.

**비교 소스별**:
- release/switch/replan/cancel-intent/admin resolver → `admin_actions_ledger.payload_hash`(action별 유니크).
- manual commit → `manual_commit_payload_hash`(입력 = attempt id·external_payout_ref·paid_out_at·canonical payout evidence·reason).
- mark_pg_requested → 저장 body/preflight/key 비교.
- PG commit → 인자 없음. 이미 committed 면 no-op.
- PG result → 동일 SUCCEEDED evidence 재호출 no-op / 다른 id·amount·status conflict 또는 manual_review / pending 반복 no-op / 모순 결과 conflict.
- external resolver → immutable resolved qty/mappings 비교.
- intent resolve → 저장 order/event/result 비교.
- webhook/route 후착 → no-op.

create_pending_order·mark_paid_and_grant·consume/refund·mark_generation_failed_and_refund 도 동일 규약(동일 payment_id 재호출 = 기존 pending 반환, 소유자 상이 = conflict).

---

## 8. business block / RAISE 3분류 (§15)

정본: 각 RPC + `reconciliation_issues`(business block 저장) + §38 오류 manifest.

| 분류 | 조건 | 동작 |
|---|---|---|
| ① RAISE(기록 불필요) | 입력 변조·malformed·권한·CAS·snapshot 불일치 | RAISE(P0001) — 롤백, issue 미저장 |
| ② issue + 정상 JSON | 예상 금융 block(운영자 추적 필요) | `reconciliation_issues` 저장 + `{outcome:'blocked'|'manual_review', issueId}` 반환, RAISE 금지 |
| ③ RAISE + Sentry fatal | 사후 불변식 위반(수량 버리기 등) | 전체 rollback + `invariant_violation` RAISE + Sentry fatal, issue 저장 시도 안 함 |

재분류 대상(②가 아니라 각 지정 분류로): batch eligibility 실패 → ③ 또는 block · aggregate discrepancy → issue(가짜 event 금지) · unmatched → issue · replan 대기 → block · evidence movement → 허용 transition. `invariant_violation` 은 어드민 경고 카드·issue 목록 어디에도 렌더하지 않고 Sentry `pay.refund_invariant_violation` 로만 보고. 오류표·HTTP·테스트가 이 분류와 일치(§38).

---

## 9. policy-cap 산식 (§41)

정본: `bp_apply_attempt_commit` + `credit_ledger_insert_guard`(`refund_policy_close` metadata 검증) + Q18(=G-35). clamp 금지 — 산식이 균형을 이루지 못하면 ③ `invariant_violation`.

```
closure_qty                    = order.credits − refunded_credits(현재 attempt commit 후·closure 전)
recoverable_qty                = min(closure_qty, available)                 -- available = 로트 회수 여지
existing_shortfall_covered_qty = min(closure_qty − recoverable_qty, existing remaining shortfall coverage)
new_shortfall_qty              = closure_qty − recoverable_qty − existing_shortfall_covered_qty
```

등식 `closure_qty = recoverable_qty + existing_covered_qty + new_shortfall_qty`. 같은 트랜잭션에서 `new_shortfall_qty ≤ consumed − existing remaining shortfall` 검증. `refunded_credits` 만 closure 를 증가시키고 `refunded_amount` 는 0 증가. `refund_policy_close` metadata 7키 `{closure_qty, recovered_qty, shortfall_qty, lot_was_live, cache_effect_qty, rate_bps, refunded_amount_total}` 로 네 분해값 기록(`cache_effect_qty = recovered_qty if lot_was_live else 0`·`delta = −cache_effect_qty`). manual/PG 동일. 이후 shortfall absorb 로 재증가 금지.

---

## 10. credit_ledger event별 계약 (§13)

정본: `bp_credit_ledger_write`(정확 행 쓰기) + `credit_ledger_insert_guard`(BEFORE INSERT 독립 검증: v2 필수·PII·ref 배타·소유권·balance_after=현재 캐시·delta 부호·metadata 스키마). `schema_version=2`. gate: G-35·Q11·Q18·Q19. v1 행은 preflight orphan 검사 후 보존(`schema_version=1`).

event exact metadata 최소 `{lot_id, qty, lot_was_live, cache_effect_qty, balance_before, balance_after}`. event별 ref·delta 계약:

| event_type | ref | delta | 비고 |
|---|---|---|---|
| `refund_reserve` | attempt | `−cache_effect_qty`(≤0) | qty=attempt.qty |
| `refund_release` | attempt | `+cache_effect_qty`(≥0) | 예약 복원 |
| `refund_commit`(attempt) | attempt | `0` | attempt 확정 |
| `refund_commit`(external) | cancellation | `≤0` | metadata 4키 `{mapped_qty, immediate_recovered_qty, shortfall_qty, live_recovered_qty}`·`delta=−live_recovered_qty`·`mapped=immediate+shortfall` |
| `refund_policy_close` | attempt | `−cache_effect_qty` | §9 metadata 7키 |
| `expire` | lot | `≤0` | 제거된 미예약 live |
| `gen_consume` | gen | `≤0`(−1) | |
| `gen_refund` | gen | `≥0`(live +1/expired 0) | |
| `purchase` | order | `≥0`(+qty) | live +qty / quarantine 0 |

ref 배타(event별 정확히 하나의 ref 계열) + 소유권 FK/trigger(`credit_ledger.user_id` ↔ ref owner) 강제. v2 부분 유니크: reserve/settle/policy-close per attempt · external per cancellation · purchase per order · expire per lot · `(ref_gen_id, event_type)` where sv=2.

---

## 11. discrepancy 2타입 (§5)

정본: `reconciliation_issues.type='cancellation_discrepancy'` — `cancellation_id` 존재 여부로 2형 구분. gate: G-39(가짜 event 0)·Q17 계열.

- **event 형(cancellation_event_discrepancy)**: `cancellation_id NOT NULL` + FK `(cancellation_id, order_uuid) → events`. 기존 event 의 amount/status/order 재관측 불일치. detail 은 기존값·재관측값 exact schema.
- **aggregate 형(cancellation_aggregate_discrepancy)**: `cancellation_id NULL`. 신규 ID 없이 aggregate total 변화. **가짜 event 를 만들지 않는다** — issue + 정상 JSON 만. detail 은 이전 total·재관측 total.

open unique `uq_recon_issues_open (type, order_uuid, coalesce(cancellation_id,''))` — 두 형이 같은 주문에 공존 가능. resolver 조건·UI 라벨·테스트는 두 형을 분리 명시.

---

## 12. system auto-full batch (§14)

정본: `cancellation_resolution_batches` + `resolve_external_cancellation_auto_full(order_uuid)` + `crb_guard`. gate: G-42(batch 저장 pre-state eligibility).

`CANCELLED`(전액) 자동 종결만 batch 대상 — 수량 역산이 유일한 케이스(증빙된 전액취소·미지급). batch 는 pre-state 스냅샷을 불변 저장: `order_amount_snapshot`·`order_credits_snapshot`·`pre_refunded_amount`·`pre_refunded_credits`·`pre_committed_count`·`pre_legacy_contribution`·`had_cancel_intent`·`total_succeeded_amount`·`cancellation_projection`(allowlist `{cancellation_id, amount}` 배열)·`eligibility_result`·`eligibility_hash`/version·`resolved_at`. 성공 batch + events 는 같은 트랜잭션에서 `resolution_batch_id` 로 연결(`cancellation_events_batch_coupling_check`: batch 는 live·resolved·system 에만 부착).

**배분**: `floor(event.amount × credits / total)` · 잔여 credits 는 fractional 내림차순 → tie `requested_at asc` → `cancellation_id asc`. Σ event qty = credits, Σ amount = order.amount, Σ mapping = event qty.

**G-42 eligibility(batch pre-state)**: cancel_intent 존재 조건·pre-refunded 0·pre-committed 0·pre-legacy 0·quarantine 무소비/환불/예약·unknown/REQUESTED 0·SUCCEEDED 합=amount·결제/통화/채널/mode 일치·전액 종결. batch table 은 manifest·RLS·권한·append-only·ACL·테스트·gate 에 포함.

---

## 13. 금융 direct-write 차단 (§17) · 함수 ACL (§16)

정본: `0063_write_hardening.sql`(revoke) + `0062` S3/S12(원장 회수·Q13) + `.eslintrc` custom rule(§37) + `post-0062-go-no-go.sql` G-43. 앱측 전환 인벤토리(W1~W23)는 `docs/refund-saga/traceability.md`.

- **테이블 잠금**: orders·member_accounts·ai_generations·credit_ledger·admin_actions_ledger + 신규 9 = `service_role` SELECT-only. `revoke insert,update,delete`. 모든 write 는 definer RPC(create_pending_order·mark_paid_and_grant·member 생성/onboarding/email/consent·create_generation_and_consume·generation progress/done/picked·mark_generation_failed_and_refund·payment observation/failed/status·mark paid and grant/quarantine·reconcile update·account soft delete·환불 saga RPC).
- **operational 컬럼 예외**(0063 column-level grant — H2 postflight·G-43(c)·eslint 룰 `allowedUpdateColumns` 와 동일 allowlist): orders `pg_status`·`raw`·`error_message` / member_accounts `email` / ai_generations `status`·`fail_reason`·`candidate_urls`·`fal_request_id`·`fal_request_ids`·`picked_doll_id`·`picked_index`·`cost_cents`·`role`. 금융/금융인접(orders.status·canceled_at·paid_at·payment_id·pg_tx_id·amount·credits·refunded_*·cancel-intent·receipt·gen_credits·credit_lot_id·consumed_at·refunded_at·version)은 direct grant 금지 — orders.status 전이는 `mark_order_failed`/`mark_order_canceled_unpaid`/`mark_paid_and_grant`/resolver 가 유일 경로. `refund_state`·consent 계열은 0063 에서 회수(각각 legacy·definer RPC 경유).
- **함수 ACL manifest(§16·G-31)**: core/helper/trigger 전부 `revoke all … from PUBLIC, anon, authenticated, service_role`. 외부 RPC 만 정확 signature 에 `service_role` execute grant. G-31 은 prosrc regex 가 아니라 VALUES 기반 manifest(exact `to_regprocedure`·분류·owner·`prosecdef`·`search_path`·grant 여부·PUBLIC oid=0 ACL·anon/auth ACL) — 예상 함수 정확 1개·미예상 overload 0·외부 RPC definer/owner/`search_path=''`·core/helper/trigger 직접 execute 0·PUBLIC 누출 0.
- **AST direct-write 검사(§37)**: 지정 금융 테이블 `.insert/.update/.upsert/.delete` 금지·`rpc()` exact allowlist·`logCreditEvent`·구 consume/refund·구 admin cancel/refund·금융 컬럼 raw SQL 금지. CI 위반 실패.

### 13.1 외부 RPC 인벤토리 (정확 signature — `service_role` execute grant · 0062 실측 32-sig)

`create_pending_order` · `mark_paid_and_grant`(6-arg) · `create_generation_and_consume` · `mark_generation_failed_and_refund` · `create_generation_row`(ops 무소비 생성행 — 0063 이 ai_generations INSERT 를 회수하므로 RPC 경유) · `admin_refund_begin` · `admin_refund_mark_pg_requested` · `admin_refund_record_pg_result` · `admin_refund_commit` · `admin_refund_switch_to_manual` · `admin_refund_commit_manual` · `admin_refund_release` · `admin_refund_replan_pre_pg` · `admin_refund_replan_after_pg` · `cancel_intent_begin` · `cancel_intent_resolve` · `resolve_external_cancellation` · `resolve_external_cancellation_auto_full` · `admin_resolve_reconciliation_issue` · `record_payment_cancellation_observation`(외부 관측 이벤트 ingest — 웹훅/폴링/reconcile) · `mark_order_failed`(pending→failed 종단) · `mark_order_canceled_unpaid`(무결제 취소 관측 종단) · `create_or_update_member_consent`(v2 재정의 — 가입 보너스=signup_bonus 로트 원자, 불변식 1) · `admin_adjust_credits` · `admin_cancel_order`(5-arg + 4-arg wrapper — 무결제 로컬 취소 전용·paid 는 `use_refund_saga`) · `admin_soft_delete_account` · `sweep_expired` · `ops_cron_heartbeat` · `get_my_credits` · `get_admin_order_summary` · `admin_settle_stuck_order`.

core/helper(직접 execute 0): `bp_sha256_hex`·`bp_canonical_json`·`bp_versioned_hash`·`jsonb_has_sensitive_key`·`bp_refund_rate_bps`·`bp_refund_amount`·`bp_credit_ledger_write`·`bp_apply_attempt_commit`·`bp_apply_attempt_release`·`bp_apply_external_resolution`·`derive_refund_request_state`·**`consume_gen_credit_v2`·`refund_gen_credit_v2`(internal — 외부 표면은 `create_generation_and_consume`/`mark_generation_failed_and_refund`)** + 전 trigger 함수.

정확 signature 는 `0062` S11 의 `grant execute` 줄이 정본.

---

## 14. generation lifecycle 원자화 (§19)

정본: `create_generation_and_consume(p_user, p_role)` · `mark_generation_failed_and_refund(gen, reason, cost)` · `consume_gen_credit_v2(p_user, p_gen_id)` · `refund_gen_credit_v2(p_gen_id, p_expected_version)`.

- `create_generation_and_consume`: queued row + lot consume + 캐시 decrement + ledger 를 한 트랜잭션. owner/gen/lot 귀속. FAL 제출 전에 consume.
- `mark_generation_failed_and_refund`: failed + lot refund/shortfall absorb + ledger 한 트랜잭션.
- callback/recovery CAS(`version`) · 동일 gen consume/refund 각 1회 · done/picked 후 refund 금지 · 재환급 no-op. 멱등 정본은 DB — `ai_generations.refunded_at` 확인을 version conflict 검사보다 먼저. v2 generation 은 `lot.consumed` 대사. `legacy_consumed_baseline` 로트 보존. 앱측 `logCreditEvent` best-effort 관념 제거.

gate: Q10(cross-user/order) · Q11(gen v2 중복 0).

---

## 15. hard-delete 금융 보존 (§20)

정본: `0062`/`0063` FK `on delete restrict` + catalog gate `confdeltype='r'`.

`credit_lots.user_id → profiles(id) on delete restrict`. member_accounts·ai_generations 등 기존 cascade FK 를 RESTRICT 로 전환. orders + 신규 금융 테이블이 profiles hard-delete 를 차단해 전 금융 참조를 보존 — soft delete 만 정상 경로, hard delete 실수에도 금융 그래프 보존. gate: catalog `confdeltype='r'` 검증.

---

## 16. account delete (§39)

정본: `admin_soft_delete_account(p_user_id)`.

- open refund attempt/request → 409 · open unmatched/mandatory issue → 409.
- 의무 없으면 soft delete: live lots `account_deleted` quarantine · 캐시 0 + 원장 기록 · 금융 보존.
- 탈퇴 후 CS 환불은 quarantine purchase lot 로 가능 · 재활성 자동 부활 금지 · 약관/탈퇴 문구 불변(§31).

---

## 17. PAID / 탈퇴자 / 늦은 PAID 상태표 (§40)

정본: `mark_paid_and_grant`(6-arg — canceled 늦은 PAID·탈퇴자·cancel intent 분기와 `late_paid` issue 생성을 RPC 내부 구현) + `record_payment_cancellation_observation`(관측 ingest — 미귀속 SUCCEEDED 는 `unmatched_cancellation` issue·재관측 불일치는 event 형 `cancellation_discrepancy` issue) + `resolve_external_cancellation_auto_full`(전액 자동 종결 성공 시 orders `canceled` 전이 포함) + `reconciliation_issues`.

| 케이스 | 캐시/로트 | issue/intent |
|---|---|---|
| active PAID | purchase lot **live** 지급 + 캐시 +credits | — |
| deleted PAID | 0 지급 · quarantine purchase lot(`account_deleted`) | late-paid issue/intent |
| intent 후 PAID | 0 지급 · quarantine(`order_canceled`) | scoped request |
| organic late PAID(이미 canceled 주문에 PAID) | 0 · quarantine | `late_paid` issue만 |
| PARTIAL_CANCELLED | 기존 대사 후 신규 POST 판단 | — |
| CANCELLED | batch eligibility 만 auto-full(§14) | — |
| payment ID/amount/currency/channel/mode 불일치 | 자동 금지 | — |

`paid_at` 은 explicit → `p_raw.paid_at` → 둘 다 없으면 `paid_at_required`(now 대체 금지)·`clock_timestamp()+5m` 상한. canceled 유지 금지(strict CHECK 충돌) — late PAID 는 `status='paid'` 전환 + quarantine + issue. gate: Q6(canceled-paid live credit 0).

---

## 18. hash 버전화 (§10) · payout evidence PII (§11)

### 18.1 hash 버전화

정본(DB): `bp_sha256_hex`·`bp_canonical_json`·`bp_versioned_hash`(`0062` H1~H3). 정본(Node): `scripts/refund/hash-golden-vectors.mjs` + golden `hash-goldens.json`. gate: G-44(literal golden 재계산·version 일치)·G-46(golden manifest).

- 버전은 DB 컬럼으로 영속: `refund_requests.payload_hash_version`·`approved_plan_hash_version` · `order_refund_attempts.plan_hash_version`·`evidence_hash_version`·`manual_commit_payload_hash_version` · `admin_actions_ledger.payload_hash_version` · `cancellation_resolution_batches.eligibility_hash_version` · `legacy_refund_backfill_evidence.manifest_hash`.
- 모든 hash: lowercase 64-hex CHECK(`~ '^[0-9a-f]{64}$'`) · canonical payload 또는 재구성 가능 immutable 입력 보존 · Node/PostgreSQL 독립 구현이 **동일 golden** 통과.
- golden 은 대상 DB 계산값이 아니라 레포에 사람이 고정한 literal payload → literal hex 벡터(key order·whitespace·Unicode·timestamp·UUID·numeric boundary·delimiter 복수 vector). G-44 는 DB 함수와 Node 각각 같은 golden 을 실제 재계산해 version 일치를 검증한다.

### 18.2 payout evidence PII 허점 제거

정본: `refund_attempts_payout_evidence_check` CHECK + `jsonb_has_sensitive_key`(H4). gate: G-45(JSON size/PII 0).

`payout_evidence` = exact `{method:'bank_transfer', evidence_object_id:'<uuid>'}` 2키만. 접근통제 내부 저장소 식별자 — URL query/userinfo/외부 host/계좌/이름 저장 금지. `external_payout_ref` 는 opaque provider ref(`^[A-Za-z0-9._:-]{1,128}$`) 만. 금지 키 목록(snake/camel/정규화 변형 통일)은 `jsonb_has_sensitive_key` 본문. 전 금융 JSON 컬럼(§12 실 컬럼: attempts `pg_request_body`·`pg_raw`·`pg_cancellation_ids_before`·`observed_cancellation_ids`·`payout_evidence` / events `observed_raw`·`resolved_lot_mappings` / issues `detail` / ledgers `metadata` / legacy `cancellation_evidence`·`ledger_evidence` / batch·ops·action JSON)에 `octet_length ≤ 32768` size CHECK + 동일 helper PII scan.

---

## 19. URL / 문자열 / 시각 도메인 (§28)

정본: 각 테이블 CHECK + BEFORE 트리거(시각 상한). gate: Q12(=G-29, 테이블 CHECK 에 시각 함수 0).

- hash: 64 lowercase hex. payment/cancellation ID: nonempty byte cap. receipt URL: `^https://` + byte cap 2048 + set-once. external payout ref: opaque regex(case-sensitive). marker/reason: byte cap(5~500자).
- timestamp: 미래 입력 `+5m` 상한 · fresh snapshot 과거 10m ~ 미래 5m · **table CHECK 에 `now()`/`current_timestamp`/`clock_timestamp`/`localtimestamp` 금지**(상한은 BEFORE 트리거·RPC 만). `paid_at`/`granted_at`/`expires_at` 관계 CHECK(`expires_at > granted_at`). expected refunded snapshots ≤ order snapshots. `refund_deadline = paid_at + 5년`.

Q12(=G-29) 는 9 saga 테이블 + orders + ai_generations 의 CHECK 정의에 시각 함수가 없음을 catalog 로 검증.

---

## 20. ops heartbeat SLA (§29)

정본: `ops_cron_heartbeats`(job allowlist `credit-expire`·`reconcile`) + `ops_cron_heartbeat(p_job, p_phase, p_error_code)`. gate: G-47.

RPC-only write · `service_role` SELECT · anon/auth/PUBLIC 없음. 시작/성공/실패 기록(`last_started_at`·`last_succeeded_at`·`last_failed_at`·`last_error_code`·`run_count`). 중복 실행/stale lock 정책은 runbook.

**SLA**: reconcile 5분 주기 → 성공 ≤15분 · credit-expire 일 1회 → 성공 ≤26h. G-47 은 2시간 기준을 폐기하고 위 job별 SLA + last-success·alert 실행 증거를 검증(설정만으로 통과 불가).

---

## 21. legal copy golden (§31)

정본: `docs/refund-saga/traceability.md` 의 byte golden manifest + `__tests__/refund/*` legal hash 테스트. gate: G-46.

rg 한 줄 매치 금지. exact byte golden manifest(file path·byte range·안정 marker block) · SHA-256 literal 레포 고정 · DB published legal 도 canonical serialization hash 고정 · 현재 내용으로 golden 재생성 금지 · dynamic UI 는 immutable block 밖 · line number 를 정본으로 쓰지 않음. `app/account/page.tsx` 탈퇴 경고 블록(L211 포함)은 byte-for-byte 유지.

---

## 22. 오류코드 / HTTP manifest (§38)

정본: `post-0062-go-no-go.sql`(RAISE code 존재 검증) + TS `KNOWN_ADMIN_ERRORS` whitelist + `__tests__/refund/*`. 삭제된 alias/옛 코드(`payout_evidence_invalid`·`movement_detected`)는 코드·테스트·문서에서 제거.

| 상황 | HTTP | 예시 코드 | retryable | issue |
|---|---|---|---|---|
| conflict/CAS/idempotency | 409 | `request_conflict`·`payout_ref_duplicate` | no | — |
| not found | 404 | `attempt_not_found` | no | — |
| auth | 401/403 | (admin/cron) | no | — |
| malformed/business validation | 400 | `invalid_product`·`product_amount_mismatch`·`invalid_state`·`issue_not_open`·`evidence_invalid` | no | — |
| maintenance | 503 | `service_maintenance`·`portone_not_configured` | yes | — |
| business block + issue | 200 | `{outcome:'blocked'\|'manual_review', issueId}` | — | 저장 |
| invariant violation | 500 | `invariant_violation` | no | Sentry fatal(큐 아님) |

추가 코드: `paid_at_required`·`paid_at_future`·`account_deleted`. 모든 P0001 코드는 RPC 사용 ↔ whitelist 등재 양방향 대조. process 결과 enum(§10.1): `processed|pending|manual_pending|manual_review|blocked|review|completed|no_op`.

---

## 23. 3단계 마이그레이션 (§21) · migration journal (§22)

정본: `0062`(additive) · `0063`(hardening) · `0064`(stub removal) · `schema_migration_journal` · runbook.

### 23.1 3분리

- **0062 additive**: 신규 테이블/컬럼/FK/CHECK/index · 신규 RPC/helper · legacy backfill · 신규 테이블 RPC-only 권한. drain 경로를 깨는 revoke/stub 미적용 — 구코드 + v2 closed 공존. 적용 전제 = closed gate(신규 money 진입 차단)·open op 0 실측.
- **v2 앱(closed)**: closed 유지 · 모든 write 신규 RPC 전환 · legacy direct DML 0 · post-0062 drain/reconcile · build/test/E2E.
- **0063 hardening**: 기존 orders/member/ai/원장 direct DML revoke · legacy consume/refund fail-closed · 구 RPC overload 차단 · exact ACL · postflight.
- **canary → off**. **0064 stub 제거**(안정화 후).

각 단계 rollback/fix-forward 경계는 runbook. 0062 성공 후 schema rollback 금지(추가 위주라 공존) — closed 유지 fix-forward. PG POST 이후 destructive rollback 금지.

### 23.2 migration journal

`schema_migration_journal (version PK · migration_hash · manifest_hash · applied_at · app_commit · executed_by)`. 각 마이그 트랜잭션 끝에서 원자 기록(0062 는 S12 뒤 `on conflict do nothing`). 재호출 전: 같은 version+hash = 성공 판정 · 같은 version+다른 hash = 즉시 no-go · row 없으면 적용 · 응답 유실 시 journal 재조회. `lock_timeout`·`statement_timeout` 은 runbook. unknown commit 은 journal 확인 전 재실행 금지. gate: G-48(phase별 manifest — after 0062/0063/0064 · 적용 여부는 로컬 glob 이 아니라 journal·배포 증거 hash).

### 23.3 pre-0062 drain / post-0062 gate 분리 (§23)

- **pre-0062**(`pre-0062-drain.mjs`·`preflight-portone-legacy.mjs`): 기존 orders/member/ai/credit ledger/refund_state 만 참조 · 신규 0062 객체 무참조.
- **post-0062**(`post-0062-go-no-go.sql`): requests/attempts/events/issues/shortfalls.
- pending/virtual-account 는 로컬만 보지 않고 PortOne fresh GET 으로 분류(PAID/CANCELLED/PARTIAL_CANCELLED/FAILED/READY/PENDING/VIRTUAL_ACCOUNT) · 만료/취소 정책 · 운영자 결정 manifest · 임의 failed/canceled 금지 · 해결 불가 시 중단. 비공식 `PAY_PENDING` → `PENDING`.

### 23.4 레거시 잔액 재구성 증명 (§24·§25·§26)

`paid-credit-allocation-manifest.mjs` — 주문별 `order UUID/user·delivered·proven consumed·proven refunded·remaining paid·evidence source/hash·confirmed_by`. user별 `Σ(proven remaining paid) + proven free remaining = gen_credits`. non-canceled paid remaining 증명 → purchase lot · canceled-paid → expired purchase lot · 증명된 free 만 `legacy_free`. 유일 증명 불가 1건이면 exit nonzero(균등/최신우선/전량free/전량consumed 추정 금지). "현재 paid 잔액 0" 은 manifest + SQL 로 증명. header(§25) 는 0-row detail 도 1행 유효(hash·row count·generated at·source env·script version)·`row_count = detail count`. JSON cast(§26) 은 safe-stage CTE(jsonb_typeof → exact keys → type → range 검증 행만 cast)·malformed 는 mismatch count 포함.

---

## 24. gate 목록 (교차참조)

gate SQL 중복 금지 — `post-0062-go-no-go.sql` 이 단일 정본(§32). 이 문서는 gate ID·설명만 참조한다. 컷오버 전용 검증(Q1~Q19)은 `0062` S12 postflight 에 embed(적용 트랜잭션 실패 시 전체 롤백).

### 24.1 컷오버 postflight (0062 S12 — Q1~Q19)

| ID | 검증 | 동치 |
|---|---|---|
| Q1 | 캐시 ≡ Σ live 로트 잔여(불변식 1) | |
| Q2 | `lot.refund_reserved` ≡ Σ open attempts qty | |
| Q3/Q4 | `orders.refunded_credits`/`refunded_amount` 분해(committed attempt + resolved live event + policy_close + legacy evidence) | D1a/D1b |
| Q5 | per-lot Σ remaining_shortfall ≤ consumed | D2 |
| Q6 | canceled-paid live purchase credit 0 | 불변식 8 |
| Q7 | 컷오버 open attempt·building request 0 | |
| Q8 | amount≤0 attempt 0 | 불변식 9 |
| Q9 | legacy evidence 중복/hash split/live-event-on-legacy 0 | |
| Q10 | cross-user + lot↔order 정합 0 | G-33 |
| Q11 | 중복 원장 0(attempt 계열 + gen v2; v1 중복은 warning) | G-38 |
| Q12 | 테이블 CHECK 시각 함수 잔존 0 | **G-29** |
| Q13 | 권한 leak 0(anon/auth/PUBLIC·service_role non-SELECT) | G-43 |
| Q14 | strict CHECK `orders_canceled_paid_refunded_check` validated | |
| Q15 | 부분 유니크·핵심 인덱스 11종 존재 | |
| Q16 | open issue 0(컷오버 전용) | |
| Q17 | resolved 매핑 ↔ shortfall 장부 8단계(malformed 안전) | G-13·**G-34** |
| Q18 | `refund_policy_close` 등식(malformed 안전) | **G-35**(policy) |
| Q19 | external `refund_commit` metadata | **G-35**(외부취소) |

### 24.2 상시/컷오버 go/no-go (post-0062-go-no-go.sql — G-30~G-48)

각 gate 는 정상 운영용·컷오버/0063용 기대값을 분리(§16.2). 모든 gate 는 malformed JSON 에 abort 하지 않고 no-go count 를 반환. gate SQL 이 schema 에서 parse·execute 테스트.

| ID | 검증(정정 반영 §33) |
|---|---|
| G-30 | `request.state = derive` mismatch 0 |
| G-31 | 함수 ACL/owner/definer/`search_path=''`(VALUES manifest·PUBLIC oid=0·anon/auth·exact signature) |
| G-32 | RLS enabled · policy 0 |
| G-33 | 복합 소유권 mismatch 0 |
| G-34 | resolved mappings 구조/합계(Q17 정본) |
| G-35 | credit_ledger ref/delta/cache effect · `refund_commit` XOR + 나머지 ref null · cast 전 형식검증 |
| G-36 | admin ledger action/ref/actor/payload hash/metadata exact |
| G-37 | cancel intent 4필드 coupling |
| G-38 | v2 ledger 중복 0 |
| G-39 | aggregate discrepancy 가짜 event 0(event/aggregate 분리) |
| G-40 | stale pre-PG attempt ↔ 외부 resolved 동시 reservation 0 |
| G-41 | replan 증빙 없는 post-PG released 0 |
| G-42 | system auto-full batch pre-state eligibility mismatch 0 |
| G-43 | 금융 컬럼 direct DML 권한 leak 0(INSERT/UPDATE/DELETE table+column+실제 DML) |
| G-44 | canonical hash version 누락 0(literal golden 재계산·version 일치) |
| G-45 | JSON size/PII violation 0(실 컬럼·octet_length·동일 helper) |
| G-46 | legal copy hash mismatch 0(golden manifest) |
| G-47 | cron last-success/alert 증거 + job SLA(reconcile ≤15m·credit-expire ≤26h) |
| G-48 | migration/build/deploy artifact checksum(phase journal/hash) |

---

## 25. 배포 순서 (§44 요약 — 상세는 runbook)

`docs/refund-saga/runbook.md` 가 각 단계 실행명령·기대·중단지점·fix-forward·증거파일의 정본. 요약:

1. Phase-A gate-only(`CREDITS_MAINTENANCE_MODE` 도입) → 2. closed → 3. pre-0062 legacy drain(`pre-0062-drain.mjs`) → 4. PortOne pending 전수 분류(`preflight-portone-legacy.mjs`) → 5. paid allocation/refund manifest 생성·서명·hash(`paid-credit-allocation-manifest.mjs`) → 6. unclear 1건이라도 중단 → 7. 0062 additive 적용(P0 pgcrypto 선행) → 8. 0062 postflight(Q1~Q19) → 9. v2 앱(closed) → 10. 신규 RPC drain/reconcile → 11. build·SQL tests·stub E2E → 12. direct DML 0 실측 → 13. 0063 hardening → 14. hardening postflight·ACL probe → 15. canary IDs → 16. 실제 purchase→lot→consume→refund E2E → 17. 전 go/no-go(G-30~48) → 18. cron heartbeat·auth probe·Sentry alert 증거(G-47) → 19. off → 20. 안정화 후 0064 → 21. 0064 직전 전 gate 재실행.

배포 증거 단일 산출물(G-48 입력): env 전이 타임라인·canary ID·manifest hash·migration SHA-256·시작/종료 시각·preflight count·drain count·postflight 결과·commit SHA·cron probe·alert test 결과.

---

## 26. 판정 (§46)

- **SPEC-COMPLETE**: YES — 모순·미결정·누락 서술 0. 정본 파일 인덱스(§0.2) 완비.
- **STATIC VALIDATION**: 참조 SQL·스크립트는 static parse/typecheck 대상. 결과는 `docs/refund-saga/verification-report.md`.
- **RUNTIME VALIDATION**: UNVERIFIED — authoring 환경에 라이브 DB·PG 부재. §24 gate 는 필수 실행 조건으로 남는다.
- **PRODUCTION GO**: NO — §25 배포 순서의 전 go/no-go(G-30~48) + cron/Sentry 실행 증거(G-47) 통과가 GO 의 필수 선행.

이 문서는 `implementation-ready` 다. 실행 환경 부재는 SPEC-COMPLETE 를 낮추지 않는다.
