import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { getOrders } from "@/lib/admin-orders";
import { OrdersTable } from "@/components/admin/OrdersTable";
import { OrdersFilter } from "@/components/admin/OrdersFilter";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";
import { PaperPanel } from "@/components/dossier";

// 전체 주문 — 실시간 운영이라 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES = ["pending", "paid", "canceled", "failed"];

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  // Next 16 searchParams 값은 string|string[]|undefined — firstParam 으로 안전 추출(반복 키 500 방지).
  const sp = await searchParams;
  const statusRaw = firstParam(sp.status);
  const status = statusRaw && STATUSES.includes(statusRaw) ? statusRaw : null;
  const q = firstParam(sp.q)?.trim() || null;
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);

  const buildHref = (p: number) => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (q) u.set("q", q);
    if (p > 1) u.set("page", String(p));
    return `/admin/orders${u.toString() ? `?${u}` : ""}`;
  };

  const { rows, total, pageSize } = await getOrders({ page, status, q });

  // overshoot(존재 주문 수보다 큰 page) → 빈 결과면 1페이지로 리다이렉트(total 오판·빈 화면 방지).
  if (!rows.length && page > 1) redirect(buildHref(1));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="font-display text-2xl font-bold sm:text-3xl">전체 주문</h1>
        <OrdersFilter status={status} q={q} />
        <p className="text-xs text-steel">
          총 {total.toLocaleString()}건{(status || q) && " (필터 적용)"}
        </p>
        <PaperPanel className="overflow-x-auto">
          <OrdersTable rows={rows} />
        </PaperPanel>
        <Pagination page={page} totalPages={totalPages} hrefFor={buildHref} />
      </div>
    </main>
  );
}
