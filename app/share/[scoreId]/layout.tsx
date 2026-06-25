import type { Metadata } from "next";

// 점수 공유 페이지(UGC) → 공유는 동작하되 검색 색인 제외(프라이버시·중복 방지).
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
