# 포트원 전환 런북 (2026-07 — PG 심사 대응 포함)

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
4. 심사 계정으로 `/credits` 진입 → 수단 3종 각각 결제창이 뜨는지 확인(스마트폰에서 카카오페이 리다이렉트 흐름도 확인). 테스트 결제 1건 완주 → 크레딧 지급·어드민 주문 반영·웹훅 로그 확인(테스트 결제는 매입 전 자동취소, KB국민·NH농협·카카오뱅크 카드는 테스트 불가).

## 5. 포트원에 회신
- 받은 메일(cs@portone.io) 회신 또는 채널톡: "테스트모드 설정 및 결제모듈 호출 구현 완료. 서비스 URL: https://boss-paegi.vercel.app — 결제페이지는 로그인 후 /credits 이며, 심사용 계정을 안내드립니다: (계정/로그인 방법)". 심사용 계정 전달 방식은 담당자에게 확인(문서에 명시된 절차 없음).

## 6. 약관·개인정보처리방침 개정 (콘솔 — 코드 배포 불요)
`/admin/content/legal` 에서 수정 후 발행. **발행 시 전 회원 재동의가 강제(60초 내 전파)** — 전환 배포와 묶어 1회로.
- 약관 제10조: "결제대행사(페이앱)" → "결제대행사(포트원을 통한 한국결제네트웍스·토스페이·카카오페이)"
- 처리방침 수집항목: "페이앱 결제번호(mul_no)" → "결제대행사 거래번호(paymentId·transactionId)", 더미 연락처 서술 제거
- 처리방침 수탁자: "㈜페이앱(PayApp) — 결제 처리 및 취소·환불" → "㈜코리아포트원(PortOne) 및 결제대행사(한국결제네트웍스·㈜비바리퍼블리카(토스페이)·㈜카카오페이) — 결제 처리 및 취소·환불"
- 국외이전 항목의 "㈜페이앱은 국내 사업자" 서술 갱신(포트원·PG 3사 전부 국내)

## 7. 계약 완료 후 (실모드 전환 — 별도 작업)
- **(0059 이후 채널 이원화)** 기존 테스트 채널키는 `NEXT_PUBLIC_PORTONE_CHANNEL_KEY_*_TEST` / `PORTONE_WEBHOOK_SECRET_TEST` 로 이관하고 **계속 유지**한다(심사·테스트 계정 상시 테스트 결제 경로 — 승인 후에도 숨김 진입 유지가 요구사항).
- KPN·토스페이·카카오페이 계약 완료 메일로 실 MID(KPN: MID+Secret OTP, 카카오페이: CA~ CID) 수령 → 콘솔에서 **실연동 채널 3개** 추가 → 무접미사 env(`NEXT_PUBLIC_PORTONE_CHANNEL_KEY_*` + `PORTONE_WEBHOOK_SECRET`)에 실연동 값 기입.
- ⚠️ **카드사 심사 완료 전 실연동 결제는 실패가 정상** — 심사 완료 확인 후 creditsEnabled ON.
- Sentry: `payapp.*` 기반 알림 모니터를 `pay.*` 이벤트명으로 재설정(`pay.wh_grant_fail`·`pay.wh_amount_mismatch`·`pay.wh_paid_not_granted`·`pay.refund_commit_fail`·`pay.stale_payment_request`, 임계 1) + 채널 대사 백스톱 `pay.*_test_channel_on_live_order` 추가(임계 1 — 무료 크레딧 시도 신호).
- ~~reviewerEmails 비우기(심사 종료 시)~~ → **유지**(심사·테스트 계정은 승인 후에도 테스트 채널 상시 운영 — 0059 채널 이원화로 실매출 오염 없음).

## 참고 (조사 확정 사실)
- 심사 = PG 입점심사 + 카드사 심사(통상 ~2주), 심사관이 신청서 기재 URL 직접 접속. 결제창 호출·카드사 목록 노출까지만 확인(결제 성공 불필요). 로그인 뒤 결제페이지는 심사용 계정 제공으로 대응(공식 문서화된 방식).
- dev/test/staging URL 심사는 하나카드 반려 리스크 + 실 URL 전환 시 재심사.
- 메일의 '본인인증 서비스' 섹션은 결제와 별개의 선택 서비스 — 결제만 신청한 현재는 해당 없음.
- 테스트→실연동 전환은 채널키 env 교체만(코드 불변). 웹훅 URL 은 환경별 콘솔 설정.
