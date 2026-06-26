/** 유저 상세(가장 무거운 RSC — 5개 쿼리) 전환 즉시 스켈레톤. 4섹션 레이아웃 근사. */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col px-5 py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <div className="flex flex-col gap-2">
          <div className="h-7 w-44 animate-pulse rounded bg-foreground/10" />
          <div className="h-3 w-64 animate-pulse rounded bg-foreground/10" />
        </div>
        <div className="h-24 animate-pulse rounded-xl bg-foreground/10" />
        {Array.from({ length: 3 }).map((_, s) => (
          <div key={s} className="flex flex-col gap-2">
            <div className="h-4 w-32 animate-pulse rounded bg-foreground/10" />
            <div className="overflow-hidden rounded-xl border border-foreground/10 bg-paper-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse border-t border-foreground/5 bg-foreground/5" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
