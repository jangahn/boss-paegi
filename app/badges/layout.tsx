import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "내 뱃지",
  robots: { index: false, follow: true },
  alternates: { canonical: "/badges" },
};

export default function BadgesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
