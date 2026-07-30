# 포트원 전환·결제 증거 롤아웃 런북 (2026-07 — PG 심사 대응 포함)

페이앱 → 포트원(PortOne V2) 컷오버의 **코드 밖 수동 작업** 절차. 코드·DB 변경은 v0.73 / Migration 0058 참조(README).
목표 상태: 프로덕션(`boss-paegi.vercel.app`)에서 **테스트 채널로 결제창이 뜨는 상태**(= 포트원이 요구한 '테스트모드 설정', PG·카드사 심사관이 확인하는 것). 결제 성공까지는 심사 요건 아님.

## 0. 전제 확인
- [ ] 포트원 가입신청서의 **서비스 URL 이 `https://boss-paegi.vercel.app` 인지 콘솔에서 확인** (다르면 포트원에 변경 요청 — 심사 URL 변경은 재심사 사유).
- [ ] 콘솔 배너 **"토스페이 심사 진행을 위해 추가 신청서 작성"** → [완료하러 가기] → 토스페이 상점관리자 페이지 신청서 제출까지 완료 (이걸 해야 토스페이 계약부서 안내 2~3영업일 → 계약 → 카드사 심사가 진행됨).

## 1. 포트원 콘솔 설정
1. **테스트 채널 3개 추가** — [결제 연동] > [연동 관리] > [채널 관리] > "+ 채널 추가", 연동 모드 **'테스트'**:
   | 채널 | PG | 결제 모듈 | 공용 테스트 MID |
   |---|---|---|---|
   | 카드 | 한국결제네트웍스(KPN) | 결제창 일반결제(V2) | `merchantest6` (과세) |
   | 토스페이 | 토스페이 | 일반결제(V2) | `tosstest` |
   | 카카오페이 | 카카오페이 | 일반결제(V2) | `TC0ONETIME` |
   각 채널 저장 후 **채널키(channel-key-...)** 를 기록.
2. **V2 API Secret 발급** — [연동 관리] > [식별코드·API Keys] > [V2 API]. ⚠️ 발급 직후에만 값 확인 가능 — 바로 복사.
3. **웹훅 등록** — [결제 연동] > [연동 관리] > [결제알림(Webhook) 관리]: 버전 **V2**, URL `https://boss-paegi.vercel.app/api/pay/webhook`, **테스트/실연동 환경별로 각각** 설정. 웹훅 시크릿(`whsec_...`) 기록.
4. **Store ID**(`store-...`) 기록 — 콘솔 상점 식별자.

## 2. env 설정 (.env.local + Vercel 프로덕션)
```
PORTONE_V2_API_SECRET=            # 서버 전용
PORTONE_WEBHOOK_SECRET=whsec_...  # 서버 전용 (테스트 환경용 값부터)
NEXT_PUBLIC_PORTONE_STORE_ID=store-...
NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD=channel-key-...      # KPN 테스트 채널
NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY=channel-key-...   # 토스페이 테스트 채널
NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY=channel-key-...  # 카카오페이 테스트 채널
```
`PORTONE_API_BASE_URL`은 Vercel production에 설정하지 않는다. 서버는 운영에서
exact `https://api.portone.io`만 허용하고 다른 값이면 시작을 거부한다. 로컬
리허설도 path/query/credential 없는 `http://localhost`·`127.0.0.1`·`[::1]`
stub만 허용하므로 PortOne Authorization secret을 임의 origin으로 보낼 수 없다.

기존 `PAYAPP_USERID`/`PAYAPP_LINKVAL`/`PAYAPP_LINKKEY` 는 Vercel 에서 제거.

## 3. DB 마이그레이션 0058 (⚠️ 배포와 동시)
- `supabase/migrations/0058_portone_orders.sql` 을 Management API 로 적용(단일 트랜잭션·`notify pgrst` 포함).
- **순서: 마이그 적용 → 즉시 배포(main 머지)**. 리네임이라 구 코드는 `payapp_orders` 참조로 깨지지만, 현재 결제는 creditsEnabled=OFF + PAYAPP env 제거로 어차피 비활성 — 유일한 실사용 표면은 어드민 주문 조회(잠깐의 공백 허용).
- 적용 후 확인: `select provider, count(*) from orders group by 1;` → payapp 22.

## 4. 심사용 계정 + 노출 설정 (콘솔)
1. **(0060 이후 기본 경로) ID/PW 심사 계정** — `/admin/reviewers` 에서 생성(비번 자동발급·1회 표시). 진입: `/login?reviewer=1`. 동의 스탬프·결제 허용·테스트 채널 스위칭이 자동 처리되므로 아래 2 의 수동 절차가 불필요. PG 회신에는 이 ID/PW 를 전달(운영자 구글 계정은 구글 보안에 걸려 전달 불가 — 실사례).
2. (대안) 심사관이 구글·카카오로 직접 가입한 경우 → `/admin/content/growth_levers` → **"테스트 결제 계정 이메일"** (구 "PG 심사용 계정 이메일", v0.74 개명)에 해당 이메일 등록 + 발행. (creditsEnabled 는 OFF 유지 — 일반 유저에겐 준비중 그대로.)
3. `/admin/content/business_info` (**사업자 정보** 탭 — v0.74 에 site_content 에서 분리, 0061) → 채워 발행(푸터 즉시 노출):
   - 상호 제이엔에이 · 대표 안병욱 · 사업자등록번호 · 사업장 주소 — **사업자등록증과 일치**
   - **유선전화(070 등 — 휴대폰 불가)** ← 미보유 시 발급 필요 (카카오페이 명시 요건)
   - 고객센터 이메일 · 통신판매업신고번호(신고 후 추가 — KB국민카드 심사 필수, 정부24 신고)
4. 심사 계정으로 `/credits` 진입 → 수단 3종 각각 결제창이 뜨는지 확인. 스마트폰의 카카오페이 리다이렉트 흐름은 실기기 수동 검증 항목으로만 기록하며 자동 QA에서는 실행하지 않는다. 테스트 결제 1건 완주 → 크레딧 지급·어드민 주문 반영·웹훅 로그 확인. **KPN 카드 테스트 채널만** 매입 전 자동 void되어 사후 취소가 P568로 실패할 수 있고, 토스페이·카카오페이 테스트 결제까지 같은 동작으로 일반화하지 않는다. KB국민·NH농협·카카오뱅크 카드는 테스트 불가다.

## 5. 포트원에 회신
- 받은 메일(cs@portone.io) 회신 또는 채널톡: "테스트모드 설정 및 결제모듈 호출 구현 완료. 서비스 URL: https://boss-paegi.vercel.app — 결제페이지는 로그인 후 /credits 이며, 심사용 계정을 안내드립니다: (계정/로그인 방법)". 심사용 계정 전달 방식은 담당자에게 확인(문서에 명시된 절차 없음).

## 6. 약관·개인정보처리방침 개정 (콘솔 — 코드 배포 불요)
`/admin/content/legal` 에서 수정 후 발행. 법무 version API는 browser/CDN
`no-store`이고 edge cache도 KST 자정에 잘리므로 **시행 시각부터 전 회원
재동의가 즉시 강제**된다. 시행 뒤 stale v1 유예는 0초다.
- 약관 제10조: "결제대행사(페이앱)" → "결제대행사(포트원을 통한 한국결제네트웍스·토스페이·카카오페이)"
- 처리방침 수집항목: "페이앱 결제번호(mul_no)" → "결제대행사 거래번호(paymentId·transactionId)", 더미 연락처 서술 제거
- 처리방침 수탁자: "㈜페이앱(PayApp) — 결제 처리 및 취소·환불" → "㈜코리아포트원(PortOne) 및 결제대행사(한국결제네트웍스·㈜비바리퍼블리카(토스페이)·㈜카카오페이) — 결제 처리 및 취소·환불"
- 국외이전 항목의 "㈜페이앱은 국내 사업자" 서술 갱신(포트원·PG 3사 전부 국내)

## 7. 계약 완료 후 (실모드 전환 — 별도 작업)
- **(0059 이후 채널 이원화)** 기존 테스트 채널키는 `NEXT_PUBLIC_PORTONE_CHANNEL_KEY_*_TEST` / `PORTONE_WEBHOOK_SECRET_TEST` 로 이관하고 **계속 유지**한다(심사·테스트 계정 상시 테스트 결제 경로 — 승인 후에도 숨김 진입 유지가 요구사항).
- KPN·토스페이·카카오페이 계약 완료 메일로 실 MID(KPN: MID+Secret OTP, 카카오페이: CA~ CID) 수령 → 콘솔에서 **실연동 채널 3개** 추가 → 무접미사 env(`NEXT_PUBLIC_PORTONE_CHANNEL_KEY_*` + `PORTONE_WEBHOOK_SECRET`)에 실연동 값 기입.
- ⚠️ **카드사 심사 완료 전 실연동 결제는 실패가 정상** — 심사 완료 확인 후 creditsEnabled ON.
- Sentry: `payapp.*` 기반 알림 모니터를 `pay.*` 이벤트명으로 재설정(`pay.wh_grant_fail`·`pay.wh_amount_mismatch`·`pay.wh_paid_not_granted`·`pay.stale_payment_request`, 임계 1) + 채널 대사 백스톱 `pay.*_test_channel_on_live_order` 추가(임계 1 — 무료 크레딧 시도 신호).
  - (v0.76 환불 saga) `pay.refund_commit_fail` 은 폐지(구 refund_state 모델 전용). 대체 모니터:
    `pay.refund_invariant_violation`(임계 1·fatal — 온콜 즉시), `pay.refund_attempt_outstanding`(지속 시 확인),
    `pay.refund_attempt_manual_review`, `pay.late_paid`. 대응 절차는 `docs/refund-runbook.md`.
  - (v0.76) 컷오버·0063 직전 체크리스트: `payment_cancellation_events` 에서 `origin='live' and
    resolution_state='unmatched'` 가 **REQUESTED·FAILED 포함 전 상태 0** — REQUESTED 는 reconcile 폴링으로
    종단화, FAILED 는 `/api/admin/resolve-issue` 로 issue+event 원자 ignored. 상시 운영의 unmatched 는
    즉시 no-go 가 아니라 age 기반 경보(3시간)로만 본다.
- ~~reviewerEmails 비우기(심사 종료 시)~~ → **유지**(심사·테스트 계정은 승인 후에도 테스트 채널 상시 운영 — 0059 채널 이원화로 실매출 오염 없음).

## 참고 (조사 확정 사실)
- 심사 = PG 입점심사 + 카드사 심사(통상 ~2주), 심사관이 신청서 기재 URL 직접 접속. 결제창 호출·카드사 목록 노출까지만 확인(결제 성공 불필요). 로그인 뒤 결제페이지는 심사용 계정 제공으로 대응(공식 문서화된 방식).
- dev/test/staging URL 심사는 하나카드 반려 리스크 + 실 URL 전환 시 재심사.
- 메일의 '본인인증 서비스' 섹션은 결제와 별개의 선택 서비스 — 결제만 신청한 현재는 해당 없음.
- 테스트→실연동 전환은 채널키 env 교체만(코드 불변). 웹훅 URL 은 환경별 콘솔 설정.

## 8. Payment evidence hardening 롤아웃 (Migration 0072~0092)

이 절차는 0058의 PortOne 컷오버 이후 주문에 immutable
`expected_store_id`/`expected_currency`/`expected_channel_key`를 도입하는 별도
expand/contract 작업이다. **checkout에 10분 재사용 window는 없다.**
`provider='portone'`, `status in ('pending','failed')`, `paid_at is null`,
`canceled_at is null`인 전체 주문이 사용자 전역 미해결 intent이며 DB unique index가
사용자당 최대 1개를 강제한다. `failed`도 같은 payment ID로 PAID가 될 수 있어
제외하지 않는다.

### 8.1 현재 운영 코드 기반 bootstrap freeze 배포

전체 hardening 앱은 26개 파일인 `0072`~`008907`의 DB surface를 먼저 요구한다. 따라서 운영 DB가
expand 전인 상태에서 전체 앱을 먼저 배포하지 않는다. 현재 운영 commit에 checkout
outer gate만 추가한 최소 freeze 배포를 먼저 production으로 승격한다.

- [ ] 청약철회 제한 증거 구현 fence는 완료됐으므로 bootstrap·expand·contract
  동안 production `PAYMENT_CHECKOUT_ENABLED`를 exact `1`이 아닌 값으로 유지한다.
  이 상태에서 `/api/pay/checkout`이
  인증·reviewer 우회·config read·주문 mutation보다 먼저
  `503 {"error":"payment_unavailable"}`를 반환한다.
- [ ] 같은 응답에
  `X-Boss-Paegi-Payment-Rollout: frozen`이 exact 포함되는지 확인한다. 이 헤더가
  없으면 config 장애의 503과 outer freeze를 구분할 수 없으므로 롤아웃을 시작하지
  않는다.
- [ ] 정상 회원뿐 아니라 `reviewerEmails`와 `reviewer_accounts` 요청도 동일하게
  거부되는지 확인한다. `creditsEnabled=false`만으로는 reviewer checkout이 열리므로
  freeze 증거가 아니다.
- [ ] 최소 freeze 배포의 production alias가 확정된 뒤에만 다음 단계로 이동한다.
  다른 비결제 기능은 계속 서비스한다.

### 8.2 expand

최종 release branch는 unchanged `origin/main` 위로 rebase한 뒤 PR CI를 통과해야
한다. 그 clean HEAD의 exact commit과 tree를 고정하고, 아래 index·expand 명령도
모두 그 source에서 실행한다. 운영 mutation 직전 fetch에서 `origin/main`이 rebase
기준과 달라졌으면 시작하지 않는다. expand가 pending=0이 된 뒤 다시 fetch해 base가
그대로일 때만 exact `HEAD:main`을 force 없이 fast-forward push한다. 이 push가
Vercel 자동 배포를 시작하며 PR도 같은 commit으로 merged 상태가 되어야 한다.
expand 뒤 `main`이 움직였다면 push하거나 다른 commit으로 대체하지 않고 additive
DB 상태를 유지한 채 rebase·CI·release identity를 다시 평가한다. 이렇게 해야 앱
자동 배포가 선행해 DB보다 먼저 노출되는 race 없이 journal의 app commit/source
tree와 production build를 동일 SHA로 결속할 수 있다.

운영 `orders`는 이미 데이터가 있으므로, 먼저 별도 top-level Management API
요청으로 partial unique index를 무중단 선빌드한다.

```bash
npm run qa:payments:ensure-intent-index
npm run qa:payments:ensure-intent-index -- --check
```

이 스크립트는 duplicate inventory를 먼저 0으로 증명하고,
`CREATE UNIQUE INDEX CONCURRENTLY`를 **단 하나의 독립 SQL 요청**으로 실행한 뒤
이름·키·predicate·valid/ready 상태를 exact postflight한다. Supabase CLI는 migration
파일의 statement batch를 암묵적 transaction으로 실행하므로 이 concurrent build를
migration 파일 안으로 옮기면 안 된다. active progress가 있는 exact build는 건드리지
않고 중단하며, definition이 다른 same-name index도 fail-closed한다. 반면 취소된
동일 스크립트가 남긴 **exact-definition invalid/ready=false** index는 active progress가
없다는 catalog 증거가 있을 때만 독립 `DROP INDEX CONCURRENTLY` 요청으로 제거하고,
duplicate를 다시 0으로 선형화한 뒤 재빌드한다. create/drop 응답 유실은 exact catalog
재조회로만 수렴하며, 재실행 시 exact valid/ready index가 있으면 no-op이다.

그 뒤 운영에서는 fail-closed runner로 `0072`~`008907`의 26개 파일을 한 Management API
요청으로 적용한다.

```bash
# freeze header/body/status, exact index, journal과 pending plan만 확인
npm run qa:prod:rollout:expand

# 위 dry-run이 blocker 0일 때만 적용
npm run qa:prod:rollout:expand:apply

# 응답 유실 복구를 포함한 최종 pending=0 재확인
npm run qa:prod:rollout:expand
```

각 migration은 자신의 transaction 안에서
`schema_migration_journal` receipt를 원자 기록한다. HTTP 응답이 유실되면 runner는
같은 SQL을 추정 재전송하지 않고 journal을 재조회하며, receipt가 없으면 즉시
중단한다. journal은 stage의 연속 prefix만 허용하므로 중간 파일을 건너뛸 수 없다.
`qa:db:*` 명령은 disposable local DB 검증용이며 운영 적용 명령이 아니다.

Payment evidence 세 파일 뒤, 전체 앱이 요구하는 public write quota, 생성·Storage·비용,
재무 projection 상한, bounded asset cleanup surface를 차례로 적용한다.

1. `0087_payment_evidence_expand_ddl.sql` — 짧은 orders DDL, evidence tuple shape,
   immutable adoption trigger, 선빌드한 사용자당 미해결 PortOne intent index exact
   gate. 오직 row가 0개인 fresh local reset만 regular index fallback을 허용한다.
2. `008800_payment_evidence_expand_validate.sql` — shape constraint와 index exact
   definition validation
3. `008899_server_read_surface_rollout_gate.sql` — 12-arg checkout, expand-only
   backfill, 지급 evidence gate, 나머지 rollout compatibility surface
4. `008900_public_write_quotas.sql` — telemetry/analytics public write의 bounded
   quota RPC
5. `008901_generation_storage_cost_controls.sql` — 생성 비용 preflight, exact provider
   submission/webhook receipt, private artifact lifecycle, bounded cleanup
6. `008902_financial_projection_bounds.sql` — 관리자 재무 read의 bounded projection
7. `008903_bounded_asset_cleanup_sagas.sql` — 계정·모더레이션 Storage 삭제를 100개
   이하 fenced claim으로 수렴시키는 bounded saga
8. `008904_privacy_retention_controls.sql` — 공개된 결제기록 5년 보존 뒤 상세를
   bounded·fenced 방식으로 비식별 집계/파기하고, 미매핑 3년 분쟁 source backlog를
   fail-visible하게 유지. 이 receipt까지 없으면 expand 완료가 아니며 전체 앱을
   배포하지 않는다.
9. `008905_legal_commerce_generation_compliance.sql` — 6개월 표시 snapshot,
   분리된 청약철회 확인과 5년 주문 결속 증거, 탈퇴 세대별 fal 연령/flow-down
   증거 및 bounded 보존 정리
10. `008906_admin_search_helper_acl.sql` — 관리자 검색 helper의 exact
    service-role ACL
11. `008907_atomic_active_event_snapshot.sql` — 활성 이벤트 4지면을 한 MVCC
    snapshot과 공통 server time/전환 시각으로 원자 조회

로컬 disposable DB에서는 다음을 통과시킨다.

```bash
npm run qa:db:apply:expand
npm run qa:db:rollout-expand
npm run qa:db:checkout-convergence-race
```

영구 19-arg checkout은 12개 주문 인자에 stable checkout request UUID, 상품명,
표시 증거 UUID/hash, 청약철회 문구 version·exact copy·적극 확인을 더한다. 같은
transaction에서 주문과 `checkout_withdrawal_acceptance_evidence`를 원자 생성하고,
route는 둘과 표시 증거를 모두 재조회하기 전에는 PortOne 파라미터를 반환하지 않는다.
같은 payment ID를 exact replay하며, 새 payment ID라도 기존 미해결 intent와
상품·test-mode·pay channel이 같으면 현재 config/env로 덮지 않고 기존
amount·credits·provider tuple을 담은 frozen receipt를 그대로 reuse한다. 다른
상품·mode·channel은 `checkout_prior_intent_unresolved`다.

공개 12-arg overload는 frozen 구 앱만 위한 expand-only compatibility wrapper다.
신 앱은 영구 19-arg signature만 사용하고 `0092`가 12-arg wrapper와 private core
실행권을 제거한다.

expand 동안 남는 구 9-arg RPC는 신규 주문 생성용이 아니다. 사용자에게 미해결
intent가 없으면 `checkout_upgrade_required`, 같은 payment ID의 exact pending
transport replay만 성공, 다른 ID는 `checkout_reuse_required`다. 신규 all-NULL
evidence 주문을 만들 수 없다.

### 8.3 신 앱 frozen 배포와 provider-backed evidence backfill

- [ ] expand pending=0과 8.2의 최종 `origin/main` 불변 확인 뒤에만 19-arg evidence
  caller를 포함한 exact release HEAD를 `main`으로 fast-forward push한다. PR merged와
  Vercel production의 exact commit이 모두 같은 SHA인지 확인한다.
- [ ] canonical production의 `PAYMENT_CHECKOUT_ENABLED`는 계속 `1`이 아닌 값으로
  유지하고 compile-time 청약철회 제한 증거 구현 fence는 `true`인지 확인한다.
  새 앱 배포 직후에도 8.1의 exact 503/header/body가 유지돼야 한다.
- [ ] `.nvmrc=22`, `package.json`의 `engines.node=22.x`, `prebuild` Node-major
  guard를 source에서 확인하고, Vercel build log와 production runtime이 실제 Node
  22인지 확인한다. 프로젝트 설정이나 engine override 추정만으로 통과시키지 않는다.
- [ ] fast-forward로 `main`이 된 clean exact release HEAD에서
  `npm run qa:prod:rollout:app-postflight`를
  실행한다. checkout·FAL·doll 세 paid route가 같은 production project/commit을
  가리키고 모두 frozen이며, 모든 expand receipt의 migration hash·manifest hash·
  app commit이 그 source와 정확히 일치해야 한다. 이 read-only gate 전에는
  provider backfill이나 contract로 이동하지 않는다.
- [ ] 인증된 QA canary/preview에서 PortOne `requestPayment`를 호출하지 않은 채
  신규 주문의 frozen receipt와 store/currency/channel key, 같은 intent
  replay/reuse, 다른 상품·mode·channel 차단을 smoke한다. 생성한 QA intent는
  명시적으로 종결한 뒤 inventory를 다시 확인한다.

운영 frozen 배포에 실제 포함된 Store ID와 **구성된 live/test channel key subset**을
사용하되 값을 로그에 출력하지 않는다. 여섯 채널을 모두 구성할 필요는 없지만,
provider inventory에 등장한 mode/channel의 key가 배포 구성에 없으면 해당 행은
`provider_channel_key_mismatch` blocker다.

운영 runtime secret은 로컬 비밀 파일에서 읽고, public Store/channel 식별자는
canonical frozen 배포의 same-origin Next.js bundle에서 추출·교차검증한다. 현재
운영 배포에서는 store 1개와 test card/tosspay/kakaopay 3개 구성이 값 미출력
read-only probe로 확인됐다. wrapper는
runtime 파일의 개발용 `NEXT_PUBLIC_SITE_URL`을 origin으로 사용하지 않고, 명시한
`BOSS_PAEGI_PRODUCTION_ORIGIN` 또는 고정 canonical production origin만 사용한다.
또한
`BOSS_PAEGI_SUPABASE_PROJECT_REF`를 필수로 받고 runtime
`NEXT_PUBLIC_SUPABASE_URL`의 hostname이 exact
`<project-ref>.supabase.co`인지 먼저 검증해 다른 프로젝트 오적용을 차단한다.
실행 source는 clean Git commit/tree여야 하며, bundle 추출 전·후와 provider
audit/backfill 종료 뒤에 checkout·FAL·doll 세 route가 모두 그 동일 commit/project의
exact frozen 응답인지 다시 확인한다. 어느 probe에서든 rolling alias나 unfreeze가
관측되면 apply 성공으로 보고하지 않고 재실행을 요구한다.
먼저 provider GET만 수행하는 dry-run을 실행한다.

```bash
npm run qa:payments:backfill-evidence:production -- \
  --runtime-env-file "/absolute/path/to/boss-paegi/.env.local"
```

blocker가 0일 때만 적용한다.

```bash
npm run qa:payments:backfill-evidence:production -- \
  --runtime-env-file "/absolute/path/to/boss-paegi/.env.local" \
  --apply

# 적용 뒤 다시 dry-run하여 complete tuple만 남았는지 확인
npm run qa:payments:backfill-evidence:production -- \
  --runtime-env-file "/absolute/path/to/boss-paegi/.env.local"
```

backfill은 fresh PortOne GET이 다음을 모두 exact 입증한 행만 허용한다.

- 로컬 `order_uuid`에서 파생한 `payment_id`, 금액, `is_test`, `pay_channel`
- provider `storeId`, `currency=KRW`, channel type과 channel key
- provider channel key가 구성된 live/test channel 값 중 정확히 하나와 일치하고 로컬
  non-null `pay_channel`과 결제수단이 일치함

레거시 `pay_channel=null`은 row identity의 일부이므로 임의 추정하거나 rewrite하지
않는다. provider channel key가 정확히 하나의 구성 채널을 가리키는 경우에만 null을
그대로 둔 채 evidence tuple을 채운다. complete tuple은 immutable이고, partial tuple,
provider 불일치, 중복 channel key, 스캔 중 dataset 변화는 전체 apply blocker다.

all-NULL evidence 행은 compatibility grant 대상이 아니다. webhook, order-status,
reconcile, 취소 finalization, 관리자 settle을 포함한 money transition은
`payment_evidence_incomplete`로 fail-closed하고 크레딧을 지급하지 않는다. provider
backfill 뒤 exact tuple 검증을 통과해야만 정상 money path에 다시 들어갈 수 있다.

### 8.4 backfill postcheck·drain

- [ ] 8.3의 provider-backed dry-run→apply→dry-run을 완료하고 partial tuple 0,
  incomplete PortOne row 0, duplicate unresolved-intent user 0을 재확인한다.
- [ ] production alias 전환 뒤 최소 120초(현재 route 최대 실행시간) 이상 기다리고,
  webhook/poll/reconcile/settle, background maintenance와
  `account_reactivation_legacy_repairs`의 `pending`/`leased`를 drain한다. active
  profile의 Auth email mismatch도 0이어야 한다.
- [ ] 장기 생존한 구 브라우저를 유한하게 전수 열거할 수 있다고 가정하지 않는다.
  구 요청은 새 route의 strict input fence와 contract의 구 RPC/직접 DML 회수로
  fail-closed하는 것이 종료 증거다.
- [ ] 이 단계에서는 checkout을 다시 열지 않는다.

### 8.5 contract

먼저 운영 contract dry-run이 payment evidence와 legacy reactivation/Auth inventory를
모두 0으로 증명해야 한다. 그 뒤에만 다음 세 파일을 순서대로 적용한다.

1. `0090_payment_evidence_contract_constraint.sql` — 미backfill PortOne 행이 있으면
   중단하고 permanent required-evidence CHECK를 NOT VALID로 설치
2. `0091_payment_evidence_contract_validate.sql` — historical row와 unique index
   definition 검증
3. `0092_rollout_contract_cleanup.sql` — expand-only backfill·구 9-arg RPC·
   evidence-free 12-arg compatibility wrapper·임시 DML/rollout flag와 나머지
   legacy compatibility surface를 회수하고 영구 19-arg checkout만 유지

```bash
npm run qa:prod:rollout:contract
npm run qa:prod:rollout:contract:apply
npm run qa:prod:rollout:contract
```

contract 뒤에는 all-NULL PortOne row 삽입 자체가 DB CHECK로 거부되어야 하고,
backfill RPC, 구 9-arg checkout RPC, expand-only 12-arg wrapper가 없어야 하며
영구 19-arg signature만 실행 가능해야 한다. 이 단계 전후의 실행 증거와 외부/실기기
제외 범위는 `docs/qa-validation-report.md`에 기록한다. disposable local DB에서는
별도로 다음 회귀 검증을 유지한다.

```bash
npm run qa:db:apply:contract
npm run qa:db:rollout-contract
npm run test:db
```

### 8.6 checkout 재개·최종 smoke

checkout은 contract pending=0과 contract probe 통과만으로 열지 않는다. 분리된
사용분 청약철회 제한 적극 확인과 사용자·주문·상품·금액·모드·채널·문구
버전·시각·request ID 불변 증거는 구현·검증됐으며, 아래 앱 smoke까지 통과한
뒤에만 재개한다.

- [ ] compile-time 청약철회 제한 증거 fence가 `true`인 검증 완료 앱에서만
  production `PAYMENT_CHECKOUT_ENABLED`를 non-sensitive
  exact string `1`로 바꾼 뒤 같은 immutable source commit을 production으로
  redeploy한다.
- [ ] production alias가 새 deployment를 가리키는지 확인하고, 익명 요청은 401,
  reviewer의 정확한 상품/mode/분리 확인 요청은 더 이상 frozen 503/header가
  아니며 19-arg 주문+청약철회 evidence receipt를 반환하는지 확인한다.
- [ ] 같은 intent replay/reuse, 다른 상품·mode·channel 차단, webhook/poll/reconcile
  수렴, immutable evidence tuple, 관리자 주문 read를 다시 smoke한다.
- [ ] checkout의 auth·64KiB body·config·reviewer·DB 경계가 하나의 20초
  deadline(`maxDuration=25`) 안에서 503으로 닫히고, 브라우저 결제창 SDK가
  10분 안에 끝나지 않으면 재호출 없이 `/credits/done`의 권위 폴링으로
  이동하는지 fault test를 확인한다.
- [ ] `creditsEnabled=false`라면 일반 회원은 계속 비활성이고 reviewer만 테스트
  경로가 열리는 것이 정상이다. 실제 현금 결제와 실기기 카카오페이 흐름은 이
  자동 롤아웃의 완료 증거로 사용하지 않는다.
