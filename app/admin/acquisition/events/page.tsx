import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import {
  getAnalyticsEvents,
  isAnalyticsEventKind,
  type AnalyticsEventKind,
} from "@/lib/admin-acquisition-events";
import { AnalyticsEventFilter } from "@/components/admin/AnalyticsEventFilter";
import { AnalyticsEventList } from "@/components/admin/AnalyticsEventList";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";
import { parsePageParam } from "@/lib/pagination";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 「공유·유입」 원본 이벤트(v1.31) — analytics_events raw 를 종류 필터·페이지로 그대로 본다.
 * 집계가 답하지 못하는 "직접 유입이 어디서 오나" 를 UA·레퍼러 원문으로 사람이 읽는 화면. 파싱·분류는 하지 않는다.
 */
export default async function AcquisitionEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const kindRaw = firstParam(sp.kind);
  const kind: AnalyticsEventKind | null = isAnalyticsEventKind(kindRaw) ? kindRaw : null;
  const page = parsePageParam(firstParam(sp.page));

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (kind) u.set("kind", kind);
    if (p > 1) u.set("page", String(p));
    return `/admin/acquisition/events${u.toString() ? `?${u}` : ""}`;
  };

  const { rows, total, pageSize } = await getAnalyticsEvents({ page, kind });
  if (!rows.length && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <p className="text-xs leading-relaxed text-zinc-400">
        원본 이벤트(최근 90일, 최신순). UA·레퍼러는 저장된 원문 그대로예요 — 어떤 앱·브라우저에서 왔는지는
        여기서 직접 읽고, 분류는 나중에 정해요. 식별자는 없어요(무식별 도메인).
      </p>
      <AnalyticsEventFilter kind={kind} />
      <p className="text-xs text-zinc-500">
        총 {total.toLocaleString()}건{kind && " (필터 적용)"} · {pageSize}건씩
      </p>
      <AnalyticsEventList rows={rows} />
      <Pagination page={page} totalPages={totalPages} hrefFor={buildHref} />
    </>
  );
}
