import type { DevicePerf } from "@/lib/admin-analytics";

const DEVICE_KO: Record<string, string> = {
  "mobile-touch": "모바일(터치)",
  "desktop-pointer": "데스크탑(마우스)",
  "mobile-pointer": "모바일(포인터)",
  other: "기타",
};

const LAG_P95_MS = 33; // ≈ 30fps 미달 스파이크

const fps = (ms: number) => (ms > 0 ? Math.round(1000 / ms) : 0);

export function DevicePerfPanel({ data }: { data: DevicePerf }) {
  if (data.perfSessions === 0) {
    return (
      <p className="text-sm text-zinc-400">
        perf 데이터가 있는 세션이 없어요(프레임 표본 미수집).
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        프레임 표본 있는 {data.perfSessions}세션 기준. p95 &gt; {LAG_P95_MS}ms(≈30fps 미달 스파이크)를
        “렉”으로 집계. 프레임타임 낮을수록 좋음(16.7ms=60fps · 33.3ms=30fps).
      </p>

      {/* 디바이스별 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-zinc-400">
              <th className="py-1 pr-2">디바이스</th>
              <th className="px-2">세션</th>
              <th className="px-2">중앙 avg</th>
              <th className="px-2">중앙 p95</th>
              <th className="px-2">추정 fps</th>
              <th className="px-2">렉 세션</th>
            </tr>
          </thead>
          <tbody>
            {data.byDevice.map((d) => (
              <tr key={d.deviceClass} className="border-t border-foreground/10">
                <td className="py-1 pr-2">{DEVICE_KO[d.deviceClass] ?? d.deviceClass}</td>
                <td className="px-2 text-zinc-500">{d.sessions}</td>
                <td className="px-2">{d.medAvgMs}ms</td>
                <td className={`px-2 ${d.medP95Ms > LAG_P95_MS ? "font-semibold text-red-500" : ""}`}>
                  {d.medP95Ms}ms
                </td>
                <td className={`px-2 ${d.estFps < 50 ? "font-semibold text-amber-600" : ""}`}>
                  ~{d.estFps}fps
                </td>
                <td className="px-2">{Math.round(d.lagRate * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 가장 느린 세션 드릴다운 */}
      <div>
        <p className="mb-1 text-[11px] font-semibold text-zinc-500">
          가장 느린 세션 (p95 내림차순)
        </p>
        <ul className="space-y-1">
          {data.worst.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-foreground/10 bg-foreground/5 px-2 py-1 text-[11px]"
            >
              <span className="font-mono text-zinc-400">{s.id.slice(0, 8)}</span>
              <span>{DEVICE_KO[s.deviceClass] ?? s.deviceClass}</span>
              <span className="font-semibold text-red-500">
                p95 {s.p95Ms}ms (~{fps(s.p95Ms)}fps)
              </span>
              <span className="text-zinc-500">avg {s.avgMs}ms</span>
              <span className="text-zinc-400">
                dpr {s.dpr} · {s.refreshHz}hz · {s.durationMs ? `${Math.round(s.durationMs / 1000)}s` : "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
