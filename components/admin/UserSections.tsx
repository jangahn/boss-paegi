import Link from "next/link";
import type { GenerationRow, DollRow } from "@/lib/admin-types";
import { fmtKst, shortId } from "@/lib/admin-format";
import { asRole } from "@/lib/roles";
import { roleFrom, type RoleConfig } from "@/lib/config/domains/roles";

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
// 역할 호칭은 DB 발행 config(roleFrom). cfg 는 서버 부모(getRoleConfig)에서 prop 으로. ROLE_META 는 roleFrom 내부 fallback.

/** AI 생성 내역(상태 포함) — candidate_urls 배열은 미반환, 후보 수만. */
export function GenerationsTable({ rows, cfg }: { rows: GenerationRow[]; cfg: RoleConfig }) {
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
              <td className="px-2 py-1.5">{roleFrom(asRole(g.role), cfg).label}</td>
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

/**
 * 보유 캐릭터(dolls) — 썸네일 그리드. 미삭제는 클릭→/doll(새 탭), takedown 삭제분은
 * "삭제됨" 칩 + 클릭→신고 어드민(해당 doll 필터). (탈퇴=하드삭제는 목록서 사라짐.)
 */
export function DollsList({ rows, cfg }: { rows: DollRow[]; cfg: RoleConfig }) {
  if (!rows.length) return <p className="text-sm text-zinc-400">캐릭터가 없어요.</p>;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {rows.map((d) => {
        const deleted = !!d.deleted_at;
        const href = deleted ? `/admin/moderation?dollId=${d.id}` : `/doll/${d.id}`;
        return (
          <li key={d.id}>
            <Link
              href={href}
              {...(deleted ? {} : { target: "_blank", rel: "noreferrer" })}
              className="relative block rounded-xl border border-foreground/10 p-2 text-center text-[11px] transition hover:bg-foreground/5"
              title={deleted ? "신고 삭제됨 — 신고 어드민에서 보기" : "doll 페이지 열기"}
            >
              {deleted && (
                <span className="absolute left-1.5 top-1.5 z-10 rounded-full bg-red-500/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
                  삭제됨
                </span>
              )}
              {deleted ? (
                <div className="mx-auto mb-1 flex h-20 w-20 items-center justify-center rounded-lg bg-foreground/10 text-2xl opacity-60">
                  🗑️
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={d.image_url}
                  alt=""
                  className="mx-auto mb-1 h-20 w-20 rounded-lg bg-foreground/10 object-cover"
                />
              )}
              <div className="font-medium">{roleFrom(asRole(d.role), cfg).label}</div>
              <div className="text-zinc-400">{fmtKst(d.created_at)}</div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
