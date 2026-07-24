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
  // 테스트/실연동 환경이 **동시 운영**되므로 시크릿 2개를 병존시킨다(검증은 실연동 → 테스트 순 시도).
  // 무접미사 = 실연동 환경, _TEST = 테스트 환경. 둘 다 미설정 시 웹훅 라우트 비활성.
  PORTONE_WEBHOOK_SECRET: process.env.PORTONE_WEBHOOK_SECRET ?? "",
  PORTONE_WEBHOOK_SECRET_TEST: process.env.PORTONE_WEBHOOK_SECRET_TEST ?? "",
  // 대사 cron(cron-job.org → /api/ops/reconcile) 보호 시크릿. 미설정 시 reconcile 비활성(503).
  CRON_SECRET: process.env.CRON_SECRET ?? "",
  // Phase-A 크레딧 유지보수 게이트(v0.76 환불 saga 컷오버) — open|closed|canary. 미설정=open(동작 무변화).
  // closed: 신규 money 진입 라우트가 503 service_maintenance. canary: 아래 allowlist 계정만 진입 허용.
  // 값 전이는 배포 절차(runbook)이지 코드가 아니다 — lib/credits-gate.ts 참조.
  CREDITS_MAINTENANCE_MODE: process.env.CREDITS_MAINTENANCE_MODE ?? "open",
  // canary 모드에서 신규 진입을 허용할 사용자 UUID 목록(콤마 구분).
  CREDITS_CANARY_USER_IDS: process.env.CREDITS_CANARY_USER_IDS ?? "",
};
