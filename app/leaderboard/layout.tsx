import type { Metadata } from "next";

// 랭킹은 닉네임·점수 위주 + 수시 변동 → 색인 제외(crawl 허용·noindex).
export const metadata: Metadata = {
  title: "랭킹",
  robots: { index: false, follow: true },
  alternates: { canonical: "/leaderboard" },
};

export default function LeaderboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
