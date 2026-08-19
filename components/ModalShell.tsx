"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useDialogFocus } from "@/lib/use-dialog-focus";

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
  ariaLabel,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  ariaLabel: string;
}) {
  const [mounted, setMounted] = useState(false);
  // SSR/portal 마운트 게이트(hydration 불일치 방지) — 마운트 1회 setState(의도적·표준 패턴).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const pathname = usePathname();
  const dialogRef = useDialogFocus<HTMLDivElement>(mounted, onClose);
  if (!mounted) return null;

  // body 로 포털하면 어드민 .theme-admin 래퍼 밖이라 라이트로 새므로, 어드민 경로에선 다크 테마를 직접 부착.
  const themed = pathname?.startsWith("/admin") ? "theme-admin text-foreground" : "";

  // iOS WebKit 은 backdrop-filter 요소의 **자손** 내용이 바뀔 때(예: 버튼 busy 스피너 삽입으로
  // 텍스트가 밀림) 이전 래스터를 남겨 글자가 겹쳐 보이는 재도색 버그가 있어, 블러 백드롭을
  // 다이얼로그와 분리된 형제 레이어로 둔다(시각 결과 동일 — 블러는 원래 뒤 페이지에만 적용).
  return createPortal(
    <div
      className={`${themed} fixed inset-0 z-[100]`}
      onClick={onClose}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            className={`w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-3xl ui-surface p-6 shadow-2xl`}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
