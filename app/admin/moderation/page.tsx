import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getReportQueue, getPurgePendingDolls } from "@/lib/admin-moderation";
import { ReportQueueTable } from "@/components/admin/ReportQueueTable";

// 신고 큐 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminModerationPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const [{ rows, capped }, purgePending] = await Promise.all([
    getReportQueue(),
    getPurgePendingDolls(),
  ]);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">신고</h1>
        <p className="text-xs leading-relaxed text-zinc-500">
          비동의 제3자 얼굴 등 신고된 콘텐츠. <b>삭제(takedown)는 복구 불가</b> — 인형 이미지와
          관련 하이라이트 영상을 영구 삭제하고, 이 인형의 대기 신고를 모두 처리합니다. 기각은
          콘텐츠를 유지합니다.
        </p>

        {purgePending.length > 0 && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            ⚠️ 파일 삭제 확인 필요 {purgePending.length}건 — takedown 됐으나 storage 객체 물리삭제가
            미확정입니다(직링크 잔존 가능). cron 이 자동 재시도하며, 지속되면 Supabase Storage 에서
            수동 확인하세요.
          </div>
        )}

        {capped && (
          <p className="text-xs text-amber-600">신고가 많아 최근 200건만 표시합니다.</p>
        )}

        <p className="text-xs text-zinc-500">
          대기 중 신고 {rows.length.toLocaleString()}건
        </p>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            대기 중인 신고가 없어요.
          </p>
        ) : (
          <ReportQueueTable rows={rows} />
        )}
      </div>
    </main>
  );
}
