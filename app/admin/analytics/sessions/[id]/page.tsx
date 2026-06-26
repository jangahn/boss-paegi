import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-server";
import { getSessionDetail } from "@/lib/admin-analytics";
import { SessionTimeline } from "@/components/admin/analytics/SessionTimeline";
import { PaperPanel } from "@/components/dossier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");
  const { id } = await params;
  const s = await getSessionDetail(id);

  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Link href="/admin/analytics/sessions" className="text-sm text-sky-600 underline whitespace-nowrap">← 세션</Link>
          <h1 className="font-bold text-2xl sm:text-3xl">세션 {id.slice(0, 8)}</h1>
        </div>

        {!s ? (
          <p className="rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-sm text-zinc-500">
            세션을 찾을 수 없어요 — 30일 경과로 prune 됐거나 존재하지 않는 세션입니다.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-4">
              <Field label="유형" value={s.is_anon ? "익명" : "회원"} />
              <Field label="종료" value={s.end_reason ?? "—"} />
              <Field label="기기" value={s.device_class} />
              <Field label="시간(초)" value={String(Math.round((s.duration_ms ?? 0) / 1000))} />
              <Field label="점수" value={(s.score ?? 0).toLocaleString()} />
              <Field label="타격" value={(s.hit_count ?? 0).toLocaleString()} />
              <Field label="최대콤보" value={String(s.max_combo ?? 0)} />
              <Field label="궁극기" value={String(s.ult_fire_count ?? 0)} />
              <Field label="무기종수" value={String(s.distinct_weapons ?? 0)} />
              <Field label="맵순회" value={String(s.distinct_maps ?? 0)} />
              <Field label="APM" value={String(s.apm ?? 0)} />
              <Field label="tap비중" value={`${Math.round((s.tap_share ?? 0) * 100)}%`} />
              <Field label="첫타(ms)" value={s.first_hit_ms == null ? "—" : String(s.first_hit_ms)} />
              <Field label="첫전환(ms)" value={s.first_switch_ms == null ? "—" : String(s.first_switch_ms)} />
              <Field label="동시터치" value={String(s.max_touch ?? 0)} />
              <Field label="플래그" value={`${s.suspicious ? "의심 " : ""}${s.has_gap ? "gap" : ""}`.trim() || "—"} />
            </div>

            <PaperPanel className="min-w-0">
              <h2 className="mb-1 text-xs font-bold text-zinc-500">무기 요약</h2>
              <pre className="overflow-x-auto rounded-lg bg-foreground/5 p-2 text-[11px]">{JSON.stringify(s.weapon_summary, null, 0)}</pre>
            </PaperPanel>
            <PaperPanel className="min-w-0">
              <h2 className="mb-1 text-xs font-bold text-zinc-500">맵 요약</h2>
              <pre className="overflow-x-auto rounded-lg bg-foreground/5 p-2 text-[11px]">{JSON.stringify(s.map_summary, null, 0)}</pre>
            </PaperPanel>

            <PaperPanel className="min-w-0 overflow-x-auto">
              <h2 className="mb-1 text-xs font-bold text-zinc-500">타임라인</h2>
              <SessionTimeline timeline={s.timeline} />
            </PaperPanel>
          </>
        )}
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-foreground/10 p-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="tabular-nums font-medium">{value}</p>
    </div>
  );
}
