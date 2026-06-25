import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getReportQueue, getPurgePendingDolls } from "@/lib/admin-moderation";
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

  const [queue, purgePending] = await Promise.all([
    getReportQueue({ status, dollId, ownerId, page }),
    getPurgePendingDolls(),
  ]);
  if (queue.rows.length === 0 && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(queue.total / queue.pageSize));
  const filtered = !!(status || dollId || ownerId);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">신고</h1>
        <p className="text-xs leading-relaxed text-zinc-500">
          비동의 제3자 얼굴 등 신고된 콘텐츠. <b>삭제(takedown)는 복구 불가</b>(인형 이미지·관련
          하이라이트 영상을 영구 삭제, 이 인형의 대기 신고 모두 처리). 기각은 콘텐츠 유지. 캐릭터/제작자
          id를 누르면 해당 항목만 필터됩니다.
        </p>

        {purgePending.length > 0 && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            ⚠️ 파일 삭제 확인 필요 {purgePending.length}건 — takedown 됐으나 storage 객체 물리삭제가
            미확정입니다(직링크 잔존 가능). cron 이 자동 재시도하며, 지속되면 Supabase Storage 에서
            수동 확인하세요.
          </div>
        )}

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
