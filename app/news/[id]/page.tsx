import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { Markdown } from "@/components/events/Markdown";
import { getEventById } from "@/lib/events";
import { EVENT_TYPE_LABEL } from "@/lib/events/types";
import { resolveOgImages } from "@/lib/site-assets";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";

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
  // 우선순위: 이벤트 cover > media_config 기본 OG > 정적 default. openGraph 는 deep-merge 안 되므로
  // images 를 항상 명시(없으면 layout 기본 OG 를 잃음). twitter 도 동일 우선순위로 미러.
  const ogImages = await resolveOgImages(e.coverOgUrl);
  return {
    title: e.title,
    description: e.summary,
    alternates: { canonical: `/news/${id}` },
    ...(e.noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title: e.title,
      description: e.summary,
      siteName: SERVICE_NAME,
      url: `${SITE_URL}/news/${id}`,
      locale: "ko_KR",
      type: "article",
      images: ogImages,
    },
    twitter: { card: "summary_large_image", title: e.title, description: e.summary, images: ogImages },
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
