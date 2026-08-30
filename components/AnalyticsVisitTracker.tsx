"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackVisit } from "@/lib/acquisition";
import { isAnalyticsExcludedPath } from "@/lib/analytics/core";

// 방문 캡처(current 매 탭세션 1회 + first-touch acquisition 1회) — 분석 비대상 경로 제외.
// 실제 중복 억제·게이트는 lib/acquisition 내부(session/localStorage). 여긴 경로 필터 + 호출만.
// 제외 목록은 lib/analytics/core 단일 소스(landing 환원도 같은 목록을 본다).

export function AnalyticsVisitTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    if (isAnalyticsExcludedPath(pathname)) return;
    trackVisit(pathname);
  }, [pathname]);
  return null;
}
