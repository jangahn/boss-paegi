import "server-only";
import crypto from "node:crypto";
import { SERVER_ENV } from "@/lib/env.server";

// 익명→신규회원 데이터 마이그용 쿠키. anon user.id 를 HMAC 서명해 위조 차단(평문 신뢰 금지).
// 이름은 edge(proxy) 공용 단일 소스(lib/cookies)에서 재수출 — 기존 import 경로 유지.
export {
  MIGRATE_COOKIE,
  MIGRATE_COOKIE_PREFIX,
} from "@/lib/cookies";
import { MIGRATE_COOKIE_PREFIX } from "@/lib/cookies";
export const MIGRATE_MAX_AGE = 15 * 60; // 15분
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function mac(payload: string): string {
  return crypto
    .createHmac("sha256", SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY)
    .update(payload)
    .digest("hex");
}

export function migrateCookieName(flowId: string): string {
  if (!UUID_RE.test(flowId)) {
    throw new Error("invalid_migration_flow_id");
  }
  return `${MIGRATE_COOKIE_PREFIX}${flowId}`;
}

/**
 * `v2.{flowId}.{anonId}.{exp}.{hmac}` — the flow is part of both the name and
 * signature, so a later OAuth in another tab cannot replace or consume this
 * migration authority.
 */
export function signMigrateValue(
  anonId: string,
  flowId: string,
): string {
  if (!UUID_RE.test(anonId) || !UUID_RE.test(flowId)) {
    throw new Error("invalid_migration_proof_input");
  }
  const exp = String(Date.now() + MIGRATE_MAX_AGE * 1000);
  const payload = `v2.${flowId}.${anonId}.${exp}`;
  return `${payload}.${mac(payload)}`;
}

