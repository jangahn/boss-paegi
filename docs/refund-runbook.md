# 환불 saga 운영 runbook (v0.76)

배포 절차는 [docs/refund-saga/runbook.md](refund-saga/runbook.md)(21스텝)가 정본이고, 이 문서는 **운영 중
환불 saga 상태별 대응 절차**를 담는다. 설계 정본: [docs/refund-saga/boss-paegi-credit-refund-saga-final.md](refund-saga/boss-paegi-credit-refund-saga-final.md).

## 1. 상태 모델 요약

- **attempt**(order_refund_attempts): `prepared → pg_requested → (pg_pending) → pg_succeeded → committed`
  이 정상 경로. 이탈 경로는 `manual_review`(운영자 화해) → `manual_pending`(수동 이체 확정 대기) →
  `committed`, 또는 `released`(예약 해제 — 사유 결합 강제).
- **request**(refund_requests)의 state 는 attempts 의 파생 완전 함수 — 직접 조작 불가(DB deferred 트리거 강제).
- 어드민 UI: `/admin/refunds`(운영 큐) · 주문 행의 환불 버튼(RefundButton) · 회원 상세의 로트/진행 현황.

## 2. 상황별 대응

### outstanding (POST 응답 유실·타임아웃)
- 의미: 부분취소 POST 가 PG 에 도달했는지 불명. attempt 는 `pg_requested` 유지.
- 자동: reconcile cron(5분)이 **최초 POST 후 3h 내엔 동일 Idempotency-Key·동일 body 재시도만** 하고,
  3h 경과 시 신규 POST 없이 GET 증빙 폴링 → 증빙 없으면 `manual_review` 전환.
- 운영자: 3h 내엔 개입 불요. Sentry `pay.refund_attempt_outstanding` 지속 시 PG 콘솔에서 해당
  paymentId 취소 내역 확인.

### manual_review 진입 (PG FAILED·stale·hard reject·3h 초과)
- 확인: `/admin/refunds` 미종결 attempt 섹션. `pg_raw` 에 마지막 관측 스냅샷 저장됨.
- 선택지:
  1. **PG 콘솔에서 실제 취소가 이미 성공**해 있으면 → process(auto) 재실행: marker
     (`BP_REFUND:<attempt-uuid>`) 취소를 자기 귀속해 committed 로 종단.
  2. **무이동 확정 + 수동 이체로 진행** → switch_to_manual(사유 입력 — fresh GET 무이동 증빙 자동 영속)
     → 실제 계좌이체 후 commit_manual(`externalPayoutRef`=이체 참조번호, `evidenceObjectId`=증빙 저장 uuid).
  3. **재계획** → replan(post-PG 는 fresh 무이동 증빙 필수 — movement 있으면 거부됨). 해제 후 새 request 로.
- **payout evidence 스키마(고정)**: `{method:'bank_transfer', evidence_object_id:'<uuid>'}` 2키만.
  계좌번호·이름·URL 등 PII 금지(DB CHECK 로도 거부). `external_payout_ref` 는 `^[A-Za-z0-9._:-]{1,128}$`.

### unmatched_cancellation issue (미귀속 PG 취소 관측)
- 의미: PG 취소가 관측됐는데 어떤 attempt 의 marker 와도 매칭되지 않음(콘솔 수동 취소 등).
- 판정 절차: ① PG 콘솔에서 해당 cancellation 의 사유/금액 확인 ② 대응 attempt 가 있으면 process(auto)
  재실행(자기 귀속) ③ 진짜 외부 취소면 `/admin/refunds` 에서 economicQty(회수 수량) 입력 후 resolve
  (`/api/admin/resolve-cancellation` — 수량 역산 금지: 증빙 기반으로 운영자가 명시).
- 전액취소+cancel intent 존재 케이스만 system auto-full 이 자동 종결한다.

### late_paid issue (탈퇴자·취소의도·취소주문의 늦은 결제확정)
- 지급 0 + quarantine 로트 + issue 만 생성됨(자동 환불 없음).
- 대응: 회원/주문 확인 후 환불 진행 — cancel intent 케이스는 admin cancel(재실행)이 scoped request 를
  만든다. 탈퇴자 케이스는 CS 판단으로 refund-credits begin(quarantine 로트도 예약 가능).

### cancellation_discrepancy issue (재관측 불일치)
- 기존 event 와 다른 금액/상태/주문으로 재관측 — event 는 불변 보존, PG 콘솔 대조 후 resolve/ignore.
  (FAILED 무이동 event 만 ignore 가능 — SUCCEEDED 는 경제 해소 선행 강제.)

### invariant_violation (Sentry fatal — issue 큐 아님)
- `pay.refund_invariant_violation` 은 **어드민 카드·이슈 목록에 없다**. DB 가 전체 트랜잭션을 롤백했고
  데이터 모순(예: shortfall 초과)이 의심된다는 뜻.
- 대응: 즉시 작업 중단 → `post-0062-go-no-go.sql` 게이트 실행(G-1~G-13 봉투 불변식 확인) → 원인 조사.
  fix-forward 만(파괴적 롤백 금지). 반복 발생 시 해당 주문의 saga 를 중지하고 데이터 정합 조사.

## 3. Sentry 이벤트 (v0.76 정본)

| 이벤트 | 의미 | 레벨 |
|---|---|---|
| `pay.refund_invariant_violation` | 사후 불변식 위반(§8 ③) — 유일 보고 채널 | fatal(온콜 즉시) |
| `pay.refund_attempt_outstanding` | POST 응답 유실(3h 재시도 창) | warn(지속 시 확인) |
| `pay.refund_attempt_manual_review` | attempt 가 수동 검토로 전환 | warn |
| `pay.late_paid` | 늦은 결제확정 흡수(지급 0·issue) | warn |
| `pay.wh_grant_fail`·`pay.wh_amount_mismatch`·`pay.wh_paid_not_granted` | 기존 지급 대사 계열(유지) | warn |
| `pay.stale_payment_request`·`pay.*_test_channel_on_live_order` | 기존(유지) | warn |

폐지: `pay.refund_commit_fail`(구 refund_state 모델 전용 — v0.76 에서 제거).

## 4. cron

- `reconcile`(5분): 지급 대사 + open attempt sweep(GET 폴링·3h 컷오프) + heartbeat. SLA 성공 ≤15분.
- `credit-expire`(일 1회): 자연 만료 로트 회수 + heartbeat. SLA 성공 ≤26h.
- 심박: `ops_cron_heartbeats`(G-47) — `last_succeeded_at` 이 SLA 를 넘으면 cron-job.org 설정·시크릿 확인.
