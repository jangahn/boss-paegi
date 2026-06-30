import type { AcquisitionStats } from "@/lib/admin-acquisition";

// 유입 분석 카드 — 방문 현황(current) + source별 전환(first-touch·무식별 근사) + 바이럴 루프.
// 전환율은 세션/점수제출/계정 단위가 섞인 근사. 무식별이라 100% 보장/캡 안 함, 분모 0이면 "—".

const KIND_KO: Record<string, string> = { direct: "직접", utm: "UTM", referrer: "referrer", viral: "바이럴", "기타": "기타" };
const VIRAL_KO: Record<string, string> = { score: "점수 공유 경유", doll: "캐릭터 공유 경유" };

function sourceLabel(kind: string, value: string): string {
  const k = KIND_KO[kind] ?? kind;
  if (kind === "direct" || kind === "기타" || !value) return k;
  if (kind === "viral") return `${k} · ${value === "score" ? "점수" : value === "doll" ? "캐릭터" : value}`;
  return `${k} · ${value}`;
}

function rate(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function AcquisitionCard({ stats }: { stats: AcquisitionStats }) {
  const { currentBySource, currentByKind, conversion, viralLoop } = stats;
  const curMax = currentBySource.reduce((m, r) => Math.max(m, r.visits), 0);

  return (
    <div className="flex flex-col gap-3">
      {/* 방문 유입 현황(current) */}
      <div className="rounded-xl border border-foreground/10 ui-surface p-3">
        <p className="mb-2 text-[11px] font-semibold text-zinc-400">
          방문 유입 현황 <span className="font-normal">— 현재 진입 기준(채널 합계: {currentByKind.map((k) => `${KIND_KO[k.key] ?? k.key} ${k.value}`).join(" · ") || "없음"})</span>
        </p>
        {currentBySource.length === 0 ? (
          <p className="text-[11px] text-zinc-400">데이터 없음</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {currentBySource.map((r, i) => {
              const pct = curMax > 0 ? Math.round((r.visits / curMax) * 100) : 0;
              return (
                <div key={`${r.sourceKind} ${r.sourceValue} ${i}`} className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 truncate text-zinc-500">{sourceLabel(r.sourceKind, r.sourceValue)}</span>
                  <div className="relative h-4 flex-1 overflow-hidden rounded bg-foreground/5">
                    <div className="absolute inset-y-0 left-0 rounded bg-foreground/25" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{r.visits.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* source별 전환(first-touch) */}
      <div className="rounded-xl border border-foreground/10 ui-surface p-3">
        <p className="mb-2 text-[11px] font-semibold text-zinc-400">
          유입 → 전환 <span className="font-normal">— first-touch 귀속 · 방문 대비 플레이/가입</span>
        </p>
        {conversion.length === 0 ? (
          <p className="text-[11px] text-zinc-400">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="text-left text-[10px] text-zinc-400">
                  <th className="pb-1 font-medium">소스</th>
                  <th className="pb-1 text-right font-medium">방문</th>
                  <th className="pb-1 text-right font-medium">플레이</th>
                  <th className="pb-1 text-right font-medium">→%</th>
                  <th className="pb-1 text-right font-medium">가입</th>
                  <th className="pb-1 text-right font-medium">→%</th>
                </tr>
              </thead>
              <tbody>
                {conversion.map((r, i) => (
                  <tr key={`${r.sourceKind} ${r.sourceValue} ${i}`} className="border-t border-foreground/5">
                    <td className="py-1 pr-2 text-zinc-600">{sourceLabel(r.sourceKind, r.sourceValue)}</td>
                    <td className="py-1 text-right">{r.visits.toLocaleString()}</td>
                    <td className="py-1 text-right">{r.play.toLocaleString()}</td>
                    <td className="py-1 text-right text-sky-600">{rate(r.play, r.visits)}</td>
                    <td className="py-1 text-right">{r.signup.toLocaleString()}</td>
                    <td className="py-1 text-right text-sky-600">{rate(r.signup, r.visits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 바이럴 루프 */}
      <div className="rounded-xl border border-foreground/10 ui-surface p-3">
        <p className="mb-2 text-[11px] font-semibold text-zinc-400">바이럴 루프 <span className="font-normal">— 윈도우 집계 근사(causal 아님)</span></p>
        <div className="flex items-center justify-center gap-3 text-sm">
          <div className="text-center">
            <p className="text-[10px] text-zinc-500">공유 시도</p>
            <p className="text-xl font-extrabold tabular-nums">{viralLoop.shares.toLocaleString()}</p>
          </div>
          <span className="text-lg text-zinc-400">→</span>
          <div className="text-center">
            <p className="text-[10px] text-zinc-500">바이럴 유입(신규)</p>
            <p className="text-xl font-extrabold tabular-nums text-sky-600">{viralLoop.viralInbound.toLocaleString()}</p>
          </div>
        </div>
        {viralLoop.byType.length > 0 && (
          <p className="mt-2 text-center text-[11px] text-zinc-400">
            {viralLoop.byType.map((t) => `${VIRAL_KO[t.key] ?? t.key} ${t.value}`).join(" · ")}
          </p>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-400">
        전환율은 세션·점수제출·계정 단위가 섞인 <b>무식별 근사</b>이며, 바이럴 유입은 first-touch 가 공유링크인 <b>신규</b> 기준입니다.
        일 1회 집계라 당일 수치는 최대 ~1일 지연될 수 있어요.
      </p>
    </div>
  );
}
