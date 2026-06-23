"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/Spinner";

/**
 * <Link> 내부에 두는 라벨 — 해당 링크 네비게이션이 진행 중이면 dim + 인라인 스피너.
 * (Next 16 useLinkStatus 는 가장 가까운 부모 Link 의 pending 을 읽음.) Pagination 셀 등에 사용.
 */
export function PendingLinkLabel({ children }: { children: React.ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span className={`inline-flex items-center gap-1 ${pending ? "opacity-60" : ""}`}>
      {children}
      {pending && <Spinner className="h-3 w-3" />}
    </span>
  );
}
