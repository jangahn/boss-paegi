export type WeaponKey = "fist" | "slap" | "keyboard" | "paper";

export type Weapon = {
  key: WeaponKey;
  label: string;
  emoji: string;
  /** 탭 한 번당 점수 (1× 콤보 기준). 스토어가 콤보 배율 곱함. */
  strength: number;
  /** 피격 시 인형 흔들림 강도 (1.0 = 기본) */
  shake: number;
  /** 파티클 색 */
  color: number;
  /** 파티클 개수 */
  particleCount: number;
  /** Web Audio synth preset */
  sound: "thud" | "slap" | "clack" | "rustle";
};

export const WEAPONS: readonly Weapon[] = [
  {
    key: "fist",
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
    label: "싸대기",
    emoji: "✋",
    strength: 14,
    shake: 1.4,
    color: 0xef476f,
    particleCount: 14,
    sound: "slap",
  },
  {
    key: "keyboard",
    label: "키보드",
    emoji: "⌨️",
    strength: 18,
    shake: 1.6,
    color: 0xa0a0a0,
    particleCount: 8,
    sound: "clack",
  },
  {
    key: "paper",
    label: "종이",
    emoji: "📄",
    strength: 5,
    shake: 0.5,
    color: 0xffffff,
    particleCount: 18,
    sound: "rustle",
  },
] as const;

export function resolveWeapon(key?: string | null): Weapon {
  return WEAPONS.find((w) => w.key === key) ?? WEAPONS[0];
}
