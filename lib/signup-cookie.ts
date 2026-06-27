import "server-only";
import crypto from "node:crypto";
import { SERVER_ENV } from "@/lib/env.server";

// 익명→신규회원 데이터 마이그용 쿠키. anon user.id 를 HMAC 서명해 위조 차단(평문 신뢰 금지).
// 이름은 edge(proxy) 공용 단일 소스(lib/cookies)에서 재수출 — 기존 import 경로 유지.
export { MIGRATE_COOKIE } from "@/lib/cookies";
export const MIGRATE_MAX_AGE = 15 * 60; // 15분

function mac(payload: string): string {
  return crypto
    .createHmac("sha256", SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY)
    .update(payload)
    .digest("hex");
}

/** `{anonId}.{exp}.{hmac}` — prepare-signup 에서 서버 세션의 anon id 로만 발급. */
export function signMigrateValue(anonId: string): string {
  const exp = String(Date.now() + MIGRATE_MAX_AGE * 1000);
  return `${anonId}.${exp}.${mac(`${anonId}.${exp}`)}`;
}

/** 검증 — UUID 형식·TTL·HMAC(상수시간 비교). 통과 시 anonId, 아니면 null. */
export function verifyMigrateValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [anonId, exp, sig] = parts;
  if (!/^[0-9a-fA-F-]{36}$/.test(anonId)) return null;
  const expN = Number(exp);
  if (!Number.isFinite(expN) || expN < Date.now()) return null;
  const expected = mac(`${anonId}.${exp}`);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return anonId;
}
