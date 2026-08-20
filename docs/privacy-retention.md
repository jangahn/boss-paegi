# 개인정보 보존·최소수집 런타임

이 문서는 현재 source의 `008904`·`008905` 구현 계약을 설명한다. 운영에서 해당
migration receipt와 같은 release SHA의 앱·cron postflight를 확인하기 전에는
배포·drain 완료를 주장하지 않는다.

## 결제 상세 5년

`008904_privacy_retention_controls.sql`은 결제 상세를 생성·갱신 시점 중 가장
최근 시점부터 최소 5년간 유지한다. 이후에도 다음 조건을 모두 충족한 주문만
하루 최대 100건씩 처리한다.

- 주문이 `paid`, `canceled`, `failed` 중 하나다.
- 환불 요청·시도, 취소 관측, 대사 이슈, shortfall이 모두 종결됐다.
- 구매 credit lot이 만료됐고 예약 수량이 없다.
- 연결된 생성이 `queued` 또는 미선택 `done` 상태가 아니다.
- 모든 하위 금융 증거도 5년 경계를 지났다.

처리는 한 DB 트랜잭션이다. 월·provider·종단상태·테스트 여부별 비식별 합계를
먼저 더하고, 생성물의 결제 provenance만 분리한 뒤 상세 FK 그래프를 child-first로
제거한다. 오류가 나면 해당 주문의 합계와 삭제가 함께 롤백되고, 원문 없이
`order_uuid`·SQLSTATE·재시도 시각만 failure queue에 남는다.

결제 버튼 위 고지와 결제 클릭으로 확인한 사용분 청약철회 제한 확인은
`checkout_withdrawal_acceptance_evidence`에 사용자·주문·상품명/금액/수량·
TEST/LIVE·채널·표시 snapshot hash·정확한 문구/버전·DB 확인시각·request ID로
불변 저장된다. 주문 FK와 함께 최소 5년 보존하며 위 worker가 적법한 주문 상세를
파기하는 같은 capability transaction의 cascade에서만 함께 삭제된다. 일반
service role DML로 수정·삭제할 수 없다.

`POST /api/ops/privacy-maintain`을 다른 ops cron과 동일한
`x-cron-secret`으로 매일 호출한다. 이 route는 현재 8개 ops route의 동적
filesystem inventory에 포함되며 20초 monotonic soft deadline,
`maxDuration=25`, scheduler request timeout 90초를 적용한다. 응답의 남은
ready/blocked/failure queue는 `429`, 시스템 오류는 `503`이고 모든 429/5xx는
`Retry-After: 60`과 `Cache-Control: no-store`를 반환하므로 scheduler가
false-green으로 기록하지 않는다.

2026-07-30 운영 read-only inventory에서 나머지 7개 ops 잡은 등록·활성 상태였지만
`privacy-maintain`은 아직 미등록이었다. 따라서 관련 migration과 같은 release
앱을 배포한 뒤 cron-job.org에 POST 방식으로 이 잡만 추가하고 아래 SLA를 실제
실행 이력으로 확인해야 한다.

운영 합격 SLA는 cron-job 실행 이력에서 연속 두 성공 사이 간격이 26시간 이내이고,
매 26시간 창에 최소 한 번의 HTTP 200이 있는 것이다. 429/5xx 또는 timeout은 성공
증거가 아니며 60분 이내 재시도한 뒤 200이 될 때까지 반복한다. 마지막 200이
26시간을 넘으면 즉시 운영 경보를 발화하고 ready/blocked/failure queue와
실패 코드를 확인한다. route 자체의 호출 성공만으로 파기 대상이 없다고 추정하지
않으며, 200 본문이 queue drain 완료를 함께 증명해야 한다.

## 표시·광고 증거 6개월

`008905_legal_commerce_generation_compliance.sql`의
`commerce_display_evidence`는 생성권 상품 표시와 청약철회 제한 확인 표면의
정규화 snapshot을 KST 일자·SHA-256 단위로 불변 보존한다. 최초 표시 내용은
수정할 수 없고 같은 날 같은 snapshot의 `last_displayed_at`만 단조 증가한다.
정확히 마지막 표시 후 6개월인 행은 유지하며 6개월을 초과한 행만
`prune_commerce_display_evidence(100)`이 한 번에 최대 100건 삭제한다.

이 prune은 위와 같은 `privacy-maintain`의 공통 20초 deadline 안에서 결제·분쟁
보존 작업과 함께 실행된다. 제한 100건을 모두 채워 뒤 행이 있을 수 있거나 RPC가
`has_more=true`를 반환하면 route는 `429`로 다음 drain을 요구한다. RPC 오류·손상
응답은 `503`이고, 해당 단계가 비었음을 권위 있게 확인한 실행만 최종 `200`에
도달할 수 있다.

## 생성 공급자 연령·flow-down 증거 — 폐지(2026-08-21)

서비스 전체 연령 기준이 만 19세로 상향되면서 별도 생성 자격 동의 스킴
(`generation_provider_acceptance_evidence`·record/status/prune RPC)은 증거 0건
상태에서 제거했다. 연령 확인은 가입 동의(`age_confirmed_at`)가 단일 소스다.

## 소비자 불만·분쟁 3년

서비스 안에서 접수하는 얼굴·UGC·권리침해 신고/분쟁 기록은
`content_reports`에 명시적으로 매핑한다. `pending`은 미종결이므로 기간과
무관하게 보존한다. `actioned`/`dismissed`로 처음 종결될 때의 `resolved_at`을
`retention_terminal_at`에 한 번만 고정하며, 이후 상태·기산점 변경과 재개방을
DB trigger가 거부한다.

종결 기산점에서 정확히 3년인 레코드는 유지하고, 3년을 초과한 레코드만 처리한다.
worker는 결제와 합쳐 한 실행 최대 100건만 시도하며 다음을 같은 savepoint에서
수행한다.

- 월·종결 상태·신고 사유 allowlist 단위의 비식별 합계를 먼저 기록한다.
- `reporter_user_id`, 연락처, 상세 원문, 대상/신고 식별자 및 신고에 직접 연결된
  운영자 원장을 제거한다.
- 응답 유실 재시도를 위해 무작위 `submission_id`와 정규 payload SHA-256에서
  만든 random-salt bcrypt verifier만 남긴다. 원 digest는 저장하지 않으며, 정확한
  payload 재전송에는 `already_removed`, 다른 payload 재사용에는
  `submission_conflict`를 반환한다.
- 진행 중인 영구삭제 saga와 직렬화하고, 보존 파기는 doll의
  `moderation_version`을 올리지 않는다.

오류 원문은 저장하지 않고 subject UUID·SQLSTATE·재시도 시각만 실패 큐에 둔다.
ready/blocked/failure가 남으면 cron 응답은 `429`, 처리 오류는 `503`이다.

### 외부 이메일 민원 수동 보존 runbook

`dev.jangahn@gmail.com` 등 서비스 DB 밖의 운영 이메일로 들어오는 소비자
민원은 자동 worker의 범위가 아니며 아래 절차가 정본이다. 담당자는 서비스
운영자 안병욱이고, 월 1회 첫 영업일에 대장과 파기 증적을 대조한다.

1. 접수 즉시 접근제한 대장에 무작위 사건 UUID, 접수 시각/채널, 허용된 분류 코드,
   상태(`open`/`resolved`), 원문 저장 위치를 기록한다. 비밀번호·결제 인증정보는
   원문에 재기록하지 않는다.
2. 처리 중에는 `open`으로 두며 보존 만료 대상으로 삼지 않는다. 최종 답변 또는
   합의/조치가 완료된 최초 시각을 변경 불가능한 `terminal_at`으로 기록한다.
3. 법적 보존명령이 있으면 사건 UUID, 보존 사유 코드, 해제 조건만 별도 기록하고
   파기를 보류한다. 해제 전에는 `terminal_at`을 고치지 않는다.
4. 매월 `terminal_at + 3 years < 점검시각`인 건만 원문·이메일 주소·첨부·내부
   메모를 파기한다. 정확히 3년인 건은 다음 점검까지 보존한다.
5. 사건 UUID 자체도 SHA-256 처리한 뒤 월/분류/종결 상태 합계와 파기 시각,
   실행자, 파기 결과만 증적으로 남긴다. 원문 경로와 연락처는 증적에 남기지 않는다.
6. 실패 건은 오류 코드와 다음 재시도 시각만 기록하고 해결될 때까지 매 영업일
   재시도한다. 검토자는 대장 건수, 파기 대상 건수, 성공/실패 증적 건수를 맞춘다.

ops 응답은 이 코드 밖 경계를
`external_consumer_complaint_manual_retention_runbook`으로 표시하지만
`legal_blockers`에는 넣지 않는다. 따라서 DB backlog와 실패가 없으면 응답은
`200`, `policyReady: true`이며, 외부 채널은 위 수동 증적으로 별도 검증한다.

## 공유·유입 분석

UTM/referrer 기반 first-party acquisition 수집은 클라이언트·서버 양쪽에서
상시 동작한다(2026-08-20 운영 결정으로 `NEXT_PUBLIC_ANALYTICS_ENABLED`
opt-in 게이트 제거 — 무식별·무PII 집계 원칙과 90일 raw 보관은 그대로다).
수집 항목·보유기간 고지는 개인정보처리방침 v1(2026-08-21 in-place 개정)에
반영되어 있다.
