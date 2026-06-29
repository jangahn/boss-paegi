import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import {
  listGenerations,
  GEN_STATUS_FILTERS,
  type GenStatusFilter,
} from "@/lib/admin-generations";
import { GenStatusFilter as GenStatusFilterBar } from "@/components/admin/GenStatusFilter";
import { GenerationsTable } from "@/components/admin/GenerationsTable";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";

// 생성 현황 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminGenerationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const ownerId = firstParam(sp.ownerId)?.trim() || null;
  const dollId = firstParam(sp.dollId)?.trim() || null;
  const statusRaw = firstParam(sp.status);
  const status: GenStatusFilter =
    statusRaw && (GEN_STATUS_FILTERS as readonly string[]).includes(statusRaw)
      ? (statusRaw as GenStatusFilter)
      : "all";
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (status !== "all") u.set("status", status);
    if (ownerId) u.set("ownerId", ownerId);
    if (dollId) u.set("dollId", dollId);
    if (p > 1) u.set("page", String(p));
    const qs = u.toString();
    return `/admin/generations${qs ? `?${qs}` : ""}`;
  };

  const result = await listGenerations({ status, ownerId, dollId, page });
  if (result.rows.length === 0 && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const filtered = !!(ownerId || dollId || status !== "all");

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-bold">캐릭터 생성</h1>
        <p className="text-xs leading-relaxed text-zinc-500">
          캐릭터 생성 요청을 <b>상태</b>별로 봅니다. <b>생성요청</b>=진행 중 · <b>선택 전</b>=후보
          3장 대기 · <b>선택완료</b>=고름 · <b>거부(얼굴X)</b>=얼굴 미검출로 반려 · <b>기타 실패</b>=
          그 외 실패. 회원/캐릭터 id를 누르면 해당 항목만 필터돼요. <b>크레딧</b> 표기는 추정값입니다(정확한
          변동 기록은 처리내역 연동 예정).
        </p>

        <GenStatusFilterBar status={status} ownerId={ownerId} dollId={dollId} />

        <p className="text-xs text-zinc-500">
          {result.total.toLocaleString()}건{filtered && " (필터 적용)"}
        </p>

        {result.rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-foreground/15 p-12 text-center text-zinc-500">
            {filtered ? "조건에 맞는 생성이 없어요." : "생성 기록이 없어요."}
          </p>
        ) : (
          <GenerationsTable rows={result.rows} />
        )}

        <Pagination page={result.page} totalPages={totalPages} hrefFor={buildHref} />
      </div>
    </main>
  );
}
