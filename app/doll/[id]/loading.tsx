/** /doll/[id] 진입 즉시 스켈레톤 (서버 컴포넌트 fetchDoll 대기 중 blank 방지). */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-lg bg-paper-2 p-5 shadow-2xl">
        <div className="mx-auto h-5 w-32 animate-pulse rounded bg-zinc-300" />
        <div className="mt-4 flex gap-3">
          <div className="aspect-[3/4] w-28 animate-pulse rounded-xl bg-zinc-100" />
          <div className="flex-1 space-y-2 pt-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
