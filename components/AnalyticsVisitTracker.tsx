"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackVisit } from "@/lib/acquisition";

// 방문 캡처(current 매 탭세션 1회 + first-touch acquisition 1회) — 분석 비대상 경로 제외.
// 실제 중복 억제·게이트는 lib/acquisition 내부(session/localStorage). 여긴 경로 필터 + 호출만.
const EXCLUDED = ["/admin", "/api", "/auth", "/consent"];

export function AnalyticsVisitTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    if (EXCLUDED.some((p) => pathname === p || pathname.startsWith(p + "/"))) return;
    trackVisit();
  }, [pathname]);
  return null;
}
