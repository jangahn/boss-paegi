"use client";

import { WEAPONS, Weapon, WeaponKey } from "@/lib/weapons";

type Props = {
  active: WeaponKey;
  onChange: (w: Weapon) => void;
  /** 인형에 낙서가 있는지 — 있으면 펜 슬롯이 지우개(🧽)로 변함 */
  hasDrawing?: boolean;
  /** 지우개 터치 시 낙서 전체 삭제 (점수 무관, 무기 모드 유지) */
  onClearDrawing?: () => void;
};

/**
 * 무기 9종 한 줄 — 카테고리 전환 지점에 얇은 구분선.
 * 펜 슬롯: 낙서가 있으면 🧽 지우개로 변하고, 터치하면 낙서만 삭제
 * (모드는 그대로). 지워지면 다시 🖊️ 로 복귀.
 */
export function WeaponPicker({
  active,
  onChange,
  hasDrawing = false,
  onClearDrawing,
}: Props) {
  return (
    <div className="pointer-events-auto absolute bottom-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/55 p-1 backdrop-blur-sm sm:bottom-14 sm:gap-1.5 sm:p-2">
      {WEAPONS.map((w, i) => {
        const prev = WEAPONS[i - 1];
        const newGroup = prev && prev.category !== w.category;
        const isEraser = w.key === "pen" && hasDrawing;
        return (
          <div key={w.key} className="flex items-center">
            {newGroup && (
              <span className="mx-0.5 h-6 w-px bg-white/20 sm:mx-1 sm:h-8" />
            )}
            <button
              onClick={() => {
                if (isEraser) {
                  onClearDrawing?.();
                } else {
                  onChange(w);
                }
              }}
              aria-label={isEraser ? "낙서 지우기" : w.label}
              className={`flex h-8 w-8 items-center justify-center rounded-full text-base shadow transition sm:h-11 sm:w-11 sm:text-2xl ${
                w.key === active
                  ? "scale-110 bg-white text-black"
                  : "bg-black/40 text-white hover:bg-black/60"
              }`}
            >
              {isEraser ? "🧽" : w.emoji}
            </button>
          </div>
        );
      })}
    </div>
  );
}
