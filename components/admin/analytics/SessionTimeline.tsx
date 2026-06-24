/** 세션 타임라인 재생 — timeline jsonb 이벤트를 시간순 카드로. null=익명/pruned. */

type Ev = { seq?: number; type?: string; t?: number; [k: string]: unknown };

const TYPE_COLOR: Record<string, string> = {
  session_start: "text-zinc-500",
  weapon_select_attempt: "text-sky-500",
  weapon_switch: "text-sky-600",
  map_select_attempt: "text-emerald-500",
  map_switch: "text-emerald-600",
  hit_bucket: "text-zinc-600",
  combo_break: "text-orange-500",
  ult_charge_ready: "text-amber-500",
  ult_fire: "text-red-500",
  idle_gap: "text-zinc-400",
  session_end: "text-foreground",
};

function fmtT(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function SessionTimeline({ timeline }: { timeline: unknown }) {
  if (!Array.isArray(timeline)) {
    return (
      <p className="rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-xs text-zinc-500">
        타임라인 없음 — 익명 세션(요약만 저장) 또는 30일 경과로 prune 됨. 요약 지표는 위에 표시됩니다.
      </p>
    );
  }
  const evs = (timeline as Ev[]).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return (
    <div className="flex flex-col gap-1">
      {evs.map((e, i) => {
        const extra = Object.entries(e)
          .filter(([k]) => !["seq", "type", "t"].includes(k))
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join("  ");
        return (
          <div key={i} className="flex items-start gap-2 rounded-lg bg-foreground/5 px-2.5 py-1.5 text-[11px]">
            <span className="w-10 shrink-0 tabular-nums text-zinc-400">{fmtT(e.t ?? 0)}</span>
            <span className={`w-32 shrink-0 font-medium ${TYPE_COLOR[e.type ?? ""] ?? "text-zinc-600"}`}>{e.type}</span>
            <span className="flex-1 break-all text-zinc-500">{extra}</span>
          </div>
        );
      })}
    </div>
  );
}
