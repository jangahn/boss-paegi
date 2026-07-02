import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import {
  getIntegrityQueue,
  INTEGRITY_STATES,
  INTEGRITY_PAGE_SIZE,
  type IntegrityState,
} from "@/lib/admin-integrity";
import { Pagination } from "@/components/Pagination";
import { firstParam } from "@/lib/admin-format";

// 실시간 운영 큐 — 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_LABEL: Record<string, string> = {
  pending: "검토 대기",
  cleared: "정상 확인",
  voided: "무효",
  all: "전체",
};

export default async function AdminIntegrityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const stateRaw = firstParam(sp.state);
  const state: IntegrityState =
    stateRaw && (INTEGRITY_STATES as readonly string[]).includes(stateRaw)
      ? (stateRaw as IntegrityState)
      : "pending";
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);
  const { rows, total } = await getIntegrityQueue(state, page);
  const totalPages = Math.max(1, Math.ceil(total / INTEGRITY_PAGE_SIZE));

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-xl font-bold">무결성 — 어뷰징 리뷰 큐</h1>
      <p className="mt-1 text-sm text-zinc-400">
        비정상 플레이 패턴이 감지된 점수. 지표를 확인하고 정상 확인/무효/유저 정지를 결정합니다.
      </p>

      {/* 상태 필터 */}
      <div className="mt-4 flex flex-wrap gap-2">
        {INTEGRITY_STATES.map((s) => (
          <Link
            key={s}
            href={`/admin/integrity?state=${s}`}
            className={`rounded-full px-3 py-1.5 text-sm transition ${
              s === state ? "bg-white text-black" : "border border-white/20 text-zinc-300 hover:bg-white/10"
            }`}
          >
            {STATE_LABEL[s]}
          </Link>
        ))}
      </div>

      <p className="mt-3 text-xs text-zinc-500">총 {total.toLocaleString()}건</p>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-white/15 p-10 text-center text-zinc-500">
          해당 상태의 항목이 없습니다.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/15 text-left text-xs text-zinc-400">
                <th className="py-2 pr-3">위험도</th>
                <th className="py-2 pr-3">점수</th>
                <th className="py-2 pr-3">유저</th>
                <th className="py-2 pr-3">상태</th>
                <th className="py-2 pr-3">신호</th>
                <th className="py-2 pr-3">시각</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.scoreId} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 pr-3">
                    <Link href={`/admin/integrity/${r.scoreId}`} className="font-bold text-amber-400 underline-offset-2 hover:underline">
                      {r.abuseScore}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{r.score.toLocaleString()}</td>
                  <td className="py-2 pr-3">
                    <Link href={`/admin/integrity/${r.scoreId}`} className="text-zinc-200 underline-offset-2 hover:underline">
                      {r.ownerName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-xs text-zinc-400">{STATE_LABEL[r.status] ?? r.status}</td>
                  <td className="py-2 pr-3 text-[11px] text-zinc-400">{r.signalIds.slice(0, 4).join(", ")}</td>
                  <td className="py-2 pr-3 text-[11px] text-zinc-500">
                    {new Date(r.scoreCreatedAt).toLocaleString("ko-KR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4">
        <Pagination page={page} totalPages={totalPages} hrefFor={(p) => `/admin/integrity?state=${state}&page=${p}`} />
      </div>
    </main>
  );
}
