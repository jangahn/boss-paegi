"use client";

import { WEAPONS, Weapon, WeaponKey } from "@/lib/weapons";

type Props = {
  active: WeaponKey;
  onChange: (w: Weapon) => void;
};

/**
 * 6개 무기 한 줄 — 탭(3) | 던지기(2) | 낙서(1) 그룹.
 * 인형 자체 던지기는 무기가 아니라 인형 위 드래그로 동작 — 슬롯 차지 X.
 */
export function WeaponPicker({ active, onChange }: Props) {
  return (
    <div className="pointer-events-auto absolute bottom-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/55 p-1.5 backdrop-blur-sm sm:bottom-14 sm:gap-1.5 sm:p-2">
      {WEAPONS.map((w, i) => {
        const prev = WEAPONS[i - 1];
        const newGroup = prev && prev.category !== w.category;
        return (
          <div key={w.key} className="flex items-center">
            {newGroup && (
              <span className="mx-0.5 h-7 w-px bg-white/20 sm:mx-1 sm:h-8" />
            )}
            <button
              onClick={() => onChange(w)}
              aria-label={w.label}
              className={`flex h-10 w-10 items-center justify-center rounded-full text-xl shadow transition sm:h-11 sm:w-11 sm:text-2xl ${
                w.key === active
                  ? "scale-110 bg-white text-black"
                  : "bg-black/40 text-white hover:bg-black/60"
              }`}
            >
              {w.emoji}
            </button>
          </div>
        );
      })}
    </div>
  );
}
