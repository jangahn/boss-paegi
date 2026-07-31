# 제품 결정 권한 — 절대 경계 (2026-07-31, 사용자 지시로 명문화)

기능 QA·버그 수정·보안 하드닝 요청은 **제품·UX·사업 결정을 바꿀 권한이 아니다**.
아래는 사용자가 해당 항목을 명시적으로 지시한 경우가 아니면 **절대 금지**이며,
기술적·법무적 명분(컴플라이언스, 리스크 축소, "안전한 기본값")으로도 정당화되지 않는다.

1. **라이브 기능 비활성화·동결 금지** — env 게이트, 컴파일타임 펜스, 503 freeze 등 어떤 형태로도.
2. **신규 동의·체크박스·게이트·강제 확인 화면 추가 금지** — 구매·생성·로그인 어느 흐름에도.
3. **결제 흐름·가격·상품 구성·환불 정책 변경 금지.**
4. **화면 요소 변경 금지** — 버튼 크기·폰트·간격·레이아웃은 확정 디자인 baseline 유지.
5. **운영 env 변수·분기 신설 금지** — 복잡한 우회 구조 대신 단순·직관 구현. 스위치가 필요하면 먼저 물어라.
6. 법무/컴플라이언스 우려는 기능을 끄는 방식이 아니라 **보고 후 사용자 결정 대기**로 처리한다.
7. UI·접근성 수정은 **실기기/실브라우저 검증 없이 병합 금지** — 라이브러리를 mock으로 고정한
   단위 테스트의 자기일관 green은 검증이 아니다.

위반 실사례(2026-07-29~31 QA에서 발생, 전부 원복·수정됨 — **반복 금지**): 생성 기능 동결
(`GENERATION_COST_PATH_ENABLED`·`FAL_EXTERNAL_COMPLIANCE_APPROVED`), fal 19+/ToS/AUP 강제 동의
게이트, 결제 청약철회 체크박스 강제, `PAYMENT_CHECKOUT_ENABLED` freeze, `OPS_USER_ID` 특례,
헤더 버튼 축소(44px 미달), OAuth 콜백 무스타일 빈 화면 2회, 게임 종료 화면 포커스 스크롤 점프,
계정 메뉴 iOS 포커스 링(파란 줄), 실브라우저 전면 로그인 차단(mock 자기일관으로 미검출).

## Mandatory KB preflight

Before any boss-paegi investigation or work, read these local Knowledge Base sources first:

1. `/Users/user/KnowledgeBase/_meta/conventions.md`
2. `/Users/user/KnowledgeBase/personal/projects/boss-paegi.md`
3. Every task-relevant note in `/Users/user/KnowledgeBase/personal/projects/boss-paegi/`
4. For QA, security, operations, deployment, or runtime checks: `/Users/user/KnowledgeBase/personal/infra.md`, `boss-paegi/infra.md`, and `boss-paegi/known-non-issues.md`

For a service-wide QA request, read the complete boss-paegi note set before code/runtime testing. Do not wait for the user to remind you. Use the KB to identify `BOSS_PAEGI_*` variables in `~/.zshenv`; never print secret values. The local `.env.local` points at production services, so treat local browser actions as production-impacting until proven otherwise.

<!-- BEGIN:nextjs-agent-rules -->
# 제품 결정 권한 — 절대 경계 (2026-07-31, 사용자 지시로 명문화)

기능 QA·버그 수정·보안 하드닝 요청은 **제품·UX·사업 결정을 바꿀 권한이 아니다**.
아래는 사용자가 해당 항목을 명시적으로 지시한 경우가 아니면 **절대 금지**이며,
기술적·법무적 명분(컴플라이언스, 리스크 축소, "안전한 기본값")으로도 정당화되지 않는다.

1. **라이브 기능 비활성화·동결 금지** — env 게이트, 컴파일타임 펜스, 503 freeze 등 어떤 형태로도.
2. **신규 동의·체크박스·게이트·강제 확인 화면 추가 금지** — 구매·생성·로그인 어느 흐름에도.
3. **결제 흐름·가격·상품 구성·환불 정책 변경 금지.**
4. **화면 요소 변경 금지** — 버튼 크기·폰트·간격·레이아웃은 확정 디자인 baseline 유지.
5. **운영 env 변수·분기 신설 금지** — 복잡한 우회 구조 대신 단순·직관 구현. 스위치가 필요하면 먼저 물어라.
6. 법무/컴플라이언스 우려는 기능을 끄는 방식이 아니라 **보고 후 사용자 결정 대기**로 처리한다.
7. UI·접근성 수정은 **실기기/실브라우저 검증 없이 병합 금지** — 라이브러리를 mock으로 고정한
   단위 테스트의 자기일관 green은 검증이 아니다.

위반 실사례(2026-07-29~31 QA에서 발생, 전부 원복·수정됨 — **반복 금지**): 생성 기능 동결
(`GENERATION_COST_PATH_ENABLED`·`FAL_EXTERNAL_COMPLIANCE_APPROVED`), fal 19+/ToS/AUP 강제 동의
게이트, 결제 청약철회 체크박스 강제, `PAYMENT_CHECKOUT_ENABLED` freeze, `OPS_USER_ID` 특례,
헤더 버튼 축소(44px 미달), OAuth 콜백 무스타일 빈 화면 2회, 게임 종료 화면 포커스 스크롤 점프,
계정 메뉴 iOS 포커스 링(파란 줄), 실브라우저 전면 로그인 차단(mock 자기일관으로 미검출).

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
