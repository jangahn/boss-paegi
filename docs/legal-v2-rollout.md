# 법무 문서 v2 정본·검증·운영 발행

## 정본과 적용 범위

법무 문서의 단일 정본은
[`legal/v2-documents.mjs`](../legal/v2-documents.mjs)이다. 개인정보처리방침
18개 섹션과 이용약관 16개 조항을 DB의 구조화된 `sections` 형식으로 그대로
보유한다. 운영 초안을 UI에서 다시 편집하지 않는다.

이 정본은 다음 실측 상태를 기준으로 한다.

- Supabase 운영 리전은 싱가포르 `ap-southeast-1`이다.
- Vercel 주 실행 리전은 `sin1`, Sentry ingest 리전은 미국이다.
- 자체 유입 분석은 명시적 opt-in이며 현재 비활성이다.
- Sentry 오류·로그·트레이스·피드백은 활성이고, Replay는 별도 명시적
  opt-in이 없으면 비활성이다. 향후 활성화하면 오류 세션 100%·일반 세션
  10%, 일반 텍스트·미디어·입력 unmasked 설정이 적용되므로 정책·고지를
  먼저 재검증한다.
- checkout의 청약철회 제한 compile-time 구현 fence는 결제 버튼 위 고지(결제 클릭=확인)와
  사용자·주문·상품·금액·모드·채널·표시 문구/버전·시각·요청 ID 불변 증거,
  원자 주문 wrapper와 사후 재조회까지 현재 source에 구현되어 있다. 실제 제공은
  26개 expand migration, 같은 release SHA의 앱, 3개 contract migration과 smoke를
  모두 마친 뒤 `PAYMENT_CHECKOUT_ENABLED=1`인 배포에서만 가능하고, 이 문서는 그
  운영 완료를 미리 주장하지 않는다. 일반/TEST 여부는 계정 판정과 구매 화면 표시를
  따른다. 상품·가격 화면은 그날 표시한 exact snapshot의 6개월 증거를 먼저 기록한
  경우에만 렌더한다.
- fal.ai 생성 전체는 별도의 compile-time 외부 준법 fence로 닫혀 있다.
  기본 게임의 만 14세 확인과 별개로 대한민국 이용자의 만 19세 자기확인,
  fal Terms/AUP 각각의 명시적 동의는
  `generation_provider_acceptance_evidence`와 status/record/prune RPC, UI/API에
  구현되어 탈퇴 세대·현재 효력 legal version·bundle version과 불변 결속된다.
  2026-07-31 제품 오너 결정으로 `FAL_EXTERNAL_COMPLIANCE_APPROVED=true`로
  전환하고 acceptance를 강제 게이트가 아닌 기록 가능한 원장으로 두었다.
  정확한 국외 하위처리자·국가·기간 목록, 얼굴/PII 서면 허용·DPA,
  private ACL/owner-token 계약은 미확보 상태의 법무 후속으로 남아 있으며,
  그 잔여 리스크는 제품 결정으로 수용됐다.
- 얼굴 원본, fal payload·미디어, 후보, 하이라이트, 텔레메트리, 유입 분석,
  공개 쓰기 HMAC, 결제, 신고와 계정 삭제의 기간은 실제 코드·DB worker의
  경계값과 일치시켰다.
- 외부 이메일 민원은 자동 worker 실패가 아니라
  `external_consumer_complaint_manual_retention_runbook` 수동 운영 경계다.
  `dev.jangahn@gmail.com` 접수, 안병욱 책임, 접근제한 대장, 최초 종결시각,
  strict `> 3 years`, legal hold와 월별 건수·해시 파기증적을 확인한다.

정본 작성의 주된 외부 기준은 개인정보보호위원회의
[2026 개인정보 처리방침 작성지침](https://www.pipc.go.kr/np/cop/bbs/selectBoardArticle.do?bbsId=BS217&mCode=D010030020&nttId=12018),
[생성형 AI 부록 개정 설명](https://www.pipc.go.kr/np/cop/bbs/selectBoardArticle.do?bbsId=BS074&mCode=C020010000&nttId=12021),
현행 개인정보 보호법 제21조·제28조의8, 전자상거래법령의 결제 5년·소비자
불만 3년·표시광고 6개월 보존 기준이다. 외부 AI 고지는 fal의
[Data Retention & Storage](https://fal.ai/docs/documentation/model-apis/media-expiration),
[Terms of Service](https://fal.ai/legal/terms-of-service)와
[Acceptable Use Policy](https://fal.ai/legal/acceptable-use-policy),
[Privacy Policy](https://fal.ai/legal/privacy-policy)를 구분해 반영했다.
`X-Fal-Store-IO: 0`은 JSON payload 저장만 막으며 공급자 약관상 비식별·집계
Usage Data 가능성까지 없애는 opt-out 약정이라고 표현하지 않는다.
2026-07-30 확인 기준 fal Terms의 표시 개정일은 2026-03-03이고 End User의
성년·Terms/AUP 준수를 고객이 보장하도록 요구한다. AUP §7은 PII·개인 이미지·
생체정보 처리 제한을 포함하므로 본 서비스의 얼굴 입력이 허용된다는 서면 확인
없이 공개 문구만으로 허용을 추정하지 않는다. fal Privacy Policy는 미국과
그 밖의 국가 처리를 설명할 뿐 본 서비스의 exact subprocessor 국가·기간을
확정하지 않으므로 `미국` 하나로 축약해 발행하지 않는다.

## 현재 publication blocker — 외부 증거만

`LEGAL_V2.rollout.publicationBlockers`에는 현재 다음 다섯 외부 확인만 남아 있다.

- `fal_exact_subprocessor_country_retention_inventory`
- `fal_written_face_pii_dpa_confirmation`
- `fal_private_acl_owner_token_contract`
- `vercel_exact_transfer_country_retention_inventory`
- `google_oauth_exact_transfer_country_retention_inventory`

checkout 청약철회 제한 증거와 생성 공급자 만 19세·Terms/AUP flow-down 증거는
구현되어 위 배열에서 제거됐다. migration 적용, production 배포, smoke와 30일
사전고지는 여전히 필수 운영 전제지만 “미구현 publication blocker”로 다시
분류하지 않는다. 외부 다섯 항목 중 하나라도 남으면 stage는 가능해도 publish는
fail-closed한다.

## 자동 검증

정본, 환불권, 잘못된 과장 금지, KST 시행 경계, v1→v2 재동의, CLI 안전장치와
양 문서 원자 SQL을 한 테스트에서 검증한다.

```sh
node --experimental-strip-types --test \
  __tests__/legal/v2-documents.test.ts \
  __tests__/legal/activation-cache.test.ts \
  __tests__/legal/generation-commerce-compliance.test.ts
```

전체 Node 회귀는 아래 명령으로 실행한다.

```sh
npm test
```

필수 합격 조건은 다음과 같다.

- 두 문서가 RPC와 동일한 제목·섹션·본문·전체 UTF-8 크기 제한을 만족한다.
- 인증 쿠키가 `HttpOnly=false`임을 숨기지 않고 `Secure=true`,
  `SameSite=Lax`를 함께 설명한다.
- Replay는 기본 비활성이고, opt-in 시 100%/10%와 unmasked 범위를 설명한다.
- fal 10분 입력 URL, 8분 queue start, 비정상 12분 원본 정리와 후보
  24시간 경계가 존재한다. 반면 공개 CDN 기본 동작과 다른 private ACL 값,
  5분 owner-token 읽기·짧은 만료 계약은 현재 보장 사실로 쓰지 않고 fal의
  서면 확인·DPA와 통합 검증이 끝날 때까지 blocker로 유지한다.
- 서비스 자체 학습과 fal의 비식별·집계 Usage Data 가능성을 분리한다.
- 결제 상세 최소 5년, 종결 신고 정확히 3년까지 보존 후 `>3년` 파기,
  구매 표시·광고 exact snapshot은 마지막 표시부터 최소 6개월 보존,
  외부 이메일 수동 SOP, 계정 삭제 최소 2시간 5분 최종 fence가 존재한다.
- 약관 제10조의 v1 소비자 권리 전체가 유지된다: 1년 유효기간, 유효기간 내
  미사용분 상시 환불, 7일 내 100%, 이후 90%, 사용분·무상분 제외,
  만료 유료분 구매일부터 5년까지 90%, 탈퇴 전 청구, 3영업일, 원 결제수단,
  대체 포인트 금지와 정당한 권리행사 보호.
- KST 시행일 자정, 즉 전날 UTC 15:00:00에 v1 동의 회원에게 terms·privacy
  두 항목이 함께 재동의 대상으로 바뀐다.
- API 응답은 browser/CDN `no-store`이고 edge isolate cache는 KST 달력일을
  identity에 포함하며 다음 KST 자정에 expiry가 잘린다. 시행 뒤 stale v1을
  허용하는 유예 시간은 0초다.
- CLI는 인자 없이 read-only이고 stage·publish·cancel은 서로 다른 정확한
  확인문구, CAS identity와 operation receipt를 요구한다. privacy+terms
  예약 취소도 한 SQL statement/transaction으로만 수행한다.
- 운영 v1의 정규화 SHA-256, 섹션 수, 7일/30일 변경고지와 유료 생성권
  환불권 semantic matrix가 `legal/v1-production-snapshot.mjs`와 일치한다.

## 운영 전제

아래 적용은 다음 전제를 모두 충족한 뒤 수행한다.

1. fresh-chain DB 검증과 앱 테스트·typecheck·lint·build가 합격했다.
2. 최소 `0081_legal_state_machine_idempotency.sql`까지 운영 DB에 적용되어
   strict legal RPC와 `legal_operation_receipts`가 존재한다. 보존 고지까지
   시행하려면 `008904_privacy_retention_controls.sql`,
   `008905_legal_commerce_generation_compliance.sql`과 관련 앱 코드도 함께
   배포되어야 한다.
3. Sentry Replay default-off와 fal 생성 hard-off가 배포된 빌드인지 확인한다.
   checkout은 운영 DB contract와 smoke가 끝나기 전까지 runtime rollout env로
   hard-off하고, 이후 활성 배포도 분리 확인·불변 증거 경계를 포함해야 한다.
4. 운영 `business_info`가 제이엔에이·안병욱·사업자등록번호
   `220-11-70445`와 일치하고 `emfoa23@gmail.com`이 활성 admin 한 명으로
   조회되어야 한다.
5. v2는 불리하거나 중대한 변경으로 분류한다. 최초 공개 고지 시각부터
   시행일 KST 자정까지 완전한 `30×24시간` 이상이어야 하며 1ms라도
   부족하면 거부한다. 실행 시각과 무관한 운영 기본값은 오늘 `+31일`이다.
   DB trigger는 보수적으로 privacy/terms의 모든 `version >= 2` 발행에 같은
   불변식을 적용하고, 이미 적법하게 예약된 행의 무관한 내부 갱신·취소는
   재고지로 오인하지 않는다.
6. `LEGAL_V2.rollout.publicationBlockers`가 빈 배열이어야 한다. 현재 정본의
   fal exact 국가·기간/DPA·얼굴 처리 서면 확인과 Vercel/Google exact 이전
   inventory 같은 외부 blocker 중 하나라도 남아 있으면 publish는 의도적으로
   실패한다. 생성 연령/flow-down과 checkout 청약철회 제한 증거는 source에
   구현되어 blocker에서 제거됐고, 최종 release 검증·운영 적용은 별도 전제다.

helper는 승인된 운영 project ref, v1 정규화 digest, 0081·008904·008905
migration receipt, strict RPC의 owner=`postgres`·SECURITY DEFINER·empty
search_path·service-role-only ACL·exact source-body SHA-256를 모두 대조한다.
어느 하나라도 다르면 `production_target_fingerprint_mismatch` 또는
`production_v1_snapshot_mismatch`로 fail-closed하며 우회하지 않는다.

## 정확한 운영 명령

아래 명령은 macOS zsh 기준이다. 토큰 값을 출력하지 않고
`~/.zshenv`의 개인 boss-paegi 변수만 현재 셸에 불러온다.

```sh
cd /Users/user/Development/Personal/emfoa23/boss-paegi
source ~/.zshenv >/dev/null 2>&1
# 실행 시각과 무관하게 KST 시행 자정 전 완전한 30×24시간을 확보하는
# 보수적 기본값이다. +30d는 KST 00:00 직후 실행한 경우 외에는 부족하다.
LEGAL_EFFECTIVE_DATE=$(TZ=Asia/Seoul date -v+31d '+%Y-%m-%d')
```

먼저 production을 읽기만 한다. 인자를 생략해도 기본 모드는 dry-run이지만,
시행일 계획까지 검증하려면 아래처럼 날짜를 준다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode dry-run \
  --effective-date "$LEGAL_EFFECTIVE_DATE"
```

출력에서 다음을 확인한다.

- `mutated: false`
- v1 상태에서는 privacy·terms 모두 `latestPublishedVersion: 1`
- 관계없는 draft가 없으면 `plan.stage.ready: true`
- blocker가 남은 동안 `plan.publish.blocker`는
  `publication_blockers_unresolved`
- source digest가 이후 모든 실행에서 동일

두 초안을 하나의 SQL statement/transaction으로 원자 저장한다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode stage \
  --apply \
  --confirm STAGE-BOSS-PAEGI-LEGAL-V2
```

관계없는 기존 초안이 있으면 기본 stage는 덮어쓰지 않고 실패한다. 그 초안이
폐기 대상임을 별도로 검토한 뒤에만 아래 명령을 사용한다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode stage \
  --apply \
  --replace-existing-draft \
  --confirm REPLACE-DRAFT-AND-STAGE-BOSS-PAEGI-LEGAL-V2
```

stage 후 dry-run에서 두 draft가 모두 `canonical`인지 확인한다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode dry-run \
  --effective-date "$LEGAL_EFFECTIVE_DATE"
```

아래 publish 명령은 정본 blocker가 실제 증거로 모두 해소되고 정본의
`publicationBlockers`가 비어 있으며 최초 고지일부터 완전한 KST 달력일
30일이 지난 경우에만 실행한다. 두 문서를 같은 KST 시행일로 하나의 SQL
statement/transaction에서 예약하며 helper는 29일 이하를 거부한다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode publish \
  --apply \
  --effective-date "$LEGAL_EFFECTIVE_DATE" \
  --confirm PUBLISH-BOSS-PAEGI-LEGAL-V2
```

응답 유실 뒤 같은 명령을 다시 실행해도 deterministic operation UUID와 DB
receipt가 중복 버전·감사행을 만들지 않는다. 한 문서가 이미 같은 v2로 예약된
부분 복구 상황에서도 시행일이 정확히 같고 다른 문서의 canonical draft가 있을
때만 나머지를 진행한다.

## 예약 후 검증과 시행 전 취소

예약 직후 다음을 확인한다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode dry-run \
  --effective-date "$LEGAL_EFFECTIVE_DATE"

curl --silent --show-error --fail \
  https://boss-paegi.vercel.app/privacy | rg '시행 예정|버전 2'

curl --silent --show-error --fail \
  https://boss-paegi.vercel.app/terms | rg '시행 예정|버전 2'
```

공개 페이지에서 시행 예정본 링크를 열어 다음을 사람 눈으로 확인한다.

- 한글 줄바꿈·번호·링크가 잘리지 않고 privacy 18개, terms 16개가 보인다.
- 개인정보처리방침의 Sentry Replay는 현재 비활성으로 표시된다.
- 약관 제4조는 청약철회 제한의 분리 확인·불변 증거가 구현됐고 실제 결제
  제공 여부와 일반/TEST 표시는 운영 게이트·구매 화면을 따른다고 표시된다.
- 개인정보처리방침과 약관은 fal 국외 이전·생성이 현재 비활성이고 exact
  국가·기간·얼굴 처리 서면 확인 전에는 열지 않는다고 표시된다. 별도
  19세/Terms/AUP 증거 경계는 이미 구현됐지만 외부 준법 조건을 대신하지 않는다.
- 약관 제10조 환불 조항의 숫자와 순서가 테스트 결과와 같다.
- 두 문서의 시행일이 완전히 같다.

시행 전 결함이 발견되면 관리자 UI에서 문서별로 나눠 취소하지 않는다. 다음
helper 명령만 사용해 privacy+terms를 한 SQL statement/transaction에서
원자 취소하고 durable receipt와 canonical draft 복구를 검증한다.

```sh
node scripts/qa/legal-v2-rollout.mjs \
  --mode cancel \
  --apply \
  --effective-date "$LEGAL_EFFECTIVE_DATE" \
  --confirm CANCEL-BOSS-PAEGI-LEGAL-V2
```

DB는 시행일이 지난 문서의 unpublish를 거부한다. 응답 유실 뒤 같은 명령을
재실행하면 deterministic operation UUID와 receipt로 이미 완료된 양문서 취소를
복구한다. receipt 없는 한쪽짜리 post-state는 split-brain으로 거부한다.
정본 수정→전체 테스트→stage→publish를 반복한다.

## KST 시행 경계 검증

시행 전 마지막 v1 동의 회원 한 명과 v2 동의 QA 회원 한 명을 준비한다.
운영에서 파괴적 계정 시나리오는 수행하지 않는다.

시행일 KST 00:00 직후 다음을 확인한다.

```sh
curl --silent --show-error --fail \
  https://boss-paegi.vercel.app/api/legal/versions | jq -e \
  '.terms == 2 and .privacy == 2'
```

- v1 회원은 회원 전용 목적지 대신 `/consent`로 이동하고 약관·방침 두 문서가
  모두 미동의로 표시된다.
- 한 항목만 체크하거나 v1 버전을 제출하면 서버가 완료로 처리하지 않는다.
- 두 v2와 연령 상태를 유효하게 제출하면 원래 안전한 목적지로 한 번만 이동한다.
- 이미 v2에 동의한 회원과 더 높은 버전 스탬프를 가진 합성 테스트는 재동의
  루프에 빠지지 않는다.
- 익명 기본 게임, 공개 약관·방침·신고 화면은 재동의 게이트 때문에 사라지지
  않는다.
- API는 browser/CDN `no-store`이고 edge cache의 expiry는 다음 KST 자정으로
  잘리며 KST 달력일이 identity에 포함된다. UTC 14:59:59.999의 cache entry도
  UTC 15:00:00.000부터 사용할 수 없어야 한다. 시행 뒤 어느 표면에서도 v1을
  1초라도 허용하면 실패다.

## 운영 증적

배포 기록에는 비밀값 없이 다음만 남긴다.

- 배포 commit과 migration ledger의 0081·008904·008905 상태 및 strict RPC
  source-body digest/ACL 확인 결과
- 운영 v1 privacy·terms 정규화 digest와 semantic rights matrix 확인 결과
- `canonicalDigest` SHA-256
- stage·publish·필요 시 atomic cancel 결과의 문서별 버전·시행일과 operation
  receipt 성공 여부
- 시행 예정 공개 페이지 캡처
- KST 경계 전후 `/api/legal/versions`와 v1→v2 재동의 결과
- 외부 이메일 민원 수동 대장의 월별 점검 여부와 파기 건수·상태 해시
- 6개월 표시 증거의 snapshot hash·최초/최종 표시 시각·최소 보존시각과 cron
  drain 결과(사용자·원문 payload 제외)
- Sentry Replay opt-in이 계속 꺼져 있는지, analytics·checkout runtime
  rollout gate·fal 생성 compile/runtime gate가 정책 문구와 같은지

비밀 토큰, admin UUID, 사용자 이메일 목록, 신고 원문과 결제 원문 payload는
증적에 복사하지 않는다.
