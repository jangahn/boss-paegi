/** 어드민 라우트 전환 즉시 스켈레톤 — layout(AppNav/AdminNav)은 유지, 본문만 fallback. */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="h-7 w-40 animate-pulse rounded bg-foreground/10" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-foreground/10 ui-surface" />
          ))}
        </div>
        <div className="mt-2 overflow-hidden rounded-xl border border-foreground/10">
          <div className="h-9 animate-pulse ui-surface" />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse border-t border-foreground/5 bg-foreground/[0.05]" />
          ))}
        </div>
      </div>
    </main>
  );
}
