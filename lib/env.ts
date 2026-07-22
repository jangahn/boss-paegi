export const PUBLIC_ENV = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  // 공유·유입 분석 수집 게이트 — production 자동 on, 로컬은 NEXT_PUBLIC_ANALYTICS_ENABLED=1 로 켬(미설정 시 off).
  ANALYTICS_ENABLED:
    process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "1" || process.env.NODE_ENV === "production",
  // ── 포트원(PortOne) V2 — 클라 브라우저 SDK 호출용 공개 식별자 ──
  // ⚠️ 이 프로젝트 유일한 클라측 결제 env. storeId·channelKey 는 포트원 설계상 공개 안전값
  //    (요청 식별용 — 결제 승인·취소·조회 권한은 서버 전용 PORTONE_V2_API_SECRET 에만 있음).
  //    서버 시크릿(API Secret·웹훅 시크릿)은 절대 NEXT_PUBLIC_ 로 만들지 말 것.
  // 채널키는 콘솔 채널관리의 채널별 발급값 — 실연동/테스트 채널이 **동시 운영**된다(계정 기반 스위칭).
  // 무접미사 = 실연동(일반 유저), _TEST = 테스트 채널(심사·테스트 계정 전용 — lib/pay-channels.ts).
  PORTONE_STORE_ID: process.env.NEXT_PUBLIC_PORTONE_STORE_ID ?? "",
  PORTONE_CHANNEL_KEY_CARD: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD ?? "", // KPN 신용카드 일반결제
  PORTONE_CHANNEL_KEY_TOSSPAY: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY ?? "",
  PORTONE_CHANNEL_KEY_KAKAOPAY: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY ?? "",
  PORTONE_CHANNEL_KEY_CARD_TEST: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST ?? "",
  PORTONE_CHANNEL_KEY_TOSSPAY_TEST: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST ?? "",
  PORTONE_CHANNEL_KEY_KAKAOPAY_TEST: process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST ?? "",
};
