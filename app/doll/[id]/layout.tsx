import type { Metadata } from "next";

// 캐릭터 상세(UGC, 제3자 얼굴 변형물 노출 가능) → 공유 링크는 동작, 검색 색인 제외.
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function DollLayout({ children }: { children: React.ReactNode }) {
  return children;
}
