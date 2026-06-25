import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getReportQueue } from "@/lib/admin-moderation";
import { ReportQueueTable } from "@/components/admin/ReportQueueTable";
import { ReportFilter } from "@/components/admin/ReportFilter";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";

// 신고 큐 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES = ["pending", "actioned", "dismissed"];

export default async function AdminModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const statusRaw = firstParam(sp.status);
  const status = statusRaw && STATUSES.includes(statusRaw) ? statusRaw : null;
  const dollId = firstParam(sp.dollId)?.trim() || null;
  const ownerId = firstParam(sp.ownerId)?.trim() || null;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (dollId) u.set("dollId", dollId);
    if (ownerId) u.set("ownerId", ownerId);
    if (p > 1) u.set("page", String(p));
    return `/admin/moderation${u.toString() ? `?${u}` : ""}`;
  };

  const queue = await getReportQueue({ status, dollId, ownerId, page });
  if (queue.rows.length === 0 && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(queue.total / queue.pageSize));
  const filtered = !!(status || dollId || ownerId);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">신고</h1>
        <p className="text-xs leading-relaxed text-zinc-500">
          비동의 제3자 얼굴 등 신고된 콘텐츠. <b>숨김(takedown)은 가역</b> — 얼굴을 앱 전 표면에서
          기본 부장님으로 가리며(이 인형 대기 신고 모두 처리), 나중에 <b>복구</b>하거나 <b>영구삭제</b>
          (storage 객체 제거·복구 불가)할 수 있어요. 기각은 콘텐츠 유지. 캐릭터/제작자 id를 누르면 해당
          항목만 필터됩니다.
        </p>

        <ReportFilter status={status} dollId={dollId} ownerId={ownerId} />

        <p className="text-xs text-zinc-500">
          총 {queue.total.toLocaleString()}건{filtered && " (필터 적용)"}
        </p>

        {queue.rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            {filtered ? "조건에 맞는 신고가 없어요." : "신고가 없어요."}
          </p>
        ) : (
          <ReportQueueTable rows={queue.rows} />
        )}

        <Pagination page={queue.page} totalPages={totalPages} hrefFor={buildHref} />
      </div>
    </main>
  );
}
