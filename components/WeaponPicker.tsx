"use client";

import { WEAPONS, Weapon, WeaponKey } from "@/lib/weapons";

type Props = {
  active: WeaponKey;
  onChange: (w: Weapon) => void;
};

export function WeaponPicker({ active, onChange }: Props) {
  return (
    <div className="pointer-events-auto absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2">
      {WEAPONS.map((w) => (
        <button
          key={w.key}
          onClick={() => onChange(w)}
          aria-label={w.label}
          className={`flex h-12 w-12 items-center justify-center rounded-full text-2xl shadow-lg transition ${
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
