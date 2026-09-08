/** 「캐릭터」 탭 전환 스켈레톤 — 제목·탭(그룹 레이아웃)은 유지, 설명·필터·목록 자리만 fallback. */
export default function Loading() {
  return (
    <>
      <div className="h-8 w-full max-w-md animate-pulse rounded bg-foreground/10" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 w-28 animate-pulse rounded-lg border border-foreground/10 ui-surface" />
        ))}
      </div>
      <div className="h-4 w-24 animate-pulse rounded bg-foreground/10" />
      <ul className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="h-24 animate-pulse rounded-2xl border border-foreground/10 ui-surface" />
        ))}
      </ul>
    </>
  );
}
