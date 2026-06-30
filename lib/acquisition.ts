"use client";

// 공유·유입 분석 — 클라 캡처(DOM·localStorage·beacon). 순수 로직은 lib/analytics/core 재사용.
// current source(현재 진입·매 탭세션)와 first-touch source(획득·90일 sticky)를 분리 추적.
// 식별자/원본 URL/query 미저장 — 도메인·UTM·차원만. PUBLIC_ENV.ANALYTICS_ENABLED 로 게이트.

import { PUBLIC_ENV } from "@/lib/env";
import {
  normalizeSource,
  normalizeToken,
  type NormSource,
  type RawSource,
  type Surface,
  type ShareTarget,
} from "@/lib/analytics/core";

const TRACK_URL = "/api/track";
const FT_KEY = "bp_acq_ft_v1";
const CURRENT_VISIT_KEY = "bp_visit_current_tracked_v1";
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90일 — raw 보관기간과 일치

type StoredFirstTouch = {
  version: 1;
  source: NormSource;
  capturedAt: number;
  acquisitionVisitSent?: boolean;
  playConversionSent?: boolean;
};

function enabled(): boolean {
  return PUBLIC_ENV.ANALYTICS_ENABLED && typeof window !== "undefined";
}

/** sendBeacon 우선(언로드 안전), 실패 시 fetch keepalive. queued 면 true. */
function send(payload: Record<string, unknown>): boolean {
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      if (navigator.sendBeacon(TRACK_URL, new Blob([body], { type: "application/json" }))) return true;
    }
    void fetch(TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function ourHost(): string {
  try {
    return new URL(PUBLIC_ENV.SITE_URL).host;
  } catch {
    return "";
  }
}

/** 현재 진입 raw source — 우선순위 + 무효(PII 등) 시 다음 우선순위로 fallthrough. */
function computeCurrentRaw(): RawSource {
  const url = new URL(window.location.href);
  const utm = url.searchParams.get("utm_source");
  if (utm && normalizeToken(utm)) {
    return {
      source_kind: "utm",
      utm_source: utm,
      utm_medium: url.searchParams.get("utm_medium"),
      utm_campaign: url.searchParams.get("utm_campaign"),
    };
  }
  const path = url.pathname;
  if (path.startsWith("/share/")) return { source_kind: "viral", viral_type: "score" };
  if (path.startsWith("/doll/")) return { source_kind: "viral", viral_type: "doll" };
  const ref = typeof document !== "undefined" ? document.referrer : "";
  if (ref) {
    try {
      const h = new URL(ref).host;
      if (h && h !== ourHost() && normalizeToken(h)) return { source_kind: "referrer", referrer_domain: h };
    } catch {
      /* malformed referrer → direct */
    }
  }
  return { source_kind: "direct" };
}

function currentSource(): NormSource {
  return normalizeSource(computeCurrentRaw());
}

function readFirstTouch(): StoredFirstTouch | null {
  try {
    const raw = window.localStorage.getItem(FT_KEY);
    if (!raw) return null;
    const ft = JSON.parse(raw) as StoredFirstTouch;
    if (!ft || ft.version !== 1 || typeof ft.capturedAt !== "number") return null;
    if (Date.now() - ft.capturedAt > TTL_MS) {
      window.localStorage.removeItem(FT_KEY);
      return null;
    }
    return ft;
  } catch {
    return null;
  }
}

function writeFirstTouch(ft: StoredFirstTouch): void {
  try {
    window.localStorage.setItem(FT_KEY, JSON.stringify(ft));
  } catch {
    /* storage 불가 — 무시 */
  }
}

/** first-touch 읽거나(만료/없음 시) 현재 source 로 생성(최초 1회 고정). */
function ensureFirstTouch(): StoredFirstTouch {
  const existing = readFirstTouch();
  if (existing) return existing;
  const ft: StoredFirstTouch = { version: 1, source: currentSource(), capturedAt: Date.now() };
  writeFirstTouch(ft);
  return ft;
}

/** 방문 — current(탭세션 1회) + first-touch acquisition(생성 시 1회). 두 플래그 독립. */
export function trackVisit(): void {
  if (!enabled()) return;
  try {
    if (!window.sessionStorage.getItem(CURRENT_VISIT_KEY)) {
      if (send({ kind: "visit", source_scope: "current", ...currentSource() })) {
        window.sessionStorage.setItem(CURRENT_VISIT_KEY, "1");
      }
    }
  } catch {
    /* sessionStorage 불가 — current 스킵 */
  }
  const ft = ensureFirstTouch();
  if (!ft.acquisitionVisitSent) {
    if (send({ kind: "visit", source_scope: "first_touch", ...ft.source })) {
      ft.acquisitionVisitSent = true;
      writeFirstTouch(ft);
    }
  }
}

/** 공유 시도 — game_over 는 결과화면당 1회(onceKey), 그 외는 (surface:target) 3초 디바운스. */
const lastShareAt: Record<string, number> = {};
export function trackShare(opts: {
  surface: Surface;
  target: ShareTarget;
  scoreTier?: number | null;
  onceKey?: string;
}): void {
  if (!enabled()) return;
  try {
    if (opts.onceKey) {
      const k = "bp_share_once_" + opts.onceKey;
      if (window.sessionStorage.getItem(k)) return;
      window.sessionStorage.setItem(k, "1");
    } else {
      const dk = opts.surface + ":" + opts.target;
      const now = Date.now();
      if (lastShareAt[dk] && now - lastShareAt[dk] < 3000) return;
      lastShareAt[dk] = now;
    }
  } catch {
    /* storage 불가 — 디바운스 없이 1회 전송 */
  }
  send({
    kind: "share",
    surface: opts.surface,
    target: opts.target,
    score_tier: opts.target === "score" ? opts.scoreTier ?? null : null,
  });
}

/** 전환용 first-touch source(점수제출/가입 API body 에 동봉). 분석 off 면 null → 서버가 conversion 미적재. */
export function firstTouchSourceForConversion(): RawSource | null {
  if (!enabled()) return null;
  const s = ensureFirstTouch().source;
  return {
    source_kind: s.source_kind,
    utm_source: s.utm_source,
    utm_medium: s.utm_medium,
    utm_campaign: s.utm_campaign,
    referrer_domain: s.referrer_domain,
    viral_type: s.viral_type,
  };
}

/** play conversion 1회 게이트(first-touch 당). 점수 첫 제출 성공 시 marked. */
export function shouldSendPlayConversion(): boolean {
  if (!enabled()) return false;
  return !ensureFirstTouch().playConversionSent;
}
export function markPlayConversionSent(): void {
  if (!enabled()) return;
  const ft = ensureFirstTouch();
  ft.playConversionSent = true;
  writeFirstTouch(ft);
}
