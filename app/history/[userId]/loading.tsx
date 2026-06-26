import { AppNav } from "@/components/AppNav";

/** /history 목록 진입 즉시 스켈레톤 (서버 fetch 대기 중 blank 방지). */
export default function Loading() {
  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-foreground/10" />
            <div className="flex flex-col gap-1.5">
              <div className="h-6 w-40 animate-pulse rounded bg-foreground/10" />
              <div className="h-3 w-20 animate-pulse rounded bg-foreground/10" />
            </div>
          </div>
          <ol className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center gap-4 rounded-2xl border border-foreground/10 bg-paper-2 p-3"
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-4 w-28 animate-pulse rounded bg-foreground/10" />
                  <div className="h-2.5 w-40 animate-pulse rounded bg-foreground/10" />
                </div>
                <div className="h-6 w-16 animate-pulse rounded bg-foreground/10" />
              </li>
            ))}
          </ol>
        </div>
      </main>
    </>
  );
}
