// 공유·유입 분석 — 순수 공유 로직(클라/서버 공통, DOM·env·server-only 의존 없음).
// 식별자/원본 URL/query/IP/UA 무저장 원칙. 토큰 정규화·source 정합·payload sanitize 의 단일 출처.
// 클라(lib/acquisition.ts)와 서버(lib/analytics/server.ts·app/api/track) 가 함께 import 한다.

export type AnalyticsKind = "visit" | "share" | "conversion";
export type SourceScope = "current" | "first_touch";
export type SourceKind = "direct" | "utm" | "referrer" | "viral";
export type ViralType = "score" | "doll";
export type Surface = "game_over" | "history" | "highlight_viewer" | "doll" | "gallery";
export type ShareTarget = "score" | "doll" | "highlight";
export type ConversionStep = "play" | "signup";
export type MemberState = "anon" | "member";

export const SURFACES: readonly Surface[] = ["game_over", "history", "highlight_viewer", "doll", "gallery"];
export const SHARE_TARGETS: readonly ShareTarget[] = ["score", "doll", "highlight"];
export const VIRAL_TYPES: readonly ViralType[] = ["score", "doll"];
export const MAX_TOKEN_LEN = 64;

/**
 * UTM/referrer/source 토큰 정규화 — PII·고cardinality 차단.
 * lowercase·trim → 빈값/64자 초과/`@`·`%40`(email-like)/`/?&=`(query·path-like)/허용외 문자 → **null**(truncate 아님).
 * 허용: `[a-z0-9._-]`(도메인 `m.search.naver.com`, 캠페인 `summer_sale` 등 통과).
 */
export function normalizeToken(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s || s.length > MAX_TOKEN_LEN) return null;
  if (s.includes("@") || s.includes("%40")) return null; // email-like
  if (/[/?&=]/.test(s)) return null; // query/path-like
  if (!/^[a-z0-9._-]+$/.test(s)) return null; // 공백·기타 → null
  return s;
}

export type RawSource = {
  source_kind?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  referrer_domain?: unknown;
  viral_type?: unknown;
};

export type NormSource = {
  source_kind: SourceKind;
  source_value: string;
  referrer_domain: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  viral_type: ViralType | null;
};

export const DIRECT_SOURCE: NormSource = {
  source_kind: "direct",
  source_value: "direct",
  referrer_domain: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  viral_type: null,
};

/**
 * raw source → DB source_shape 를 항상 만족하는 NormSource. 무효/PII 면 **direct fallback**(이벤트 drop 안 함).
 * (클라 우선순위 fallthrough 는 acquisition 에서 처리; 여기선 선언된 source_kind 를 재검증·정규화만.)
 */
export function normalizeSource(raw: RawSource | null | undefined): NormSource {
  if (!raw || typeof raw !== "object") return DIRECT_SOURCE;
  switch (raw.source_kind) {
    case "utm": {
      const utm = normalizeToken(raw.utm_source);
      if (!utm) return DIRECT_SOURCE;
      return {
        source_kind: "utm",
        source_value: utm,
        referrer_domain: null,
        utm_source: utm,
        utm_medium: normalizeToken(raw.utm_medium),
        utm_campaign: normalizeToken(raw.utm_campaign),
        viral_type: null,
      };
    }
    case "referrer": {
      const dom = normalizeToken(raw.referrer_domain);
      if (!dom) return DIRECT_SOURCE;
      return { ...DIRECT_SOURCE, source_kind: "referrer", source_value: dom, referrer_domain: dom };
    }
    case "viral": {
      const vt = raw.viral_type;
      if (vt === "score" || vt === "doll") {
        return { ...DIRECT_SOURCE, source_kind: "viral", source_value: vt, viral_type: vt };
      }
      return DIRECT_SOURCE;
    }
    default:
      return DIRECT_SOURCE;
  }
}

// /api/track 가 받는 클라 이벤트(visit | share). conversion 은 서버 내부에서만 적재(여기서 거부).
export type VisitRow = { kind: "visit"; source_scope: SourceScope } & NormSource;
export type ShareRow = {
  kind: "share";
  surface: Surface;
  target: ShareTarget;
  score_tier: number | null;
  result: "attempt";
};
export type TrackRow = VisitRow | ShareRow;

/** untrusted 클라 payload → 정제된 visit|share row(member_state·day_kst 제외). 불량/conversion 이면 null. */
export function sanitizeTrackPayload(raw: unknown): TrackRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (o.kind === "visit") {
    const scope = o.source_scope;
    if (scope !== "current" && scope !== "first_touch") return null;
    return { kind: "visit", source_scope: scope, ...normalizeSource(o as RawSource) };
  }

  if (o.kind === "share") {
    const surface = SURFACES.includes(o.surface as Surface) ? (o.surface as Surface) : null;
    const target = SHARE_TARGETS.includes(o.target as ShareTarget) ? (o.target as ShareTarget) : null;
    if (!surface || !target) return null;
    let score_tier: number | null = null;
    if (target === "score") {
      const t = o.score_tier;
      if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t <= 9) score_tier = t;
    }
    return { kind: "share", surface, target, score_tier, result: "attempt" };
  }

  return null;
}

export type ConversionRow = {
  kind: "conversion";
  conversion_step: ConversionStep;
  source_scope: "first_touch";
} & NormSource;

/** 서버 전용 빌더 — 점수제출/가입 시 first-touch source 로 conversion row 구성(무효 source → direct). */
export function buildConversionRow(step: ConversionStep, rawSource: RawSource | null | undefined): ConversionRow {
  return { kind: "conversion", conversion_step: step, source_scope: "first_touch", ...normalizeSource(rawSource) };
}
