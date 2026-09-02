"use client";

// 공유·유입 분석 — 클라 캡처(DOM·localStorage·beacon). 순수 로직은 lib/analytics/core 재사용.
// current source(현재 진입·매 탭세션)와 first-touch source(획득·90일 sticky)를 분리 추적.
// 식별자/원본 URL/query 미저장 — 도메인·UTM·차원만. 수집은 상시(별도 opt-in 게이트 없음).

import { PUBLIC_ENV } from "@/lib/env";
import {
  isAnalyticsExcludedPath,
  isBotUserAgent,
  landingGroupOf,
  normalizeSource,
  normalizeToken,
  type Landing,
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
  return typeof window !== "undefined";
}

/** sendBeacon 우선(언로드 안전), 실패 시 fetch keepalive. queued 면 true. */
function send(payload: Record<string, unknown>): boolean {
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      if (navigator.sendBeacon(TRACK_URL, new Blob([body], { type: "application/json" }))) return true;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(new Error("track_delivery_timeout")),
      5_000,
    );
    void fetch(TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => window.clearTimeout(timeoutId));
    return true;
  } catch {
    return false;
  }
}

// ── 봇 게이트(v1.08, lottogen 실증 이식) ────────────────────────────────────────
// ①신분 표기 크롤러·자동화 브라우저: UA(판별에만 사용·미저장)+webdriver 로 전송 자체 스킵.
// ②무신분 렌더러: 이벤트를 큐에 쌓고 **첫 터치/스크롤/키 입력 후에만** 전송 — 렌더 후 떠나는
//   봇은 상호작용이 없어 아무것도 못 보낸다. 방문 정의가 "상호작용한 방문"으로 좁아지는
//   트레이드오프(무조작 이탈 미집계)는 어드민 캡션·README 에 명시. 무식별 도메인이라 오염의
//   사후 정리가 불가능해 예방이 정본이다. 공유/전환은 클릭·플레이 뒤라 게이트가 체감 지연 없음.
const INTERACTED_KEY = "bp_touched_v1";
const INTERACTION_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
/**
 * 큐 항목 — 중복 방지 플래그(current 탭세션·first-touch 획득)는 **실제 전송이 성립한 뒤**(onSent)에만 기록한다.
 * 큐잉을 전송으로 간주해 플래그를 먼저 남기면, 상호작용 없이 떠난 브라우저의 큐가 메모리와 함께 사라져
 * first-touch 방문이 영영 유실되고 이후엔 플레이 전환만 남는다(v1.16 교정). key 는 대기 중 같은 종류의
 * 방문이 라우트 전환으로 두 번 큐잉되지 않게 하는 중복 방지 키(공유 이벤트는 키 없음).
 */
type QueuedEvent = { key?: string; payload: Record<string, unknown>; onSent?: () => void };
let pendingQueue: QueuedEvent[] = [];
let listenersArmed = false;

function isLikelyBot(): boolean {
  try {
    return navigator.webdriver === true || isBotUserAgent(navigator.userAgent);
  } catch {
    return false;
  }
}

function hasInteracted(): boolean {
  try {
    return window.sessionStorage.getItem(INTERACTED_KEY) === "1";
  } catch {
    return false;
  }
}

function onFirstInteraction(): void {
  try {
    window.sessionStorage.setItem(INTERACTED_KEY, "1");
  } catch {
    /* storage 불가 — 큐만 비운다 */
  }
  const queued = pendingQueue;
  pendingQueue = [];
  for (const ev of queued) dispatch(ev);
}

/** 실제 전송 — 브라우저 큐에 인계됐을 때만 onSent 로 플래그를 기록한다. */
function dispatch(ev: QueuedEvent): boolean {
  const ok = send(ev.payload);
  if (ok) ev.onSent?.();
  return ok;
}

function armInteractionListeners(): void {
  if (listenersArmed) return;
  listenersArmed = true;
  const fire = () => {
    for (const t of INTERACTION_EVENTS) window.removeEventListener(t, fire);
    onFirstInteraction();
  };
  for (const t of INTERACTION_EVENTS) window.addEventListener(t, fire, { passive: true });
}

/**
 * 게이트 통과 전송 — 봇이면 false, 상호작용 전이면 큐잉(true), 이후엔 즉시 전송.
 * 반환값은 "게이트 통과" 여부일 뿐 전송 성립이 아니다 — 플래그 기록은 반드시 opts.onSent 로.
 */
function gatedSend(
  payload: Record<string, unknown>,
  opts?: { key?: string; onSent?: () => void },
): boolean {
  if (isLikelyBot()) return false;
  if (hasInteracted()) return dispatch({ payload, ...opts });
  if (opts?.key && pendingQueue.some((ev) => ev.key === opts.key)) return true; // 같은 방문이 이미 대기 중
  pendingQueue.push({ payload, ...opts });
  armInteractionListeners();
  return true;
}

function ourHost(): string {
  try {
    return new URL(PUBLIC_ENV.SITE_URL).host;
  } catch {
    return "";
  }
}

/**
 * `/login` 진입은 회원전용 게이트(proxy.ts)가 보낸 것이고, 원래 목적지와 그 쿼리가 `next` 에 통째로
 * 들어 있다(2026-08-30 프로드 실측: `/generate?utm_source=X` → `/login?next=%2Fgenerate%3Futm_source%3DX`).
 * 최상위 URL 만 보면 그 UTM 을 놓쳐 referrer(없으면 direct)로 오귀속되므로 여기서 열어본다.
 * 내부 절대경로만 허용하고, 실패·외부 origin 은 null(=환원 안 함).
 */
function loginNextUrl(): URL | null {
  try {
    if (window.location.pathname !== "/login") return null;
    const raw = new URL(window.location.href).searchParams.get("next");
    if (!raw || !raw.startsWith("/")) return null;
    const parsed = new URL(raw, window.location.origin);
    return parsed.origin === window.location.origin ? parsed : null;
  } catch {
    return null;
  }
}

/** 진입 페이지 — `/login` 이면 원래 가려던 목적지(next)로 환원한다. 제외 경로(어드민 등)는 환원 안 함. */
function currentLanding(pathname: string): Landing {
  const viaLogin = loginNextUrl();
  if (viaLogin && !isAnalyticsExcludedPath(viaLogin.pathname)) {
    return landingGroupOf(viaLogin.pathname);
  }
  return landingGroupOf(pathname);
}

/** 현재 진입 raw source — 우선순위 + 무효(PII 등) 시 다음 우선순위로 fallthrough. */
function computeCurrentRaw(): RawSource {
  const url = new URL(window.location.href);
  // UTM 우선순위는 기존 그대로(utm > viral > referrer > direct). `/login` 로 튕긴 경우의
  // next 안 UTM 도 같은 자리에서 인정한다 — 리다이렉트가 원인인 오귀속만 교정하고 순서는 불변.
  const utm =
    url.searchParams.get("utm_source") ??
    loginNextUrl()?.searchParams.get("utm_source") ??
    null;
  if (utm && normalizeToken(utm)) {
    return {
      source_kind: "utm",
      utm_source: utm,
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

/**
 * 방문 — current(탭세션 1회) + first-touch acquisition(생성 시 1회). 두 플래그 독립.
 * landing 은 두 행에 같은 값(그 세션이 실제로 진입한 페이지)을 싣는다 — 세션 단위 보장은
 * 기존 CURRENT_VISIT_KEY 플래그가 그대로 해 주므로 추가 게이트가 없다.
 * 두 플래그 모두 **실제 전송 뒤**(onSent)에만 기록 — 상호작용 전 큐잉 상태로 떠나면 플래그가 남지 않아
 * 다음 방문(새 탭세션)에서 다시 시도한다(v1.16).
 */
export function trackVisit(pathname: string): void {
  if (!enabled()) return;
  const landing = currentLanding(pathname);
  try {
    if (!window.sessionStorage.getItem(CURRENT_VISIT_KEY)) {
      gatedSend(
        { kind: "visit", source_scope: "current", landing, ...currentSource() },
        {
          key: "visit:current",
          onSent: () => {
            try {
              window.sessionStorage.setItem(CURRENT_VISIT_KEY, "1");
            } catch {
              /* sessionStorage 불가 — 플래그 없이 진행 */
            }
          },
        },
      );
    }
  } catch {
    /* sessionStorage 불가 — current 스킵 */
  }
  const ft = ensureFirstTouch();
  if (!ft.acquisitionVisitSent) {
    gatedSend(
      { kind: "visit", source_scope: "first_touch", landing, ...ft.source },
      {
        key: "visit:first_touch",
        onSent: () => {
          // 큐잉 뒤 flush 시점엔 저장된 ft 가 갱신됐을 수 있어 다시 읽고 플래그만 얹는다.
          const current = readFirstTouch() ?? ft;
          current.acquisitionVisitSent = true;
          writeFirstTouch(current);
        },
      },
    );
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
  gatedSend({
    kind: "share",
    surface: opts.surface,
    target: opts.target,
    score_tier: opts.target === "score" ? opts.scoreTier ?? null : null,
  });
}

/**
 * 전환용 first-touch source(점수제출/가입 API body 에 동봉). 브라우저 밖(SSR)이면 null.
 * 봇 게이트(v1.16): 방문 비콘과 **대칭** — 자동화 브라우저(webdriver)·봇 UA 면 null 을 돌려 서버가 conversion 을
 * 적재하지 않게 한다. 한쪽만 막히면 e2e 1판 = "방문 0·플레이 +1" 로 전환표가 오염된다. 점수 저장 자체는 무관.
 */
export function firstTouchSourceForConversion(): RawSource | null {
  if (!enabled() || isLikelyBot()) return null;
  const s = ensureFirstTouch().source;
  return {
    source_kind: s.source_kind,
    utm_source: s.utm_source,
    referrer_domain: s.referrer_domain,
    viral_type: s.viral_type,
  };
}

/** play conversion 1회 게이트(first-touch 당). 점수 첫 제출 성공 시 marked. */
export function shouldSendPlayConversion(): boolean {
  if (!enabled() || isLikelyBot()) return false;
  return !ensureFirstTouch().playConversionSent;
}
export function markPlayConversionSent(): void {
  if (!enabled()) return;
  const ft = ensureFirstTouch();
  ft.playConversionSent = true;
  writeFirstTouch(ft);
}
