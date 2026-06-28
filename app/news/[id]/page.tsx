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
      ...(e.coverUrl ? { images: [{ url: e.coverUrl }] } : {}),
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
      <main className="flex flex-1 flex-col px-6 py-8">
        <article className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <Link href="/news" className="text-xs text-zinc-500 hover:text-foreground">
            ← 소식
          </Link>

          <div className="flex items-center gap-2">
            <span className="rounded-full bg-foreground/10 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500">
              {EVENT_TYPE_LABEL[e.type]}
            </span>
            <span className="text-xs text-zinc-400">{fmtKstDate(e.published_at)}</span>
          </div>

          <h1 className="text-2xl font-bold leading-snug">{e.title}</h1>
          <p className="text-sm text-zinc-500">{e.summary}</p>

          {e.coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={e.coverUrl} alt="" className="w-full rounded-2xl object-cover" />
          )}

          <div className="mt-1 border-t border-foreground/10 pt-4">
            <Markdown>{e.body}</Markdown>
          </div>
        </article>
      </main>
    </>
  );
}
