import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getAdminEvents } from "@/lib/events";
import { EVENT_TYPE_LABEL, isEventType, type EventType } from "@/lib/events/types";
import { FadeImg } from "@/components/FadeImg";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";

// 운영 목록 — 항상 최신.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fmtKst(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });
}

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const statusRaw = firstParam(sp.status);
  const status = statusRaw === "draft" || statusRaw === "published" ? statusRaw : undefined;
  const typeRaw = firstParam(sp.type);
  const type: EventType | undefined = typeRaw && isEventType(typeRaw) ? typeRaw : undefined;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const { items, total, totalPages } = await getAdminEvents({ status, type, page });
  if (items.length === 0 && page > 1) redirect("/admin/events");

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (type) u.set("type", type);
    if (p > 1) u.set("page", String(p));
    const q = u.toString();
    return q ? `/admin/events?${q}` : "/admin/events";
  };
  const filterHref = (k: "status" | "type", v: string | undefined) => {
    const u = new URLSearchParams();
    if (k === "status" ? v : status) u.set("status", k === "status" ? (v as string) : (status as string));
    if (k === "type" ? v : type) u.set("type", k === "type" ? (v as string) : (type as string));
    const q = u.toString();
    return q ? `/admin/events?${q}` : "/admin/events";
  };

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition ${
      active ? "bg-foreground text-paper-2" : "border border-foreground/20 text-zinc-500 hover:bg-foreground/5"
    }`;

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">이벤트/소식</h1>
          <Link href="/admin/events/new" className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-paper-2 hover:opacity-90">
            + 새 글
          </Link>
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">
          공지·이벤트를 작성·발행하고 <b>홈 팝업</b>·<b>배너 구좌</b>·<b>소식 게시판(/news)</b> 노출을 운영해요.
          노출은 <b>발행 + 노출 윈도우(시작~종료) + 플래그</b> 기준이며, 팝업·배너는 우선순위 1건만 보입니다.
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={filterHref("status", undefined)} className={chip(!status)}>전체상태</Link>
          <Link href={filterHref("status", "draft")} className={chip(status === "draft")}>초안</Link>
          <Link href={filterHref("status", "published")} className={chip(status === "published")}>발행됨</Link>
          <span className="mx-1 text-zinc-300">|</span>
          <Link href={filterHref("type", undefined)} className={chip(!type)}>전체타입</Link>
          <Link href={filterHref("type", "notice")} className={chip(type === "notice")}>공지</Link>
          <Link href={filterHref("type", "event")} className={chip(type === "event")}>이벤트</Link>
        </div>

        <p className="text-xs text-zinc-500">{total.toLocaleString()}개</p>

        {items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            글이 없어요. <Link href="/admin/events/new" className="underline">새 글</Link>을 작성하세요.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/admin/events/${e.id}`}
                  className="flex items-center gap-3 rounded-xl border border-foreground/10 p-3 transition hover:bg-foreground/5"
                >
                  {e.coverThumbUrl && (
                    // og(1200×630)와 같은 40:21 + 서버 리사이즈 썸네일(풀커버 대신) + shimmer.
                    <FadeImg
                      src={e.coverThumbUrl}
                      className="aspect-[40/21] w-20 shrink-0 rounded-lg"
                      fit="cover"
                      placeholder="shimmer"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
                        {EVENT_TYPE_LABEL[e.type]}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          e.status === "published"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        }`}
                      >
                        {e.status === "published" ? "발행" : "초안"}
                      </span>
                      {e.popup_active && <span className="text-[10px] text-sky-500">● 팝업</span>}
                      {(e.banner_home_active || e.banner_gallery_active || e.banner_leaderboard_active) && (
                        <span className="text-[10px] text-violet-500">
                          ● 배너
                          {[
                            e.banner_home_active && "홈",
                            e.banner_gallery_active && "갤러리",
                            e.banner_leaderboard_active && "랭킹",
                          ]
                            .filter(Boolean)
                            .join("·")}
                        </span>
                      )}
                      {e.pinned && <span className="text-[10px] text-zinc-400">📌</span>}
                    </div>
                    <p className="mt-0.5 truncate text-sm font-medium">{e.title}</p>
                    <p className="truncate text-xs text-zinc-400">{e.summary}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-400">{fmtKst(e.updated_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Pagination page={page} totalPages={totalPages} hrefFor={buildHref} />
      </div>
    </main>
  );
}
