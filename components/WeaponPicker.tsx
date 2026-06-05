"use client";

import { WEAPONS, Weapon, WeaponKey } from "@/lib/weapons";

type Props = {
  active: WeaponKey;
  onChange: (w: Weapon) => void;
};

export function WeaponPicker({ active, onChange }: Props) {
  return (
    <div className="pointer-events-auto absolute right-2 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5 sm:right-3 sm:gap-2">
      {WEAPONS.map((w) => (
        <button
          key={w.key}
          onClick={() => onChange(w)}
          aria-label={w.label}
          className={`flex h-10 w-10 items-center justify-center rounded-full text-xl shadow-lg transition sm:h-12 sm:w-12 sm:text-2xl ${
            w.key === active
              ? "scale-110 bg-white text-black"
              : "bg-black/55 text-white hover:bg-black/70"
          }`}
        >
          {w.emoji}
        </button>
      ))}
    </div>
  );
}
