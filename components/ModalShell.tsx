"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useDialogFocus } from "@/lib/use-dialog-focus";
import { useExitClone } from "@/components/motion/useExitClone";

/**
 * 모달 셸 — **document.body 로 포털**.
 * AppNav 가 backdrop-blur(=containing block) 라 그 안에서 `fixed` 를 쓰면 뷰포트가 아니라
 * nav 기준으로 잡혀 모달이 상단에 잘려 보임. 포털로 body 직속에 렌더해 회피.
 * scroll-center: 짧으면 가운데, 길면(크롭 모달) 위→아래 스크롤(상단 안 잘림).
 * v1.65 등장 · 퇴장: 덮개는 단색이라 opacity, 시트는 아래에서 올라오는 이동만(글자 opacity 없음 — iOS 잔상). 닫히면 복제본이
 * 제자리에서 덮개는 옅어지고 시트는 아래로 빠르게 내려간다(useExitClone — 부르는 쪽 수정 없음). 어드민은 연출 없음(절제).
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
  const rootRef = useRef<HTMLDivElement>(null);
  useExitClone(
    rootRef,
    (clone) => [
      clone.querySelector("[data-modal-scrim]")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }) ?? null,
      clone
        .querySelector("[data-modal-sheet]")
        ?.animate([{ translate: "0 0" }, { translate: "0 100vh" }], { duration: 180, easing: "ease-in", fill: "forwards" }) ?? null,
    ].filter((a): a is Animation => !!a),
    !pathname?.startsWith("/admin"),
  );
  if (!mounted) return null;

  // body 로 포털하면 어드민 .theme-admin 래퍼 밖이라 라이트로 새므로, 어드민 경로에선 다크 테마를 직접 부착.
  const isAdmin = pathname?.startsWith("/admin") ?? false;
  const themed = isAdmin ? "theme-admin text-foreground" : "";

  // iOS WebKit 은 backdrop-filter 요소의 **자손** 내용이 바뀔 때(예: 버튼 busy 스피너 삽입으로
  // 텍스트가 밀림) 이전 래스터를 남겨 글자가 겹쳐 보이는 재도색 버그가 있어, 블러 백드롭을
  // 다이얼로그와 분리된 형제 레이어로 둔다(시각 결과 동일 — 블러는 원래 뒤 페이지에만 적용).
  return createPortal(
    <div
      ref={rootRef}
      className={`${themed} fixed inset-0 z-[100]`}
      onClick={onClose}
    >
      <div
        aria-hidden
        data-modal-scrim
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${isAdmin ? "" : "motion-scrim"}`}
      />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            data-modal-sheet
            className={`w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-3xl ui-surface p-6 shadow-2xl ${isAdmin ? "" : "motion-sheet"}`}
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
