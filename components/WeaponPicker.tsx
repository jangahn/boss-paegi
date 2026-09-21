"use client";

import { Weapon, WeaponKey } from "@/lib/weapons";

type Props = {
  /** 이 맵의 로스터 9칸(lib/weapons weaponsForMap) — 공통 7종 + 현재 맵 투척 2종 */
  weapons: readonly Weapon[];
  active: WeaponKey;
  onChange: (w: Weapon) => void;
  /** 캐릭터에 낙서가 있는지 — 있으면 펜 슬롯이 지우개(🧽)로 변함 */
  hasDrawing?: boolean;
  /** 지우개 터치 시 낙서 전체 삭제 (점수 무관, 무기 모드 유지) */
  onClearDrawing?: () => void;
  /** 마우스를 올린 무기 — 안내 캡슐이 그 무기의 키보드 조작법을 보여준다(PC 전용: 터치·포커스에는 반응하지 않는다). null = 벗어남 */
  onHover?: (w: Weapon | null) => void;
};

/** 펜 칸이 지금 지우개인지 — 클릭과 숫자키(9)가 같은 규칙을 쓴다. */
export function isEraserSlot(w: Weapon, hasDrawing: boolean): boolean {
  return w.key === "pen" && hasDrawing;
}

/**
 * 무기 9칸 한 줄(공통 7 + 현재 맵 투척 2, v1.35) — 카테고리 전환 지점에 얇은 구분선.
 * 펜 슬롯: 낙서가 있으면 🧽 지우개로 변하고, 터치하면 낙서만 삭제
 * (모드는 그대로). 지워지면 다시 🖊️ 로 복귀.
 * PC(마우스 환경, `pointer-fine`)에서는 칸마다 숫자키 배지(1~9)가 붙는다 — 칸 순서가 전 맵 고정이라 번호도 고정(v1.50).
 */
export function WeaponPicker({
  weapons,
  active,
  onChange,
  hasDrawing = false,
  onClearDrawing,
  onHover,
}: Props) {
  return (
    <div
      role="toolbar"
      aria-label="무기 선택"
      className="pointer-events-auto absolute bottom-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/55 p-1 backdrop-blur-sm sm:bottom-14 sm:gap-1.5 sm:p-2"
    >
      {weapons.map((w, i) => {
        const prev = weapons[i - 1];
        const newGroup = prev && prev.group !== w.group;
        const isEraser = isEraserSlot(w, hasDrawing);
        return (
          <div key={w.key} className="flex items-center">
            {newGroup && (
              <span className="mx-0.5 h-6 w-px bg-white/20 sm:mx-1 sm:h-8" />
            )}
            <button
              type="button"
              onClick={() => {
                if (isEraser) {
                  onClearDrawing?.();
                } else {
                  onChange(w);
                }
              }}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") onHover?.(w);
              }}
              onPointerLeave={() => onHover?.(null)}
              aria-label={isEraser ? "낙서 지우기" : w.label}
              aria-pressed={w.key === active}
              aria-keyshortcuts={String(i + 1)}
              className={`relative flex h-8 w-8 items-center justify-center rounded-full text-base shadow transition sm:h-11 sm:w-11 sm:text-2xl ${
                w.key === active
                  ? "scale-110 bg-white text-black"
                  : "bg-black/40 text-white hover:bg-black/60"
              }`}
            >
              {isEraser ? "🧽" : w.emoji}
              <span
                aria-hidden
                className="pointer-events-none absolute -left-1 -top-1 hidden h-4 min-w-4 items-center justify-center rounded bg-black/80 px-0.5 text-[10px] font-bold leading-none text-white ring-1 ring-white/40 pointer-fine:flex"
              >
                {i + 1}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
