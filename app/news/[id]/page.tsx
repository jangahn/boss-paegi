import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { Markdown } from "@/components/events/Markdown";
import { getEventById } from "@/lib/events";
import { EVENT_TYPE_LABEL } from "@/lib/events/types";

function fmtKstDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const e = await getEventById(id);
  if (!e) return { title: "소식", robots: { index: false, follow: true } };
  return {
    title: e.title,
    description: e.summary,
    alternates: { canonical: `/news/${id}` },
    ...(e.noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title: e.title,
      description: e.summary,
      type: "article",
      ...(e.coverOgUrl ? { images: [{ url: e.coverOgUrl, width: 1200, height: 630 }] } : {}),
    },
  };
}

export default async function NewsDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const e = await getEventById(id);
  if (!e) notFound();

  return (
    <>
      <AppNav />
      {/* 약관/방침 페이지처럼 오프화이트(ui-surface) 본문. 커버·요약은 목록/팝업/배너/OG 메타로만 쓰고 본문엔 미노출. */}
      <main className="flex flex-1 flex-col ui-surface px-5 py-10">
        <article className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <Link href="/news" className="text-xs text-zinc-500 underline-offset-4 hover:text-foreground hover:underline">
            ← 소식
          </Link>

          <header className="border-b border-foreground/10 pb-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-foreground/10 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500">
                {EVENT_TYPE_LABEL[e.type]}
              </span>
              <span className="text-xs text-zinc-400">{fmtKstDate(e.published_at)}</span>
            </div>
            <h1 className="mt-2 text-2xl font-bold leading-snug tracking-tight">{e.title}</h1>
          </header>

          <Markdown>{e.body}</Markdown>
        </article>
      </main>
    </>
  );
}
