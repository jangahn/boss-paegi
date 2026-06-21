import { badgeById, summarizeBadges, BADGE_TOTAL } from "@/lib/badges";

/**
 * 획득 뱃지 칩 스트립 — 종료화면(이번 판 + NEW + 수집카운트)·공유페이지(이번 판 스냅샷) 공용.
 * ladder 동반획득으로 id 가 많아 **패밀리별 최고 티어만 압축**(summarizeBadges, ≤7칩).
 * 한 패밀리에 신규획득(newIds)이 있으면 그 칩에 NEW. collected/total 은 known id 기준.
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
  const shown = summarizeBadges(badgeIds); // 패밀리별 최고 티어
  const newFamilies = new Set(
    (newIds ?? []).map((id) => badgeById(id)?.familyKey).filter(Boolean)
  );
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
        {shown.map((id) => {
          const b = badgeById(id);
          if (!b) return null;
          const isNew = newFamilies.has(b.familyKey);
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
