export type WeaponKey =
  | "fist"
  | "slap"
  | "book"
  | "keyboard"
  | "paper"
  | "pen";

export type WeaponCategory = "tap" | "throw" | "draw";

export type Weapon = {
  key: WeaponKey;
  category: WeaponCategory;
  label: string;
  emoji: string;
  /** 한 타격당 점수 (1× 콤보 기준). 스토어가 콤보 배율 곱함. */
  strength: number;
  /** 피격 시 인형 흔들림 강도 (1.0 = 기본) */
  shake: number;
  /** 파티클 색 */
  color: number;
  /** 파티클 개수 */
  particleCount: number;
  /** Web Audio synth preset */
  sound: "thud" | "slap" | "clack" | "rustle" | "whoosh" | "scribble";
  /** 던지기 전용 — 발사체 질량 (matter.js body mass). */
  mass?: number;
  /** 던지기 전용 — sprite 한 변(px). */
  projectileSize?: number;
  /** 낙서 전용 — stroke 두께(px, doll 좌표계). */
  strokeWidth?: number;
};

export const WEAPONS: readonly Weapon[] = [
  // ── tap (3) ────────────────────────────────────────────────────────
  {
    key: "fist",
    category: "tap",
    label: "주먹",
    emoji: "👊",
    strength: 10,
    shake: 1.0,
    color: 0xffd166,
    particleCount: 10,
    sound: "thud",
  },
  {
    key: "slap",
    category: "tap",
    label: "싸대기",
    emoji: "✋",
    strength: 14,
    shake: 1.4,
    color: 0xef476f,
    particleCount: 14,
    sound: "slap",
  },
  {
    key: "book",
    category: "tap",
    label: "책",
    emoji: "📚",
    strength: 16,
    shake: 1.5,
    color: 0x8b5a2b,
    particleCount: 8,
    sound: "thud",
  },
  // ── throw (2) ──────────────────────────────────────────────────────
  {
    key: "keyboard",
    category: "throw",
    label: "키보드",
    emoji: "⌨️",
    strength: 22,
    shake: 1.8,
    color: 0xa0a0a0,
    particleCount: 12,
    sound: "clack",
    mass: 2.4,
    projectileSize: 56,
  },
  {
    key: "paper",
    category: "throw",
    label: "종이",
    emoji: "📄",
    strength: 8,
    shake: 0.6,
    color: 0xffffff,
    particleCount: 18,
    sound: "rustle",
    mass: 0.4,
    projectileSize: 42,
  },
  // ── draw (1) ───────────────────────────────────────────────────────
  {
    key: "pen",
    category: "draw",
    label: "펜",
    emoji: "🖊️",
    strength: 3,
    shake: 0.0,
    color: 0x1a1a1a,
    particleCount: 0,
    sound: "scribble",
    strokeWidth: 3,
  },
] as const;

export function resolveWeapon(key?: string | null): Weapon {
  return WEAPONS.find((w) => w.key === key) ?? WEAPONS[0];
}

export function weaponsByCategory(): Record<WeaponCategory, Weapon[]> {
  return WEAPONS.reduce(
    (acc, w) => {
      acc[w.category].push(w);
      return acc;
    },
    { tap: [], throw: [], draw: [] } as Record<WeaponCategory, Weapon[]>
  );
}
