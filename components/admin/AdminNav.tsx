"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";

/**
 * 어드민 서브 네비 — 멀티 라우트(/admin · /admin/orders · …) 이동.
 * 라우트가 추가되는 PR 마다 LINKS 에 항목을 더한다(없는 라우트로의 깨진 링크 방지).
 */
const LINKS = [
  { href: "/admin", label: "대시보드" },
  { href: "/admin/orders", label: "주문" },
  { href: "/admin/refunds", label: "환불" },
  { href: "/admin/users", label: "회원" },
  { href: "/admin/ledger", label: "처리내역" },
  { href: "/admin/moderation", label: "신고" },
  { href: "/admin/generations", label: "캐릭터 생성" },
  { href: "/admin/events", label: "이벤트/소식" },
  { href: "/admin/content", label: "콘텐츠" },
  { href: "/admin/analytics", label: "게임 분석" },
  { href: "/admin/acquisition", label: "공유·유입" },
  { href: "/admin/integrity", label: "무결성" },
  { href: "/admin/reviewers", label: "심사 계정" },
];

export function AdminNav() {
  const pathname = usePathname();
  const scrollRef = useRef<HTMLDivElement>(null);
  // 마우스로 잡아끌어 가로 스크롤(모바일 터치는 native overflow 스크롤). moved 로 드래그 후 오네비 방지.
  const drag = useRef({ active: false, startX: 0, startScroll: 0, moved: false });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return; // 터치=native, 좌클릭만
    const el = scrollRef.current;
    if (!el) return;
    drag.current = { active: true, startX: e.clientX, startScroll: el.scrollLeft, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!drag.current.active || !el) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 4) {
      drag.current.moved = true;
      el.setPointerCapture?.(e.pointerId);
    }
    el.scrollLeft = drag.current.startScroll - dx;
  };
  const endDrag = () => {
    drag.current.active = false;
  };

  return (
    <nav className="border-b border-foreground/10 bg-background/60">
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="mx-auto flex w-full max-w-3xl cursor-grab gap-1 overflow-x-auto px-5 py-2 select-none active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {LINKS.map((l) => {
          const active =
            l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              draggable={false}
              // 드래그로 스크롤한 직후의 클릭은 네비게이션 취소(오이동 방지).
              onClick={(e) => {
                if (drag.current.moved) e.preventDefault();
              }}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-foreground text-paper-2"
                  : "text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
