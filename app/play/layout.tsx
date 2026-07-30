import type { Metadata } from "next";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "게임",
  description: "화면 속 부장님을 두들기며 스트레스를 푸는 무료 웹 게임.",
  alternates: { canonical: "/play" },
  openGraph: {
    title: `게임 · ${SERVICE_NAME}`,
    description: "화면 속 부장님을 두들기며 스트레스를 푸는 무료 웹 게임.",
    url: `${SITE_URL}/play`,
    type: "website",
  },
};

export default function PlayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
