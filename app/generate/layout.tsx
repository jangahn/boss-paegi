import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireMember } from "@/lib/auth-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "캐릭터 만들기",
  robots: { index: false, follow: true },
  alternates: { canonical: "/generate" },
};

function GenerationUnavailable({
  temporary = false,
}: {
  temporary?: boolean;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <section className="w-full max-w-lg rounded-2xl border border-foreground/15 ui-surface p-6">
        <h1 className="text-2xl font-bold">AI 생성 기능을 준비 중입니다</h1>
        <p role="alert" className="mt-3 text-sm leading-relaxed text-zinc-500">
          {temporary
            ? "동의 상태를 안전하게 확인할 수 없어 잠시 이용을 멈췄습니다. 잠시 후 다시 시도해주세요."
            : "국외 이전 정보와 공급자 이용 조건 확인이 완료될 때까지 사진 업로드와 AI 생성 요청을 받지 않습니다."}
        </p>
      </section>
    </main>
  );
}

export default async function GenerateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const gate = await requireMember();
  if (!gate.ok) {
    if (gate.error === "unauthorized" || gate.error === "member_only") {
      redirect("/login?next=%2Fgenerate");
    }
    if (gate.error === "consent_required") {
      redirect("/consent?next=%2Fgenerate");
    }
    return <GenerationUnavailable temporary />;
  }

  // Provider acceptance is no longer an enforcement gate: the product owner
  // restored the pre-freeze generation flow on 2026-07-31, so members go
  // straight to the generation page and its in-page photo consent dialog.
  return children;
}
