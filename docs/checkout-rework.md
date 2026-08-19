# Checkout 구조 재설계 (2026-08-19 결정)

2026-08-19 결제 사고 3건(문구 DB 계약 전면 차단·prior-intent 잠금·상품변경 fence 무정보 실패)의
사후 재설계. 사용자 결정: **누더기(우발 복잡성)를 전부 걷어내고 정당한 복잡성만 남긴다.
타협 없는 이상향. 모든 정상 시나리오에서 결제가 되고, 실패는 정확한 이유를 보인다.**

결정 기록(사용자 확정):
- 범위 = checkout 계열 전체(흐름·오류/문구 계약·CI). 환불 saga·크레딧 lot 회계 코어는
  검증된 금융 코어로 보존 — 새 계약(오류 카탈로그·copy registry)에 맞는 인터페이스 정리만.
- CI = 시대별 rollout 시뮬레이션 폐지, **최신 스키마 단일 검증**. 배포 순서(마이그 먼저)는
  운영 계약으로 문서화.
- 컷오버 = 성장레버 `creditsEnabled` 토글로 결제 몇 분 OFF 후 원자적 전환 허용.
- flaky 하네스 = 결정론적 재작성(폴링 → 명시적 동기화). rerun 관행 철폐 — flaky 재발은
  즉시 수정 대상.

## 지키는 것 — 정당한 복잡성 (불변식)

1. **서버 권위 가격**: price/credits/상품명은 언제나 서버 config(growth_levers active 상품)로만
   결정. 클라 입력은 결제 파라미터가 아니라 화면 표시의 fence.
2. **표시-결제 일치 증거**: 사용자가 본 offer 스냅샷(상품·가격·고지 문구)을 주문별로 박제
   (`commerce_display_evidence` + 주문의 evidence 참조 + 청약철회 수용 증거). 분쟁 대비 법적 증거.
3. **이중지급 방지·멱등**: 주문·지급·환불의 모든 금융 전이는 user-serialized RPC, 재호출 멱등.
4. **늦은 PAID 수렴**: 결제창이 언제 닫혔든, 웹훅/reconcile/redirect 폴링 중 무엇이 먼저 오든
   실제 돈이 들어온 주문은 지급된다(grant 는 미지급 canceled 에도 허용 — 0087 확립).
5. **실패는 정확한 이유**: 모든 거절 코드는 사용자 문구와 1:1. 미지의 실패도 코드를 숨기지 않는다.

## 걷어내는 것 — 우발 복잡성 (누더기)

| # | 누더기 | 대체 |
|---|---|---|
| N1 | 오류 처리 4계층 사전(RPC 문자열→refund-saga 매핑→route 분기→클라 문구) 수동 동기화 | **오류 카탈로그 단일 소스** + 등록 누락 CI 즉사 |
| N2 | 고지 문구 byte-exact 7중 복제(코드 상수·DB 함수 리터럴·테이블 CHECK·pgTAP·QA 셸 3벌, 시대별 유지) | **copy registry 해시 등록제** — 원본은 코드 상수 1곳, DB 는 (version, sha256) 등록만 검증. 픽스처 하드코딩 소멸 |
| N3 | route 사전 fence 와 RPC 재검증의 목적 중복(상품 스냅샷·offer 증거 이중 대조) | **RPC 단일 검증 계층** — route 는 인증/한도/파싱/서버 상품 확정만 |
| N4 | prior-intent 처리의 예외 기반 덧댐(예외→route 해석→별도 RPC 종단→재시도) | RPC 정상 반환으로 편입(needs_provider_resolution) — 흐름이 코드에 그대로 보임 |
| N5 | CI 시대별 rollout 시뮬레이션(마이그 단계 적용×시대별 QA — 픽스처 시대 유지 부담·CI 장시간) | **최신 스키마 단일 검증** |
| N6 | 타이밍 폴링 race 하네스(러너 속도 따라 확률적 실패) | advisory-lock/명시 동기화 기반 결정론적 하네스 |
| N7 | 클라 5xx/429 → unconfirmed 일괄 분류가 코드 분기를 죽임(`rate_limited`·`payment_unavailable`·503 계열 문구 도달 불가 + 429 에도 자동 재전송) | 상태코드 아닌 **응답 body 의 error 코드 기준** 분류 — unconfirmed 는 "body 없는/파싱 불가 5xx·transport"만 |
| N8 | RPC 성공 후 route 가 orders 를 별도 SELECT 로 재확인(사후조건 이중화 — RPC B19 18항목과 중복) | RPC receipt(사후조건 검증 통과분)를 단일 권위로 |

### 인벤토리 실측 확정 (2026-08-19)

- 오류 코드 규모: 마이그 raise 코드 502(결제 도메인 136) / refund-saga 매핑 83 / 클라 개별 문구 ~9.
  미매핑 79 중 다수는 트리거 불변식(fatal 의도 정당) — 카탈로그에 `severity` 로 구분해 수용.
  단 `invalid_payment_evidence_snapshot`(checkout 입력 형식 오류 — impl 1차 검증)·`order_status_changed`·
  `stale_cancel_lease`·`payment_pending` 등 **정상 거절인데 fatal 500** 인 것들이 섞여 있음 → 카탈로그로 교정.
- 매핑에 있으나 어떤 마이그도 raise 하지 않는 유령 코드 6개(`cancellation_ingest_failed`, `evidence_invalid`,
  `issue_not_open`, `malformed`, `payment_evidence_mismatch`, `payout_ref_duplicate`) → 계약 테스트가 양방향
  (raise⊆catalog, catalog 의 raise-유래 코드⊆raise) 검증으로 제거·재발 방지.
- 완전 중복 검증 6쌍 실측: withdrawal 문구(route 파서 ↔ 0104 B1), active 상품 조회(route #8 ↔ B11),
  goodname(#9 ↔ B4), offer evidence 전문(#12 ↔ B5–B7), payment_id 파생식(route ↔ B9), RPC 사후조건(route
  재SELECT ↔ B19). → C 단층화의 근거.
- prior-intent 자동 해소는 `checkout_prior_intent_unresolved`(1건 불일치)만이 아니라
  **`checkout_reuse_ambiguous`(미해결 2건 이상, B15)** 도 흡수해야 완전 — needs_provider_resolution
  정상 반환이 두 경우 모두 대체.

## 목표 아키텍처

### A. 오류 카탈로그 — `lib/pay/error-catalog.ts` (단일 소스)

```
PAY_ERROR_CATALOG: code → { status, message, action? }
  status: HTTP 응답 코드 (4xx 확정 거절 / 409 상태 충돌)
  message: 사용자 한국어 문구 (클라가 같은 파일을 import — 문구 이중화 제거)
  action?: "login" | "consent" | "reload_notice" (클라 특수 동작도 데이터화)
```

- 서버: RPC/route 거절 → 카탈로그 조회 → `{ error: code }` + status. 카탈로그 밖 P0001 은
  fatal 이 아니라 `500 + pay.uncataloged_reject` 로그(코드 추가 시 등록을 잊은 개발 결함 신호).
  진짜 fatal(invariant) 은 카탈로그의 `severity: "fatal"` 로 명시된 코드만.
- 클라: 같은 카탈로그 import — `catalog[code]?.message ?? "…(사유 코드: code)"`.
- **계약 테스트(핵심)**: `supabase/migrations/**` 의 `raise exception '<code>'` 전수 추출
  ↔ 카탈로그 키 대조. 신규 raise 코드가 카탈로그에 없으면 CI 실패. (도메인 밖 코드는
  명시 allowlist 파일로 구분.)

### B. 문구 계약 — copy registry **전문 등록제** (인벤토리 후 확정: 해시 대신 원문)

- 신규 테이블 `commerce_copy_registry(surface, copy_version, copy jsonb, active, registered_at,
  primary key (surface, copy_version))`. `copy` 에 문구 **원문**을 저장(청약철회 statement 는
  to_jsonb(text), offer 는 displayCopy 오브젝트).
- 해시가 아닌 원문 + `=` 등가 비교인 이유: jsonb 등가는 키 순서 무관이라 TS↔Postgres 의
  JSON 정규화(키 정렬) 차이라는 함정 계층이 아예 생기지 않는다. sha 는 증거행의 스냅샷
  무결성(기존 snapshot_sha256)에만 남는다.
- RPC 검증: 제출 copyVersion 이 registry active 행으로 존재 + 제출 문구가 `copy` 와 jsonb 등가.
  함수 본문 byte 리터럴·displayCopy 키수 하드코딩·테이블 CHECK 의 문구 allowlist 전부 제거.
- 원본은 코드 상수 1곳. seed 마이그는 `scripts/gen/copy-registry-migration.mjs` 가 상수에서
  재생성 — **계약 테스트 = "gen 재실행 결과가 레포의 seed 마이그와 byte-diff 0"** (SQL 파싱
  불필요·DB 불필요). 상수만 바꾸고 마이그 재생성을 잊으면 CI 실패.
- 구버전(withdrawal v1·offer v1)은 registry 에 비active 로 소급 seed — 기존 증거 행 정합 유지.
- 증거 박제(주문별 스냅샷+sha, 청약철회 수용 행)는 그대로 — 법적 가치 불변. 증거 테이블의
  문구 CHECK(0104 in-list)는 drop(기록 경로가 RPC 단일 + registry 검증이므로 중복).
- pgTAP·QA 셸 픽스처는 registry 를 조회해 구성 — 문구 하드코딩 7곳 → 1곳(코드 상수).

### C. checkout 흐름 단층화

```
route(POST /api/pay/checkout):
  인증 → rate-limit → 파싱 → growth 읽기(fail-closed) → 서버 상품 확정
  → RPC create_or_reuse_pending_order (단일 검증 계층)
     ├─ ok: receipt → 결제 파라미터 반환
     ├─ needs_provider_resolution(intents[]): 포트원 건별 실측
     │    → 비-PAID: p_resolutions 로 재호출(원자 종단+생성) / PAID: checkout_prior_intent_paid
     └─ 거절 코드: 카탈로그 매핑 그대로 반환
```

- route 의 사전 fence(`checkoutProductSnapshotMatches`·offer evidence 사전 대조·expectedMode
  대조) 제거 — RPC 가 동등 이상을 이미 검증(현행 상품명·offer sha·payMode). 클라 요청의
  `expectedProduct`/`expectedMode` 필드도 제거(스냅샷 fence 는 offerEvidenceId+sha 로 충분).
- prior-intent 는 예외가 아닌 **정상 반환값**: RPC 가 미해결 intent 목록을 돌려주고, route 가
  포트원 실측 결과를 들고 재호출하면 RPC 가 (재검증 후) 원자적으로 종단+신규 생성.
- 클라 stale 자가치유(1회 자동 새로고침+배너)·사유 코드 노출은 유지(카탈로그 action 으로 데이터화).

### D. CI — 최신 스키마 단일 검증

```
database job:
  supabase start → 전체 마이그레이션 순차 적용(단일 스텝)
  → pgTAP 전체 스위트 → 결정론적 race 스위트 → 도메인 QA(최신 스키마 대상)
```

- 시대별 apply 스텝·rollout 시뮬레이션 스텝 삭제. 시대 전용 QA 스크립트는 삭제(역사는 git).
- 배포 순서 계약 문서화: **마이그레이션(additive) → 코드 배포 → (파괴적 정리는 다음 마이그)**.
- race 하네스 공통 헬퍼: 세션 간 동기화는 폴링이 아니라 pg advisory lock / `SELECT ... FOR UPDATE`
  대기 자체로 표현 — 러너 속도 무관. 재작성 후 반복 실행으로 안정성 검증하고 편입.

### E. 컷오버 절차 (결제 OFF 창 사용)

1. PR 완성(CI green·전체 스위트) → 2. `creditsEnabled` OFF → 3. prod 마이그레이션
   (registry seed·신 RPC·구 검증/CHECK 제거) → 4. 배포 → 5. 소액 실결제+환불 검증
   → 6. ON → 7. Sentry·reconcile 감시.

## 비범위 (이번에 건드리지 않음)

- 환불 saga·크레딧 lot 회계 RPC 내부(0062 계열) — 오류 카탈로그 접점만 정리.
- 웹훅 서명 검증·grant 경로 — 현행 유지(불변식 4 의 검증된 구현).
- PG 채널 구성·payMode 판정 로직.

## 구현 계획 — 3단계 PR

**PR-A. 오류 카탈로그 (DB 무변경, 즉시 가치)**
- `lib/pay/error-catalog.ts`: `PAY_ERROR_CATALOG`(정상 거절: code→status·message·action) +
  `PAY_FATAL_INVARIANTS`(트리거 불변식 등 — 도달=버그, 500+Sentry fatal 유지 목록).
  `mapRefundRpcError` 는 카탈로그를 참조하도록 내부 교체(공개 API 유지 — saga 코어 무변경).
  둘 다 아닌 미지 코드 = 500 + `pay.uncataloged_reject`(등록 누락 결함 신호, fatal 아님).
- 클라 문구는 같은 카탈로그 import — 문구 이중화 제거. 유령 코드 6개 삭제.
- N7 수정: checkout classify 를 "body 에 error 코드가 있으면 상태코드 불문 rejected,
  unconfirmed 는 코드 없는 5xx/transport/timeout 만" 으로 — 429/503 문구 사각 해소,
  rate-limit 재전송 제거.
- 계약 테스트: (i) 마이그 raise 전수 ⊆ catalog ∪ fatal ∪ 타도메인-allowlist
  (ii) catalog 의 DB-유래 코드 ⊆ raise 전수(유령 방지) (iii) route 자체 생성 코드 대조.

**PR-B. CI 최신-스키마 단일 검증 + 하네스 결정론화**
- database job: `apply all`(1스텝) → pgTAP 전량 → race 스위트. 시대 경계 14개·rollout/
  raw-guard 시대 검증 스텝·`qa:db:apply:<버전>` 사다리 삭제. 시대 전용 스크립트
  (verify-rollout-stage 2287줄, verify-oauth-rollout-stage 925줄, convergence 1102줄 등) 삭제
  — 최신 스키마에서의 동시성·계약은 pgTAP 34종 + 잔존 race 하네스가 커버.
- **convergence 이식(조사 확정)**: mixed-version 케이스만 시대 전용 — "같은 유저 2탭 동시
  checkout → 단일 intent 수렴"과 "withdrawal 증거 user-boundary 직렬화(owner/waiter replay)"는
  시대 무관 가치라 최신 스키마 대상 `test-checkout-concurrency-races.sh` 로 이식 후 원본 삭제.
- race 동기화 공통 헬퍼: 상한 8s→120s(러너 속도 무관화)·실패 시 홀더 세션 출력 전체 덤프·
  pg_sleep 협조 대기 제거.
- **analytics 하네스 근본 수정(조사 확정)**: CI 로그의 FATAL 은 하네스가 holder 를
  pg_terminate_backend 로 죽이는 정상 절차의 흔적이고, flake 의 실체는 "holder 준비"를
  pg_stat_activity 의 PgSleep 상태 폴링으로 판정하는 간접 관측(two-core 러너에서 holder 가
  도달하기 전 false|false 오판) — holder 가 락 획득 직후 스스로 내는 준비 마커(출력 파일)
  대기 + fifo 종료 신호(terminate 제거) 구조로 재작성하고 quality.yml 의 `|| 재시도` 삭제
  — rerun 관행 철폐.
- harness-coverage 테스트 재작성 + "모든 마이그레이션이 CI 에서 적용된다" 어서션 추가.

**PR-C. registry + RPC 단일 계층 + 흐름 단층화 (OFF 컷오버)**
- 마이그 `0105`: registry DDL+seed(gen 산출), `create_or_reuse_pending_order` 재정의 —
  registry 검증·prior-intent `needs_provider_resolution` 정상 반환(+`p_prior_resolutions`
  재호출 원자 종단, ambiguous 2건+ 포함)·구 19-arg drop. 증거 CHECK drop.
- route 단층화: 사전 fence(#4 문구·#8 상품·#9 스냅샷·#12 증거)와 RPC 후 재SELECT 제거,
  needs_provider_resolution 루프(포트원 실측→재호출, 상한 2회). 클라 본문에서
  expectedProduct/expectedMode 제거(구 탭 브릿지: 구 본문 감지 시 stale 코드로 자가치유).
- 컷오버: creditsEnabled OFF → 0105 적용 → 배포 → 소액 실결제+환불 검증 → ON.

## 상태

- [x] 현행 전수 인벤토리 (코드·DB·CI)
- [x] 상세 설계 확정
- [ ] PR-A 오류 카탈로그
- [ ] PR-B CI 재설계
- [ ] PR-C registry·단층화·컷오버
