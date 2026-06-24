import {
  badgeBySlug,
  summarizeBadges,
  familyEmoji,
  activeBadges,
  type BadgeCatalog,
} from "@/lib/config/domains/badges";

/**
 * 획득 뱃지 칩 스트립 — 종료화면(이번 판 + NEW + 수집카운트)·공유페이지(이번 판 스냅샷) 공용.
 * ladder 동반획득으로 id 가 많아 **패밀리별 최고 티어만 압축**(summarizeBadges, ≤7칩).
 * 카탈로그는 부모가 주입(서버=getBadgeCatalog, 클라=useBadgeCatalog). emoji 는 패밀리에서.
 */
export function BadgeStrip({
  badgeIds,
  catalog,
  newIds,
  collected,
  total,
  heading = "획득 뱃지",
}: {
  badgeIds: string[];
  catalog: BadgeCatalog;
  newIds?: string[];
  collected?: number | null;
  total?: number;
  heading?: string;
}) {
  if (!badgeIds.length) return null;
  const shown = summarizeBadges(catalog, badgeIds); // 패밀리별 최고 티어 slug
  const totalCount = total ?? activeBadges(catalog).length;
  const newFamilies = new Set(
    (newIds ?? []).map((id) => badgeBySlug(catalog, id)?.familyKey).filter(Boolean)
  );
  return (
    <div className="mt-3 rounded-md border border-zinc-300 bg-zinc-50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-zinc-500">{heading}</p>
        {collected != null && collected > 0 && (
          <p className="text-[10px] text-zinc-400">
            수집 {collected}/{totalCount}
          </p>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {shown.map((slug) => {
          const b = badgeBySlug(catalog, slug);
          if (!b) return null;
          const isNew = newFamilies.has(b.familyKey);
          return (
            <span
              key={slug}
              title={b.desc}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                isNew ? "bg-amber-400 text-zinc-900" : "bg-zinc-200 text-zinc-700"
              }`}
            >
              {familyEmoji(catalog, b.familyKey)} {b.label}
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
