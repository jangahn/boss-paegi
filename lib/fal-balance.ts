import "server-only";
import { log, errInfo } from "@/lib/log";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";

/**
 * fal.ai 계정 잔액 hard cap.
 *
 * GET https://api.fal.ai/v1/account/billing?expand=credits — ADMIN scope
 * API key 필요 (일반 키 불가). A missing key, timeout, non-2xx, oversized
 * body, invalid UTF-8/JSON, or malformed balance is absence of authority and
 * therefore blocks every new paid child request.
 *
 * A recent low-balance result may be cached because it can only keep the path
 * closed. A successful balance observation is never an authorization cache:
 * every newly claimed generation obtains fresh billing evidence so a burst
 * cannot spend against one stale allow decision.
 */

export const FAL_BALANCE_FLOOR_USD = 2;
export const FAL_BALANCE_DENY_CACHE_TTL_MS = 60_000;
export const FAL_BILLING_RESPONSE_MAX_BYTES = 64 * 1024;
export const FAL_BILLING_TIMEOUT_MS = 5_000;

let cachedDenial: { balance: number; at: number } | null = null;

export type BalanceCheck =
  | { ok: true; balance: number; checkedAt: number }
  | {
      ok: false;
      balance: number | null;
      reason:
        | "missing_admin_key"
        | "below_floor"
        | "billing_http_error"
        | "billing_body_invalid"
        | "billing_json_invalid"
        | "billing_balance_invalid"
        | "billing_unavailable";
    };

export async function checkFalBalance(): Promise<BalanceCheck> {
  const adminKey = process.env.FAL_ADMIN_KEY;
  if (!adminKey) {
    log.error("falbal.admin_key_missing");
    return {
      ok: false,
      balance: null,
      reason: "missing_admin_key",
    };
  }

  const now = Date.now();
  if (
    cachedDenial &&
    now >= cachedDenial.at &&
    now - cachedDenial.at < FAL_BALANCE_DENY_CACHE_TTL_MS
  ) {
    return {
      ok: false,
      balance: cachedDenial.balance,
      reason: "below_floor",
    };
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
      return {
        ok: false,
        balance: null,
        reason: "billing_http_error",
      };
    }
    const bounded = await readBoundedResponseBytes(
      res,
      FAL_BILLING_RESPONSE_MAX_BYTES,
    );
    if (!bounded.ok) {
      log.warn("falbal.invalid_response", { reason: bounded.error });
      return {
        ok: false,
        balance: null,
        reason: "billing_body_invalid",
      };
    }
    let data: {
      credits?: { current_balance?: number };
    };
    try {
      data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
      ) as {
        credits?: { current_balance?: number };
      };
    } catch {
      log.warn("falbal.invalid_response", { reason: "invalid_json" });
      return {
        ok: false,
        balance: null,
        reason: "billing_json_invalid",
      };
    }
    const balance = data.credits?.current_balance;
    if (
      typeof balance !== "number" ||
      !Number.isFinite(balance) ||
      balance < 0
    ) {
      log.warn("falbal.no_balance_field", {});
      return {
        ok: false,
        balance: null,
        reason: "billing_balance_invalid",
      };
    }
    if (balance < FAL_BALANCE_FLOOR_USD) {
      cachedDenial = { balance, at: now };
      log.warn("falbal.hard_cap_hit", {
        balance,
        cap: FAL_BALANCE_FLOOR_USD,
      });
      return { ok: false, balance, reason: "below_floor" };
    }
    log.info("falbal.ok", { balance });
    return { ok: true, balance, checkedAt: now };
  } catch (e) {
    log.warn("falbal.check_fail", errInfo(e));
    return {
      ok: false,
      balance: null,
      reason: "billing_unavailable",
    };
  }
}
