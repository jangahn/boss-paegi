"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/Spinner";

/**
 * <Link> 내부에 두는 라벨 — 해당 링크 네비게이션이 진행 중이면 dim + 인라인 스피너.
 * (Next 16 useLinkStatus 는 가장 가까운 부모 Link 의 pending 을 읽음.) Pagination 셀 등에 사용.
 */
export function PendingLinkLabel({ children }: { children: React.ReactNode }) {
  const { pending } = useLinkStatus();
  // 스피너를 인라인으로 덧붙이면 pending 순간 셀 폭이 늘어 레이아웃이
  // 점프한다(소형 화면 실측) — 라벨 위 오버레이로 폭 불변.
  return (
    <span className="relative inline-flex items-center">
      <span className={pending ? "opacity-40" : ""}>{children}</span>
      {pending && (
        <Spinner className="absolute inset-0 m-auto h-3 w-3" />
      )}
    </span>
  );
}
