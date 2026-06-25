import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getModerationQueue, type ModState } from "@/lib/admin-moderation";
import { ModerationQueueTable } from "@/components/admin/ModerationQueueTable";
import { ReportFilter } from "@/components/admin/ReportFilter";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";

// 신고 큐 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 처리상태 단일축 + 전체. 기본 뷰 = 대기(처리할 것). 특정 캐릭터/제작자로 진입하면 전체(어느 상태든 보이게).
const STATE_PARAMS = ["pending", "hidden", "purged", "dismissed", "all"];

export default async function AdminModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const dollId = firstParam(sp.dollId)?.trim() || null;
  const ownerId = firstParam(sp.ownerId)?.trim() || null;
  const stateRaw = firstParam(sp.state);
  const stateParam =
    stateRaw && STATE_PARAMS.includes(stateRaw)
      ? stateRaw
      : dollId || ownerId
        ? "all"
        : "pending";
  const queryState: ModState | null = stateParam === "all" ? null : (stateParam as ModState);
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    u.set("state", stateParam);
    if (dollId) u.set("dollId", dollId);
    if (ownerId) u.set("ownerId", ownerId);
    if (p > 1) u.set("page", String(p));
    return `/admin/moderation?${u}`;
  };

  const queue = await getModerationQueue(gate.user.id, {
    state: queryState,
    dollId,
    ownerId,
    page,
  });
  if (queue.rows.length === 0 && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(queue.total / queue.pageSize));
  const filtered = !!(dollId || ownerId);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">신고</h1>
        <p className="text-xs leading-relaxed text-zinc-500">
          신고된 캐릭터를 <b>처리상태</b>별로 봅니다. <b>대기</b>=결정 전 · <b>숨김</b>=얼굴 가림(가역,
          기본 부장님 대체) · <b>영구삭제</b>=파일 제거(복구 불가) · <b>기각</b>=신고 무효·공개 유지.
          숨김은 나중에 <b>복구</b>하거나 <b>영구삭제</b>할 수 있어요. 캐릭터/제작자 id를 누르면 해당
          항목만 필터됩니다.
        </p>

        <ReportFilter state={stateParam} dollId={dollId} ownerId={ownerId} />

        <p className="text-xs text-zinc-500">
          {queue.total.toLocaleString()}개 캐릭터{filtered && " (필터 적용)"}
        </p>

        {queue.rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            {stateParam === "pending" && !filtered
              ? "대기 중인 신고가 없어요."
              : "조건에 맞는 항목이 없어요."}
          </p>
        ) : (
          <ModerationQueueTable rows={queue.rows} />
        )}

        <Pagination page={queue.page} totalPages={totalPages} hrefFor={buildHref} />
      </div>
    </main>
  );
}
