"use client";

import { createContext, useContext } from "react";
import { EMPTY_EVENT_BANNER_SNAPSHOT, type EventBannerSnapshot } from "@/lib/events/banner-snapshot";

// 공지 배너 서버 HTML 스냅샷(v1.62) — 루트 레이아웃이 캐시된 활성 배너를 내려 주고, useActiveEvents 가 첫 상태로 쓴다.
// provider 밖이면 빈 스냅샷(종전처럼 하이드레이션 뒤 조회).
const Ctx = createContext<EventBannerSnapshot>(EMPTY_EVENT_BANNER_SNAPSHOT);

export function EventBannersProvider({
  value,
  children,
}: {
  value: EventBannerSnapshot;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInitialEventBanners(): EventBannerSnapshot {
  return useContext(Ctx);
}
