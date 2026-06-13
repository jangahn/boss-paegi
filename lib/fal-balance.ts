import "server-only";
import { log, errInfo } from "@/lib/log";

/**
 * fal.ai 계정 잔액 hard cap.
 *
 * GET https://api.fal.ai/v1/account/billing?expand=credits — ADMIN scope
 * API key 필요 (일반 키 불가). FAL_ADMIN_KEY 미설정/조회 실패 시에는
 * 차단하지 않고 통과 (graceful degrade — 잔액 체크가 서비스를 죽이면 안 됨).
 */

const HARD_CAP_USD = 2;
const CACHE_TTL_MS = 60_000;

let cached: { balance: number; at: number } | null = null;

type BalanceCheck =
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
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) {
      log.warn("falbal.api_error", { status: res.status });
      return { ok: true, balance: null };
    }
    const data = (await res.json()) as {
      credits?: { current_balance?: number };
    };
    const balance = data.credits?.current_balance;
    if (typeof balance !== "number") {
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
