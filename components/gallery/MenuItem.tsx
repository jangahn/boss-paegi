"use client";

// 갤러리 카드 ⋯ 드롭다운의 개별 항목 — DollCard(실 캐릭터)·DefaultBossCard(기본부장님) 공용.
export function MenuItem({
  onClick,
  danger = false,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`block w-full cursor-pointer touch-manipulation px-4 py-3 text-left text-sm transition hover:bg-foreground/5 ${
        danger ? "text-red-400" : ""
      }`}
    >
      {children}
    </button>
  );
}
