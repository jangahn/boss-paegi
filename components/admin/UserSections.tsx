import type { GenerationRow, DollRow } from "@/lib/admin-types";
import { fmtKst, shortId } from "@/lib/admin-format";

const GEN_STATUS: Record<string, string> = {
  queued: "진행중",
  done: "완료(미선택)",
  picked: "채택됨",
  failed: "실패",
};
const GEN_COLOR: Record<string, string> = {
  queued: "text-amber-600",
  done: "text-sky-600",
  picked: "text-emerald-600",
  failed: "text-red-500",
};
const ROLE_LABEL: Record<string, string> = {
  boss: "부장",
  exec: "임원",
  teamlead: "팀장",
  client: "거래처",
  coworker: "동료",
};

/** AI 생성 내역(상태 포함) — candidate_urls 배열은 미반환, 후보 수만. */
export function GenerationsTable({ rows }: { rows: GenerationRow[] }) {
  if (!rows.length) return <p className="text-sm text-zinc-400">생성 내역이 없어요.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-foreground/10">
      <table className="w-full text-left text-xs">
        <thead className="bg-foreground/5 text-zinc-500">
          <tr>
            <th className="px-2 py-1.5">시각(KST)</th>
            <th className="px-2 py-1.5">상태</th>
            <th className="px-2 py-1.5">롤</th>
            <th className="px-2 py-1.5 text-right">후보</th>
            <th className="px-2 py-1.5">채택 캐릭터</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.id} className="border-t border-foreground/5">
              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{fmtKst(g.created_at)}</td>
              <td className={`px-2 py-1.5 font-semibold ${GEN_COLOR[g.status] ?? ""}`}>
                {GEN_STATUS[g.status] ?? g.status}
              </td>
              <td className="px-2 py-1.5">{ROLE_LABEL[g.role] ?? g.role}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{g.candidate_count}</td>
              <td className="px-2 py-1.5 font-mono text-zinc-400">
                {g.picked_doll_id ? shortId(g.picked_doll_id) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 현재 보유 캐릭터(dolls) — 썸네일 그리드. (하드삭제라 삭제분은 미추적.) */
export function DollsList({ rows }: { rows: DollRow[] }) {
  if (!rows.length) return <p className="text-sm text-zinc-400">캐릭터가 없어요.</p>;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {rows.map((d) => (
        <li key={d.id} className="rounded-xl border border-foreground/10 p-2 text-center text-[11px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={d.image_url}
            alt=""
            className="mx-auto mb-1 h-20 w-20 rounded-lg bg-foreground/10 object-cover"
          />
          <div className="font-medium">{ROLE_LABEL[d.role] ?? d.role}</div>
          <div className="text-zinc-400">{fmtKst(d.created_at)}</div>
        </li>
      ))}
    </ul>
  );
}
