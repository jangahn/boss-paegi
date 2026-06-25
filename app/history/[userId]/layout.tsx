import type { Metadata } from "next";

// 개인 플레이 기록(UGC) → 검색 색인 제외(중첩 [scoreId] 포함).
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
