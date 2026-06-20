import "server-only";

export const SERVER_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  FAL_KEY: process.env.FAL_KEY!,
  // 운영 계정 — 생성권 무제한. 미설정이면 무제한 계정 없음.
  OPS_USER_ID: process.env.OPS_USER_ID ?? "",
};
