import { AppNav } from "@/components/AppNav";

/** /history 상세 진입 즉시 스켈레톤 (서버 fetch 대기 중 blank 방지). */
export default function Loading() {
  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col items-center px-4 py-8">
        <div className="w-full max-w-sm">
          <div className="mb-3 h-4 w-24 animate-pulse rounded bg-foreground/10" />
          <div className="rounded-lg bg-paper-2 p-5 shadow-2xl">
            <div className="mx-auto h-5 w-44 animate-pulse rounded bg-zinc-300" />
            <div className="mt-4 flex gap-3">
              <div className="aspect-square w-24 animate-pulse rounded-xl bg-zinc-200" />
              <div className="flex-1 space-y-2 pt-2">
                <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200" />
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-3.5 w-full animate-pulse rounded bg-zinc-200" />
              ))}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
