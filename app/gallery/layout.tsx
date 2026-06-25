import type { Metadata } from "next";

// 갤러리는 본인 전용 보관함 → 색인 제외.
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function GalleryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
