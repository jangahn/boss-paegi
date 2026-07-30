"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

const ERROR_TITLE = "페이지 오류 · 부장님 패기";

/**
 * Route-level fallback. Page/data failures stay inside the healthy root
 * layout, while the document always retains an accessible name and heading.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    document.title = ERROR_TITLE;
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <title>{ERROR_TITLE}</title>
      <div aria-hidden className="text-5xl">
        😵
      </div>
      <h1 className="text-xl font-bold">페이지를 불러오지 못했어요</h1>
      <p role="alert" className="text-sm text-zinc-500">
        잠시 후 다시 시도해 주세요.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-2 rounded-full bg-foreground px-5 py-2.5 font-semibold text-paper-2"
      >
        다시 시도
      </button>
    </main>
  );
}
