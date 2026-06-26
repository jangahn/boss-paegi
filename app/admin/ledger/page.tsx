import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getLedger } from "@/lib/admin-ledger";
import { LedgerTable } from "@/components/admin/LedgerTable";
import { LedgerFilter } from "@/components/admin/LedgerFilter";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";
import type { LedgerActionType } from "@/lib/admin-types";
import { PaperPanel } from "@/components/dossier";

// 처리 내역 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES = ["settle_stuck", "cancel_refund", "cs_adjust"];

export default async function AdminLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const typeRaw = firstParam(sp.type);
  const actionType = (typeRaw && TYPES.includes(typeRaw) ? typeRaw : null) as LedgerActionType | null;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (actionType) u.set("type", actionType);
    if (p > 1) u.set("page", String(p));
    return `/admin/ledger${u.toString() ? `?${u}` : ""}`;
  };

  const { rows, total, pageSize } = await getLedger({ page, actionType });
  if (!rows.length && page > 1) redirect(buildHref(1));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="font-display text-2xl sm:text-3xl font-bold">처리 내역</h1>
        <p className="text-xs leading-relaxed text-zinc-500">
          관리자 크레딧 조정 · 환불/취소 · stuck 지급 감사 로그(append-only).
        </p>
        <LedgerFilter actionType={actionType} />
        <p className="text-xs text-zinc-500">
          총 {total.toLocaleString()}건{actionType && " (필터 적용)"}
        </p>
        <PaperPanel className="overflow-x-auto">
          <LedgerTable rows={rows} />
        </PaperPanel>
        <Pagination page={page} totalPages={totalPages} hrefFor={buildHref} />
      </div>
    </main>
  );
}
