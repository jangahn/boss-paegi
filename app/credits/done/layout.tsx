import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "결제 결과 확인",
  robots: { index: false, follow: true },
  alternates: { canonical: "/credits/done" },
};

export default function CreditsDoneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
