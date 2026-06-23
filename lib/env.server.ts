import "server-only";

export const SERVER_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  FAL_KEY: process.env.FAL_KEY!,
  // 운영 계정 — 생성권 무제한. 미설정이면 무제한 계정 없음.
  OPS_USER_ID: process.env.OPS_USER_ID ?? "",
  // 페이앱(무사업자) 결제 연동값 — 판매자 관리 > 설정 > 연동정보.
  // 미설정 시 결제 라우트 비활성(503). LINKVAL 은 웹훅 위변조 차단 핵심.
  PAYAPP_USERID: process.env.PAYAPP_USERID ?? "",
  PAYAPP_LINKVAL: process.env.PAYAPP_LINKVAL ?? "",
  // LINKKEY: v2 취소 API(paycancel/paycancelreq)용 예약 — v1(수동 환불)은 미사용.
  PAYAPP_LINKKEY: process.env.PAYAPP_LINKKEY ?? "",
};
