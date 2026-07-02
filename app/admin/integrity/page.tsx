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
import { firstParam, shortId, fmtKst } from "@/lib/admin-format";

// 실시간 운영 큐 — 캐시 금지.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "검토 대기", cls: "bg-amber-500/15 text-amber-600" },
  cleared: { label: "정상 확인", cls: "bg-emerald-500/15 text-emerald-600" },
  voided: { label: "무효", cls: "bg-red-500/15 text-red-500" },
};

export default async function AdminIntegrityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");

  const sp = await searchParams;
  const ownerId = firstParam(sp.ownerId)?.trim() || null;
  const stateRaw = firstParam(sp.state);
  const state: IntegrityState =
    stateRaw && (INTEGRITY_STATES as readonly string[]).includes(stateRaw)
      ? (stateRaw as IntegrityState)
      : ownerId
        ? "all"
        : "pending";
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);
  const { rows, total } = await getIntegrityQueue(state, page, ownerId);
  const totalPages = Math.max(1, Math.ceil(total / INTEGRITY_PAGE_SIZE));

  const hrefFor = (over: Record<string, string | number | null>) => {
    const u = new URLSearchParams();
    const s = (over.state ?? state) as string;
    if (s) u.set("state", s);
    const o = "ownerId" in over ? over.ownerId : ownerId;
    if (o) u.set("ownerId", String(o));
    if (over.page && Number(over.page) > 1) u.set("page", String(over.page));
    return `/admin/integrity?${u.toString()}`;
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-xl font-bold">무결성 — 어뷰징 리뷰 큐</h1>
      <p className="mt-1 text-sm text-zinc-500">
        비정상 플레이 패턴이 감지된 점수. 지표를 확인하고 정상 확인·무효·유저 정지를 결정합니다.
      </p>

      {/* 상태 필터 */}
      <div className="mt-4 flex flex-wrap gap-2">
        {INTEGRITY_STATES.map((s) => {
          const active = s === state;
          return (
            <Link
              key={s}
              href={hrefFor({ state: s, page: 1 })}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-foreground text-paper-2"
                  : "border border-foreground/15 text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {s === "all" ? "전체" : STATE_META[s]?.label ?? s}
            </Link>
          );
        })}
      </div>

      {/* 유저 필터 표시 */}
      {ownerId && (
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
          <span className="rounded-full border border-foreground/15 px-2 py-0.5 font-mono">
            이 유저만 · {shortId(ownerId)}
          </span>
          <Link href={hrefFor({ ownerId: null, page: 1 })} className="text-sky-600 underline-offset-2 hover:underline">
            필터 해제 ✕
          </Link>
        </div>
      )}

      <p className="mt-3 text-xs text-zinc-500">총 {total.toLocaleString()}건</p>

      {rows.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-dashed border-foreground/15 p-10 text-center text-zinc-500">
          해당 조건의 항목이 없습니다.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => {
            const st = STATE_META[r.status] ?? { label: r.status, cls: "bg-foreground/10 text-zinc-500" };
            return (
              <li key={r.scoreId} className="rounded-2xl border border-foreground/10 ui-surface p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-bold text-red-500">
                        위험도 {r.abuseScore}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>
                        {st.label}
                      </span>
                      <span className="text-[11px] text-zinc-400">· {fmtKst(r.scoreCreatedAt)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                      <Link
                        href={hrefFor({ ownerId: r.ownerId, page: 1 })}
                        className="rounded-full border border-foreground/15 px-2 py-0.5 text-zinc-500 transition hover:bg-foreground/10"
                        title="이 유저만 필터"
                      >
                        {r.ownerName}
                      </Link>
                      <Link
                        href={`/admin/users/${r.ownerId}`}
                        className="text-sky-600 underline-offset-2 hover:underline"
                        title="회원 상세로 이동"
                      >
                        회원 →
                      </Link>
                    </div>
                    {r.signalIds.length > 0 && (
                      <p className="mt-1 font-mono text-[11px] text-zinc-500">
                        {r.signalIds.slice(0, 5).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-lg font-extrabold tabular-nums">{r.score.toLocaleString()}</div>
                    <Link
                      href={`/admin/integrity/${r.scoreId}`}
                      className="text-xs text-sky-600 underline-offset-2 hover:underline"
                    >
                      상세 →
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4">
        <Pagination page={page} totalPages={totalPages} hrefFor={(p) => hrefFor({ page: p })} />
      </div>
    </main>
  );
}
