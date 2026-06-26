"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

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
  const pathname = usePathname();
  if (!mounted) return null;

  // body 로 포털하면 어드민 .theme-admin 래퍼 밖이라 라이트로 새므로, 어드민 경로에선 다크 테마를 직접 부착.
  const themed = pathname?.startsWith("/admin") ? "theme-admin text-foreground" : "";

  return createPortal(
    <div
      className={`${themed} fixed inset-0 z-[100] overflow-y-auto bg-black/60 backdrop-blur-sm`}
      onClick={onClose}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          className={`w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-3xl bg-paper-2 p-6 shadow-2xl`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
