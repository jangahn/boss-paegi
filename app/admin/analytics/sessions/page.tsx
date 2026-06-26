import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-server";
import { getRecentSessions } from "@/lib/admin-analytics";
import { PaperPanel } from "@/components/dossier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fmtKst(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default async function SessionsPage() {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");
  const rows = await getRecentSessions(50);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="flex items-center gap-2">
          <Link href="/admin/analytics" className="text-sm text-sky-600 underline">← 분석</Link>
          <h1 className="font-display text-2xl sm:text-3xl">최근 세션</h1>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-400">아직 세션이 없어요.</p>
        ) : (
          <PaperPanel className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-foreground/5 text-zinc-500">
                <tr>
                  <th className="px-3 py-2">시각(KST)</th>
                  <th className="px-2 py-2">유형</th>
                  <th className="px-2 py-2 text-right">점수</th>
                  <th className="px-2 py-2 text-right">타격</th>
                  <th className="px-2 py-2 text-right">무기/맵</th>
                  <th className="px-2 py-2">종료</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-foreground/5">
                    <td className="px-3 py-2 tabular-nums">{fmtKst(r.started_at)}</td>
                    <td className="px-2 py-2">{r.is_anon ? "익명" : "회원"}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.score.toLocaleString()}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.hit_count.toLocaleString()}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.distinct_weapons}/{r.distinct_maps}</td>
                    <td className="px-2 py-2 text-zinc-500">{r.end_reason ?? "—"}</td>
                    <td className="px-2 py-2">
                      <Link href={`/admin/analytics/sessions/${r.id}`} className="text-sky-600 underline">상세</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PaperPanel>
        )}
      </div>
    </main>
  );
}
