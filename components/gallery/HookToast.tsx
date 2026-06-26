"use client";

import { useEffect } from "react";
import Link from "next/link";
import type { CtaTarget } from "@/lib/gallery-cta";

// 기본부장님 ⋯(공유/롤 변경) 후킹 토스트 — 메시지 + 가입/생성 CTA + 닫기.
// 하단-중앙(우하단 Sentry 의견위젯 FAB 와 안 겹치게 bottom-20 로 띄움). ~5s 자동 소멸.
const AUTO_DISMISS_MS = 5000;

export function HookToast({
  message,
  cta,
  onClose,
}: {
  message: string;
  cta: CtaTarget;
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-foreground/10 bg-paper-2/95 p-3 shadow-2xl backdrop-blur">
        <p className="flex-1 text-sm leading-snug">{message}</p>
        <Link
          href={cta.href}
          className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition hover:opacity-90"
        >
          {cta.label}
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="shrink-0 px-1 text-lg leading-none text-zinc-400 transition hover:text-foreground"
        >
          ×
        </button>
      </div>
    </div>
  );
}
