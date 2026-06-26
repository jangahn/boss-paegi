"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 모달 셸 — **document.body 로 포털**.
 * AppNav 가 backdrop-blur(=containing block) 라 그 안에서 `fixed` 를 쓰면 뷰포트가 아니라
 * nav 기준으로 잡혀 모달이 상단에 잘려 보임. 포털로 body 직속에 렌더해 회피.
 * scroll-center: 짧으면 가운데, 길면(크롭 모달) 위→아래 스크롤(상단 안 잘림).
 */
export function ModalShell({
  children,
  onClose,
  wide = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          className={`w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-xl border border-line bg-paper-2 p-5 shadow-[3px_4px_0_rgba(17,35,58,0.07)] sm:p-6`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
