/** /share 진입 즉시 스켈레톤 (서버 컴포넌트 fetchScore 대기 중 blank 방지). */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* 하이라이트 영상/배지 자리 */}
        <div className="mb-5 h-40 w-full animate-pulse rounded-2xl bg-foreground/10" />
        {/* 보고서 카드 자리 */}
        <div className="rounded-lg bg-[#fbfaf6] p-5 shadow-2xl">
          <div className="mx-auto h-5 w-44 animate-pulse rounded bg-zinc-300" />
          <div className="mt-4 flex gap-3">
            <div className="aspect-square w-24 animate-pulse rounded-xl bg-zinc-200" />
            <div className="flex-1 space-y-2 pt-2">
              <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-3.5 w-full animate-pulse rounded bg-zinc-200" />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
