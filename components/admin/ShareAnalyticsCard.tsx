import type { ShareStats } from "@/lib/admin-analytics";

// 공유 분석 카드 — 게임오버 전환 퍼널(무식별 근사) + 표면/대상/점수대/회원여부 분포.
// 메인 지표는 '공유 시도'(클릭). 성공/취소는 미집계(MVP).

const SURFACE_KO: Record<string, string> = {
  game_over: "게임오버",
  history: "이전기록",
  highlight_viewer: "하이라이트 뷰어",
  doll: "캐릭터(/doll)",
  gallery: "갤러리",
};
const TARGET_KO: Record<string, string> = { score: "점수", doll: "캐릭터", highlight: "하이라이트" };
const MEMBER_KO: Record<string, string> = { anon: "비회원", member: "회원" };

function DistRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 truncate text-zinc-500">{label}</span>
      <div className="relative h-4 flex-1 overflow-hidden rounded bg-foreground/5">
        <div className="absolute inset-y-0 left-0 rounded bg-foreground/25" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

function DistBlock({ title, rows }: { title: string; rows: { label: string; value: number }[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <div className="rounded-xl border border-foreground/10 ui-surface p-3">
      <p className="mb-2 text-[11px] font-semibold text-zinc-400">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-zinc-400">데이터 없음</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <DistRow key={r.label} label={r.label} value={r.value} max={max} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ShareAnalyticsCard({ stats, tierLabels }: { stats: ShareStats; tierLabels: string[] }) {
  const { funnel } = stats;
  const ratePct = funnel.rate === null ? "—" : `${(funnel.rate * 100).toFixed(1)}%`;
  return (
    <div className="flex flex-col gap-3">
      {/* 게임오버 전환 퍼널 */}
      <div className="rounded-xl border border-foreground/10 ui-surface p-3">
        <p className="mb-2 text-[11px] font-semibold text-zinc-400">
          게임오버 전환 <span className="font-normal">— 점수제출 → 그 자리 공유 시도</span>
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Mini label="점수제출" value={funnel.scoreSubmit.toLocaleString()} />
          <Mini label="게임오버 공유" value={funnel.gameOverShare.toLocaleString()} />
          <Mini label="전환율" value={ratePct} accent />
        </div>
      </div>

      <DistBlock title="표면별 공유 시도" rows={stats.bySurface.map((r) => ({ label: SURFACE_KO[r.key] ?? r.key, value: r.value }))} />
      <DistBlock title="대상별 공유 시도" rows={stats.byTarget.map((r) => ({ label: TARGET_KO[r.key] ?? r.key, value: r.value }))} />
      <DistBlock
        title="점수대별 공유 시도 (점수 공유 한정)"
        rows={stats.byScoreTier.map((r) => ({ label: tierLabels[r.tier] ?? `${r.tier}단계`, value: r.value }))}
      />
      <DistBlock title="회원여부별 공유 시도" rows={stats.byMemberState.map((r) => ({ label: MEMBER_KO[r.key] ?? r.key, value: r.value }))} />
    </div>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-2 text-center">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-base font-extrabold tabular-nums ${accent ? "text-sky-600" : ""}`}>{value}</p>
    </div>
  );
}
