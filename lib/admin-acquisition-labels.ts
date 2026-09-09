// 「공유·유입」 표기 단일 소스 — 소스 종류·바이럴·랜딩 묶음·공유 표면/대상·회원 여부·스코프·전환 단계·이벤트 종류의 한글 라벨.
// 집계 카드(AcquisitionCard·ShareAnalyticsCard)와 원본 이벤트 목록(AnalyticsEventList)이 함께 쓴다. 한 개념 한 용어.

export const SOURCE_KIND_KO: Record<string, string> = { direct: "직접", utm: "UTM", referrer: "referrer", viral: "바이럴", "기타": "기타" };
export const VIRAL_KO: Record<string, string> = { score: "점수 공유 경유", doll: "캐릭터 공유 경유" };

// 랜딩 표시 묶음(가안 A) — 저장은 세분 토큰, 표시만 묶는다(묶음을 바꿔도 재집계 가능).
export const LANDING_GROUP_KO: Record<string, string> = {
  home: "홈", play: "게임", generate: "캐릭터 생성", gallery: "갤러리", leaderboard: "랭킹",
  doll: "캐릭터 상세", share: "점수 공유", history: "기록", news: "소식", badges: "배지",
  account: "계정·결제", credits: "계정·결제", login: "로그인",
  faq: "약관·안내", terms: "약관·안내", privacy: "약관·안내",
  other: "기타", "기타": "기타", "": "(수집 전)",
};
export function landingLabel(v: string): string {
  return LANDING_GROUP_KO[v] ?? v;
}

export function sourceLabel(kind: string, value: string): string {
  const k = SOURCE_KIND_KO[kind] ?? kind;
  if (kind === "direct" || kind === "기타" || !value) return k;
  if (kind === "viral") return `${k} · ${value === "score" ? "점수" : value === "doll" ? "캐릭터" : value}`;
  return `${k} · ${value}`;
}

export const SURFACE_KO: Record<string, string> = {
  game_over: "게임오버",
  history: "이전기록",
  highlight_viewer: "하이라이트 뷰어",
  doll: "캐릭터(/doll)",
  gallery: "갤러리",
};
export const TARGET_KO: Record<string, string> = { score: "점수", doll: "캐릭터", highlight: "하이라이트" };
export const MEMBER_KO: Record<string, string> = { anon: "비회원", member: "회원" };

// 원본 이벤트 뷰어(v1.31)용 — 스코프·전환 단계·이벤트 종류. 집계 카드의 표기("현재 진입"·"공유 시도")와 같은 말.
export const SOURCE_SCOPE_KO: Record<string, string> = { current: "현재 진입", first_touch: "최초 유입(first-touch)" };
export const CONVERSION_STEP_KO: Record<string, string> = { play: "플레이", signup: "가입" };
/** analytics_events.kind — 표시 순서 = 필터 순서. 클라(필터)·서버(조회) 공용이라 server-only 가 아닌 이 모듈에 둔다. */
export const ANALYTICS_EVENT_KINDS = ["visit", "share", "conversion"] as const;
export type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number];
export function isAnalyticsEventKind(v: unknown): v is AnalyticsEventKind {
  return typeof v === "string" && (ANALYTICS_EVENT_KINDS as readonly string[]).includes(v);
}
export const ANALYTICS_EVENT_KIND_KO: Record<AnalyticsEventKind, string> = { visit: "방문", share: "공유 시도", conversion: "전환" };
