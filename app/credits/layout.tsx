import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "생성권 충전",
  robots: { index: false, follow: true },
  alternates: { canonical: "/credits" },
};

export default function CreditsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
