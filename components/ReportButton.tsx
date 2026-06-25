"use client";

import { useState } from "react";
import { ReportDialog } from "@/components/ReportDialog";

/**
 * 공개 표면에 끼우는 신고 트리거(client island). 서버 페이지는 doll 이 있을 때만 렌더.
 */
export function ReportButton({
  dollId,
  className,
}: {
  dollId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "text-xs text-zinc-400 underline underline-offset-2 transition hover:text-zinc-300"
        }
      >
        🚩 신고
      </button>
      {open && <ReportDialog dollId={dollId} onClose={() => setOpen(false)} />}
    </>
  );
}
