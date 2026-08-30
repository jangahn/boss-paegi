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
/**
 * 진입 페이지(landing) — 경로 첫 세그먼트를 이 화이트리스트로 축약해 저장한다.
 * 원본 URL·쿼리·식별자는 저장하지 않는다(`/doll/<uuid>` → `doll`). 미등록 경로는 `other`.
 * 서버 리다이렉트 스텁(`/signup`·`/reconsent`)은 렌더 자체가 없어 값이 될 수 없다.
 */
export const LANDING_GROUPS = [
  "home", "play", "gallery", "leaderboard", "generate", "doll", "share", "history",
  "news", "badges", "account", "credits", "faq", "terms", "privacy", "login", "other",
] as const;
export type Landing = (typeof LANDING_GROUPS)[number];

export function landingGroupOf(pathname: string): Landing {
  if (!pathname || pathname === "/") return "home";
  const head = pathname.split("/")[1] ?? "";
  return (LANDING_GROUPS as readonly string[]).includes(head) ? (head as Landing) : "other";
}

/**
 * 분석 비대상 경로 — 트래커가 비콘을 울리지 않고, `/login?next=` 환원 대상에서도 제외한다.
 * (어드민 운영 트래픽·API·Auth 서브트리·동의 화면.) 트래커와 acquisition 이 함께 쓰는 단일 소스.
 */
export const ANALYTICS_EXCLUDED_PREFIXES = ["/admin", "/api", "/auth", "/consent"] as const;

export function isAnalyticsExcludedPath(pathname: string): boolean {
  return ANALYTICS_EXCLUDED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export const MAX_TOKEN_LEN = 64;

/**
 * UTM/referrer/source 토큰 정규화 — PII·고cardinality 차단.
 * lowercase·trim → 빈값/64자 초과/`@`·`%40`(email-like)/`/?&=`(query·path-like)/허용외 문자 → **null**(truncate 아님).
 * 허용: `[a-z0-9._-]`(도메인 `m.search.naver.com`, utm 값 `insta_bio` 등 통과).
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

// utm 부가 차원(medium·campaign)은 v1.09 에서 하드 제거(소비처 0 실측·source 1차원 운영 확정 — mig 0113).
export type RawSource = {
  source_kind?: unknown;
  utm_source?: unknown;
  referrer_domain?: unknown;
  viral_type?: unknown;
};

export type NormSource = {
  source_kind: SourceKind;
  source_value: string;
  referrer_domain: string | null;
  utm_source: string | null;
  viral_type: ViralType | null;
};

export const DIRECT_SOURCE: NormSource = {
  source_kind: "direct",
  source_value: "direct",
  referrer_domain: null,
  utm_source: null,
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
export type VisitRow = { kind: "visit"; source_scope: SourceScope; landing: Landing } & NormSource;
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
    // landing 은 클라 값 불신 — 화이트리스트 밖이면 other 로 강등(드롭하지 않음: 방문 자체는 유효).
    const landing = (LANDING_GROUPS as readonly string[]).includes(o.landing as string)
      ? (o.landing as Landing)
      : "other";
    return { kind: "visit", source_scope: scope, landing, ...normalizeSource(o as RawSource) };
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

// ── 봇 판별(v1.08) — 클라 게이트·서버 /api/track 백스톱의 단일 소스. UA 는 판별에만 사용·미저장. ──
// lottogen 실증: JS 렌더링 크롤러(Googlebot WRS·Yeti 등)는 비콘을 울린다 — "봇은 JS 못 돌린다" 가정 폐기.
const BOT_UA_RE =
  /bot|spider|crawl|slurp|headless|lighthouse|preview|yeti|daum|petal|semrush|ahrefs|yandex|baidu|bytespider|gptbot|inspectiontool|googleother|google-extended|facebookexternalhit|kakaotalk-scrap|whatsapp|telegram|skype/i;

export function isBotUserAgent(ua: string): boolean {
  return BOT_UA_RE.test(ua);
}
