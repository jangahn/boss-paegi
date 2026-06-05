import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SERVICE_NAME } from "@/lib/policy";

export const metadata: Metadata = {
  title: `${SERVICE_NAME} — 직장인 스트레스 해소 게임`,
  description:
    "사진 한 장으로 만드는 나만의 부장님 인형. 캐주얼하게 스트레스 한 방에 풀자.",
  applicationName: SERVICE_NAME,
  openGraph: {
    title: SERVICE_NAME,
    description: "사진 한 장으로 만드는 나만의 부장님 인형.",
    locale: "ko_KR",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
