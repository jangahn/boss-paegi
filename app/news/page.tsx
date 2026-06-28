import Link from "next/link";
import type { Metadata } from "next";
import { AppNav } from "@/components/AppNav";
import { FadeImg } from "@/components/FadeImg";
import { Pagination } from "@/components/Pagination";
import { getPublishedEvents } from "@/lib/events";
import { EVENT_TYPE_LABEL, isEventType, type EventType } from "@/lib/events/types";

export const metadata: Metadata = {
  title: "소식 · 공지·이벤트",
  description: "부장님패기의 공지와 이벤트 소식.",
  alternates: { canonical: "/news" },
};

function fmtKstDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const typeRaw = firstParam(sp.type);
  const type: EventType | undefined = typeRaw && isEventType(typeRaw) ? typeRaw : undefined;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const { items, totalPages } = await getPublishedEvents({ type: type ?? null, page });

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (type) u.set("type", type);
    if (p > 1) u.set("page", String(p));
    const q = u.toString();
    return q ? `/news?${q}` : "/news";
  };
  const typeHref = (t: EventType | undefined) => (t ? `/news?type=${t}` : "/news");
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition ${
      active ? "bg-foreground text-paper-2" : "border border-foreground/20 text-zinc-500 hover:bg-foreground/5"
    }`;

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          <h1 className="text-2xl font-bold">소식</h1>

          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={typeHref(undefined)} className={chip(!type)}>전체</Link>
            <Link href={typeHref("notice")} className={chip(type === "notice")}>공지</Link>
            <Link href={typeHref("event")} className={chip(type === "event")}>이벤트</Link>
          </div>

          {items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
              아직 등록된 소식이 없어요.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((e) => (
                <li key={e.id}>
                  <Link
                    href={`/news/${e.id}`}
                    className="flex items-center gap-3 rounded-2xl border border-foreground/10 ui-surface p-3 transition hover:bg-foreground/10"
                  >
                    {e.coverUrl && (
                      // og(1200×630)와 같은 1.91:1. coverThumbUrl=서버 리사이즈 썸네일(목록 로드 가볍게) + shimmer.
                      <FadeImg
                        src={e.coverThumbUrl ?? e.coverUrl}
                        fallbackSrc={e.coverUrl}
                        placeholder="shimmer"
                        className="aspect-[1200/630] w-28 shrink-0 rounded-xl"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {e.pinned && <span className="text-[11px] text-amber-500">📌</span>}
                        <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
                          {EVENT_TYPE_LABEL[e.type]}
                        </span>
                        <span className="text-[11px] text-zinc-400">{fmtKstDate(e.published_at)}</span>
                      </div>
                      <p className="mt-1 truncate text-base font-semibold">{e.title}</p>
                      <p className="truncate text-xs text-zinc-500">{e.summary}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Pagination page={page} totalPages={totalPages} hrefFor={buildHref} />
        </div>
      </main>
    </>
  );
}
