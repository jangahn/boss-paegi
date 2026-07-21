import "server-only";

export const SERVER_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  FAL_KEY: process.env.FAL_KEY!,
  // 운영 계정 — 생성권 무제한. 미설정이면 무제한 계정 없음.
  OPS_USER_ID: process.env.OPS_USER_ID ?? "",
  // 포트원(PortOne) V2 — 콘솔 [연동 관리]>[식별코드·API Keys]>[V2 API]. 발급 직후에만 값 확인 가능.
  // 미설정 시 결제 라우트 비활성(503). 단건 조회·취소 공용 시크릿.
  PORTONE_V2_API_SECRET: process.env.PORTONE_V2_API_SECRET ?? "",
  // 포트원 웹훅 서명 시크릿(Standard Webhooks, whsec_~) — 콘솔 [결제알림(Webhook) 관리]에서 발급.
  // 테스트/실연동 환경별 별도 설정. 미설정 시 웹훅 라우트 비활성.
  PORTONE_WEBHOOK_SECRET: process.env.PORTONE_WEBHOOK_SECRET ?? "",
  // 대사 cron(cron-job.org → /api/ops/reconcile) 보호 시크릿. 미설정 시 reconcile 비활성(503).
  CRON_SECRET: process.env.CRON_SECRET ?? "",
};
