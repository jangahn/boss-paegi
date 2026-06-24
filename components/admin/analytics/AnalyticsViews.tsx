import { WEAPONS } from "@/lib/weapons";
import { BACKGROUNDS } from "@/lib/backgrounds";
import type { DimStat, Funnel } from "@/lib/admin-analytics";

/** 게임플레이 분석 표시 컴포넌트 — 차트 라이브러리 없이 CSS 바 + 카드. */

const WEAPON_LABEL: Record<string, string> = Object.fromEntries(WEAPONS.map((w) => [w.key, `${w.emoji} ${w.label}`]));
const MAP_LABEL: Record<string, string> = Object.fromEntries(BACKGROUNDS.map((b) => [b.key, b.label]));

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

/** 무기/맵 밸런스 — hits 점유율 바 + 효율(점/타). 점유율 불균등이 한눈에. */
export function BalanceBars({ stats, kind }: { stats: DimStat[]; kind: "weapon" | "map" }) {
  const labels = kind === "weapon" ? WEAPON_LABEL : MAP_LABEL;
  const total = stats.reduce((s, x) => s + x.hits, 0);
  const max = Math.max(1, ...stats.map((x) => x.hits));
  if (!stats.length || total === 0) {
    return <p className="text-sm text-zinc-400">아직 데이터가 없어요.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {stats.map((s) => {
        const share = s.hits / total;
        const eff = s.hits > 0 ? (s.score / s.hits).toFixed(1) : "—";
        const dominant = share >= 0.5;
        return (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-zinc-600 dark:text-zinc-300">{labels[s.key] ?? s.key}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-foreground/5">
              <div
                className={`h-full rounded ${dominant ? "bg-red-400/80" : "bg-sky-400/70"}`}
                style={{ width: `${Math.max(2, (s.hits / max) * 100)}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right tabular-nums font-medium">{pct(s.hits, total)}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-zinc-400" title="점/타 효율">{eff}/타</span>
            <span className="w-20 shrink-0 text-right tabular-nums text-zinc-400" title="전환/시도">
              {s.switches}↔/{s.attempts}
            </span>
          </div>
        );
      })}
      <p className="mt-1 text-[11px] text-zinc-400">바=타격 점유율(빨강=50%+ 독점), 점/타=효율, ↔/시도=전환/선택시도. 총 {total.toLocaleString()}타.</p>
    </div>
  );
}

/** 플레이내 펀널 — 진입→첫타→첫전환→궁극→완료. */
export function FunnelView({ funnel }: { funnel: Funnel }) {
  const entered = funnel.entered ?? 0;
  const steps: { key: string; label: string }[] = [
    { key: "entered", label: "진입" },
    { key: "first_hit", label: "첫 타격" },
    { key: "first_switch", label: "첫 전환" },
    { key: "first_ult", label: "첫 궁극기" },
    { key: "completed", label: "정상 완료" },
  ];
  if (entered === 0) return <p className="text-sm text-zinc-400">아직 데이터가 없어요.</p>;
  return (
    <>
      <div className="grid grid-cols-5 gap-1 text-center">
        {steps.map((st) => (
          <div key={st.key} className="rounded-lg border border-foreground/10 p-2">
            <p className="text-[10px] text-zinc-500">{st.label}</p>
            <p className="text-base font-bold tabular-nums">{(funnel[st.key] ?? 0).toLocaleString()}</p>
            {st.key !== "entered" && <p className="text-[10px] text-amber-600">{pct(funnel[st.key] ?? 0, entered)}</p>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-foreground/15 px-2.5 py-1">강제종료 <b>{funnel.forced ?? 0}</b></span>
        <span className="rounded-full border border-foreground/15 px-2.5 py-1">이탈 <b>{funnel.abandoned ?? 0}</b></span>
        <span className="rounded-full border border-foreground/15 px-2.5 py-1">맵전환(2곳+) <b>{funnel.multi_map ?? 0}</b> ({pct(funnel.multi_map ?? 0, entered)})</span>
      </div>
    </>
  );
}
