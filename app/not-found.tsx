import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "페이지를 찾을 수 없습니다",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 text-center">
      <div className="flex max-w-sm flex-col items-center gap-4">
        <p className="text-6xl" aria-hidden="true">
          🧭
        </p>
        <h1 className="text-2xl font-bold">페이지를 찾을 수 없어요</h1>
        <p className="text-sm leading-6 text-zinc-500">
          주소가 잘못되었거나 페이지가 이동되었을 수 있습니다.
        </p>
        <Link
          href="/"
          className="mt-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-paper-2"
        >
          홈으로 돌아가기
        </Link>
      </div>
    </main>
  );
}
