import type { Metadata } from "next";

// 갤러리는 본인 전용 보관함 → 색인 제외.
export const metadata: Metadata = {
  title: "내 캐릭터들",
  robots: { index: false, follow: true },
  alternates: { canonical: "/gallery" },
};

export default function GalleryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
