// 공지 배너 서버 HTML 스냅샷(v1.62) — 루트 레이아웃이 캐시된 활성 배너를 서버 HTML 에 싣고, 브라우저(useActiveEvents)가 이어서
// 시작 · 종료 경계를 맞춘다. 종전에는 배너를 하이드레이션 뒤에만 조회해, 배너를 걸면 홈 · 갤러리 · 랭킹 본문이 그만큼 밀렸다.
// 팝업은 싣지 않는다 — 「며칠 안 보기」가 브라우저 저장소라 서버 HTML 에 그리면 닫은 사람에게도 잠깐 보인다.
// 서버 캐시(lib/events getEventBannerSnapshot)는 태그 `events` + 1시간 backstop — 짧은 ISR 은 Fluid CPU 한도 때문에 쓰지 않는다
// (config backstop 3600 과 같은 이유, lib/config/get.ts). 예약 경계가 지나면 활성 배너 API 가 낡은 스냅샷을 알아채 재검증한다.
import type { ActiveBanner } from "../active-events-response.ts";
import type { BannerSurface } from "./types.ts";

export type EventBannerSnapshot = {
  banners: Record<BannerSurface, ActiveBanner | null>;
  /** 이 스냅샷이 맞는 마지막 시각(다음 시작 · 종료 경계, UTC ISO). 지나면 서버 HTML 의 배너가 낡은 것. null = 예약 경계 없음. */
  nextTransitionAt: string | null;
};

export const EMPTY_EVENT_BANNER_SNAPSHOT: EventBannerSnapshot = {
  banners: { home: null, gallery: null, leaderboard: null },
  nextTransitionAt: null,
};

/** 스냅샷의 경계가 지났는가(now 도 UTC ISO). 시각을 읽을 수 없으면 낡지 않은 것으로 본다. */
export function isBannerSnapshotStale(snapshot: Pick<EventBannerSnapshot, "nextTransitionAt">, nowIso: string): boolean {
  if (!snapshot.nextTransitionAt) return false;
  const boundary = Date.parse(snapshot.nextTransitionAt);
  const now = Date.parse(nowIso);
  return Number.isFinite(boundary) && Number.isFinite(now) && now >= boundary;
}
