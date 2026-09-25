import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { errInfo, log } from "@/lib/log";
import { getActiveEventSurfaces } from "@/lib/events";
import { EMPTY_EVENT_BANNER_SNAPSHOT, isBannerSnapshotStale, type EventBannerSnapshot } from "./banner-snapshot";

// 공지 배너 서버 HTML 스냅샷의 서버 쪽(v1.62, lib/events/banner-snapshot.ts). 서버 HTML 첫 상태 전용 캐시이고, 활성 배너 API
// (app/api/events/active)는 종전대로 캐시 없이 한 번의 DB 스냅샷을 돌려준다 — 경계를 캐시 TTL 로 양자화하지 않는 원칙은 API 에
// 그대로 남고(lib/events 는 unstable_cache 를 쓰지 않는다), 서버 HTML 이 낡으면 브라우저가 API 로 바로잡는다.

/** 이벤트 공개 캐시 태그 — 어드민 발행 · 수정 · 삭제(app/api/admin/events)와 공지 배너 스냅샷이 같이 쓴다. */
export const EVENTS_CACHE_TAG = "events";

// 루트 레이아웃이 모든 페이지에서 읽으므로 캐시한다 — 태그 무효화(어드민 변경 · 경계 지난 스냅샷) + 1시간 backstop.
// 짧은 revalidate 는 정적 페이지 재생성을 늘려 Fluid CPU 를 먹는다(lib/config/get.ts 의 3600 근거와 같다).
const cachedEventBannerSnapshot = unstable_cache(
  async (): Promise<EventBannerSnapshot> => {
    const snapshot = await getActiveEventSurfaces();
    return { banners: snapshot.banners, nextTransitionAt: snapshot.nextTransitionAt };
  },
  ["events", "active-banner-snapshot"],
  { tags: [EVENTS_CACHE_TAG], revalidate: 3600 },
);

/** 서버 HTML 에 실을 배너 스냅샷. 실패는 캐시하지 않고 빈 스냅샷(배너는 종전처럼 하이드레이션 뒤 조회) — 루트 레이아웃이 부르므로 던지지 않는다. */
export async function getEventBannerSnapshot(): Promise<EventBannerSnapshot> {
  try {
    return await cachedEventBannerSnapshot();
  } catch (error) {
    log.warn("events.banner_snapshot_fail", errInfo(error));
    return EMPTY_EVENT_BANNER_SNAPSHOT;
  }
}

/**
 * 서버 HTML 에 실린 배너 스냅샷의 예약 경계가 지났으면 이벤트 캐시를 바로 무효화한다 — 다음 페이지 요청이 새 배너로 다시 그린다.
 * 활성 배너 API 가 조회마다 부른다. 경계가 지난 동안만 무효화하므로 반복 호출해도 재생성은 경계당 한 번꼴.
 */
export async function revalidateStaleEventBannerSnapshot(nowIso: string): Promise<void> {
  const cached = await getEventBannerSnapshot();
  if (isBannerSnapshotStale(cached, nowIso)) {
    revalidateTag(EVENTS_CACHE_TAG, { expire: 0 });
  }
}
