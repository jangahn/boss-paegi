import { badgeById, BADGE_TOTAL } from "@/lib/badges";

/**
 * 획득 뱃지 칩 스트립 — 종료화면(이번 판 + NEW + 수집카운트)·공유페이지(이번 판 스냅샷) 공용.
 * 이번 판 badgeIds 는 클라/서버 결정적 동일. newIds·collected 는 서버 응답(종료화면만).
 */
export function BadgeStrip({
  badgeIds,
  newIds,
  collected,
  total = BADGE_TOTAL,
  heading = "획득 뱃지",
}: {
  badgeIds: string[];
  newIds?: string[];
  collected?: number | null;
  total?: number;
  heading?: string;
}) {
  if (!badgeIds.length) return null;
  const newSet = new Set(newIds ?? []);
  return (
    <div className="mt-3 rounded-md border border-zinc-300 bg-zinc-50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-zinc-500">{heading}</p>
        {collected != null && collected > 0 && (
          <p className="text-[10px] text-zinc-400">
            수집 {collected}/{total}
          </p>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {badgeIds.map((id) => {
          const b = badgeById(id);
          if (!b) return null;
          const isNew = newSet.has(id);
          return (
            <span
              key={id}
              title={b.desc}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                isNew ? "bg-amber-400 text-zinc-900" : "bg-zinc-200 text-zinc-700"
              }`}
            >
              {b.emoji} {b.label}
              {isNew && (
                <span className="rounded bg-zinc-900 px-1 text-[8px] font-bold text-amber-300">
                  NEW
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
