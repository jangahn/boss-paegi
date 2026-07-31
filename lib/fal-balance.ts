import "server-only";
import { log, errInfo } from "@/lib/log";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";

/**
 * fal.ai 계정 잔액 hard cap.
 *
 * GET https://api.fal.ai/v1/account/billing?expand=credits — ADMIN scope
 * API key 필요 (일반 키 불가). FAL_ADMIN_KEY 미설정/조회 실패 시에는
 * 차단하지 않고 통과한다 (graceful degrade — 잔액 체크가 서비스를 죽이면
 * 안 된다는 2026-07-31 제품 결정). 응답 파싱만 bounded/strict로 유지한다.
 */

const HARD_CAP_USD = 2;
const CACHE_TTL_MS = 60_000;
export const FAL_BILLING_RESPONSE_MAX_BYTES = 64 * 1024;
export const FAL_BILLING_TIMEOUT_MS = 5_000;

let cached: { balance: number; at: number } | null = null;

export type BalanceCheck =
  | { ok: true; balance: number | null }
  | { ok: false; balance: number };

export async function checkFalBalance(): Promise<BalanceCheck> {
  const adminKey = process.env.FAL_ADMIN_KEY;
  if (!adminKey) return { ok: true, balance: null }; // 키 없음 — 체크 skip

  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.balance < HARD_CAP_USD
      ? { ok: false, balance: cached.balance }
      : { ok: true, balance: cached.balance };
  }

  try {
    const res = await fetch(
      "https://api.fal.ai/v1/account/billing?expand=credits",
      {
        headers: { Authorization: `Key ${adminKey}` },
        signal: AbortSignal.timeout(FAL_BILLING_TIMEOUT_MS),
        redirect: "error",
      }
    );
    if (!res.ok) {
      log.warn("falbal.api_error", { status: res.status });
      return { ok: true, balance: null };
    }
    const bounded = await readBoundedResponseBytes(
      res,
      FAL_BILLING_RESPONSE_MAX_BYTES,
    );
    if (!bounded.ok) {
      log.warn("falbal.body_invalid", { error: bounded.error });
      return { ok: true, balance: null };
    }
    let data: { credits?: { current_balance?: number } };
    try {
      data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
      ) as { credits?: { current_balance?: number } };
    } catch (e) {
      log.warn("falbal.body_invalid", errInfo(e));
      return { ok: true, balance: null };
    }
    const balance = data.credits?.current_balance;
    if (
      typeof balance !== "number" ||
      !Number.isFinite(balance) ||
      balance < 0
    ) {
      log.warn("falbal.no_balance_field", {});
      return { ok: true, balance: null };
    }
    cached = { balance, at: now };
    if (balance < HARD_CAP_USD) {
      log.warn("falbal.hard_cap_hit", { balance, cap: HARD_CAP_USD });
      return { ok: false, balance };
    }
    log.info("falbal.ok", { balance });
    return { ok: true, balance };
  } catch (e) {
    log.warn("falbal.check_fail", errInfo(e));
    return { ok: true, balance: null };
  }
}
