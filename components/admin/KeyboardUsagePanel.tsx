import type { KeyboardUsage } from "@/lib/admin-analytics";
import { DEVICE_KO } from "@/components/admin/DevicePerfPanel";
import { MiniStat, pct01 } from "@/components/admin/analytics/AnalyticsViews";

const ratio = (part: number, whole: number) => (whole > 0 ? pct01(part / whole) : "—");

/**
 * 키보드 사용(v1.50) — PC 키보드 조작(스페이스·방향키 공격)이 실제로 얼마나 쓰이는지. 단일 소스 = 롤업 차원 `sess_keyboard`(mig 0131).
 * 분모는 타격이 있었던 세션. 키보드는 마우스 환경에서만 의미가 있어 PC 세션 기준 비율을 앞에 둔다.
 */
export function KeyboardUsagePanel({ data }: { data: KeyboardUsage }) {
  if (data.sessions === 0) {
    return <p className="text-sm text-zinc-400">키보드 사용 집계가 아직 없어요(v1.50 배포 이후 세션부터 집계).</p>;
  }
  const actions = data.byDevice.reduce((n, d) => n + d.keyActions, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {/* 라벨은 SE 375 칸(88px)에 한 줄 — 「PC 세션 중 키보드 사용」은 「사 / 용」으로 꺾였다(v1.53). */}
        <MiniStat label="PC 키보드 사용률" value={ratio(data.desktopKeyboardSessions, data.desktopSessions)} />
        <MiniStat label="전체 키보드 사용률" value={ratio(data.keyboardSessions, data.sessions)} />
        <MiniStat
          label="세션당 키보드 동작"
          value={data.keyboardSessions > 0 ? Math.round(actions / data.keyboardSessions).toLocaleString() : "—"}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-sm">
          <thead>
            <tr className="text-left text-[11px] text-zinc-400">
              <th className="py-1 pr-2">기기</th>
              <th className="px-2">세션</th>
              <th className="px-2">키보드</th>
              <th className="px-2">비율</th>
              <th className="px-2">동작</th>
            </tr>
          </thead>
          <tbody>
            {data.byDevice.map((d) => (
              <tr key={d.deviceClass} className="border-t border-foreground/10">
                <td className="py-1 pr-2">{DEVICE_KO[d.deviceClass] ?? d.deviceClass}</td>
                <td className="px-2 text-zinc-500">{d.sessions.toLocaleString()}</td>
                <td className="px-2">{d.keyboardSessions.toLocaleString()}</td>
                <td className="px-2">{ratio(d.keyboardSessions, d.sessions)}</td>
                <td className="px-2 text-zinc-500">{d.keyActions.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-500">
        타격이 있었던 세션 기준. 키보드 사용 = 스페이스·방향키 공격 동작이 1회 이상인 세션(숫자·Q~Y 선택 키는 제외). v1.50 배포 이후
        날짜만 집계돼요.
      </p>
    </div>
  );
}
