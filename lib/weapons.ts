import { roleObj, type RoleId } from "@/lib/roles";
import { roleFrom, type RoleConfig } from "@/lib/config/domains/roles";
import type { WeaponKey } from "@/lib/weapon-keys";

export type { WeaponKey } from "@/lib/weapon-keys";

/**
 * tap   — 캐릭터 탭 한 번 = 타격 1회 (주먹/뿅망치)
 * swipe — 드래그 중 손바닥이 따라다니고, 캐릭터 위를 빠르게 문지르면 속도 비례 타격 (싸대기)
 * throw — 무기를 잡고 휘둘러 놓으면 드래그 방향·속도로 날아가 캐릭터에 충돌 (책/키보드/종이)
 * shoot — 빈 곳을 꾹 누르고 있으면 캐릭터를 자동 조준해 연사 (비비탄총)
 * grab  — 캐릭터 자체를 잡고 드래그해 내던지기 (이 모드에서만 캐릭터 fling 가능)
 * pinch — 캐릭터를 꾹 잡고 끌어 늘렸다 놓기 (늘린 거리 비례 데미지)
 * draw  — 캐릭터 실루엣 안에 낙서 (펜)
 */
export type WeaponCategory =
  | "tap"
  | "swipe"
  | "throw"
  | "shoot"
  | "grab"
  | "pinch"
  | "draw";

/** 피커 묶음(구분선 기준) — 카테고리와 별개의 UX 그룹. tap | hands(캐릭터 직접 조작) | projectile(날아가는 것) | draw */
export type WeaponGroup = "tap" | "hands" | "projectile" | "draw";

export type Weapon = {
  key: WeaponKey;
  category: WeaponCategory;
  group: WeaponGroup;
  label: string;
  emoji: string;
  /** 무기 선택 시 화면 하단에 뜨는 조작 안내 */
  hint: string;
  /** 기본 점수 (1× 콤보·1× 속도 기준). 스토어가 콤보 배율, 씬이 속도 배율 곱함. */
  strength: number;
  /** 피격 시 캐릭터 흔들림 강도 (1.0 = 기본) */
  shake: number;
  /** 파티클 색 */
  color: number;
  /** 파티클 개수 */
  particleCount: number;
  /** Web Audio synth preset */
  sound:
    | "punch"
    | "boing"
    | "slap"
    | "thud"
    | "clack"
    | "rustle"
    | "pew"
    | "pop"
    | "whoosh"
    | "squeak"
    | "scribble";
  /** 던지기 전용 — 발사체 질량 (matter.js body mass) */
  mass?: number;
  /** 던지기 전용 — sprite 한 변(px) */
  projectileSize?: number;
  /** 던지기 전용 — 충돌 연출. blunt = 둔탁, scatter = 흩뿌려짐 (종이) */
  impact?: "blunt" | "scatter";
  /** 낙서 전용 — stroke 두께 (화면 px) */
  strokeWidth?: number;
};

/**
 * 씬(PlayScene) 속도 배율/보너스 상한 — 무기 1타의 실효 최대 base 를 결정.
 * 어뷰징 S2 임계(lib/anti-abuse-rules.ts effectiveMaxBase)가 여기서 유도되므로,
 * PlayScene 점수식 구조(factor 분모·fling 식)를 바꾸면 S2 재점검 + RULES_VERSION 상향.
 */
/** swipe 속도 배율 상한 — PlayScene handleSwipeHit `clamp(speed/1100, 0.6, MAX)`. */
export const SWIPE_FACTOR_MAX = 2.0;
/** 투척 충돌 속도 배율 상한 — PlayScene handleCollision `clamp(impactSpeed/18, 0.6, MAX)`. */
export const THROW_FACTOR_MAX = 2.2;
/** grab fling 릴리즈 속도 보너스 상한 — base = strength + power×BONUS, power=min(1, speed/1500). */
export const GRAB_FLING_POWER_BONUS = 30;
/** pinch 릴리즈 늘림 보너스 상한 — base = strength + ratio×BONUS, ratio=늘린 거리/최대 거리(0..1). */
export const PINCH_STRETCH_BONUS = 26;

export const WEAPONS: readonly Weapon[] = [
  // ── tap: 주먹·뿅망치 ─────────────────────────────────────────────
  {
    key: "fist",
    category: "tap",
    group: "tap",
    label: "주먹",
    emoji: "👊",
    hint: "부장님을 탭해서 퍽퍽",
    strength: 12,
    shake: 1.7,
    color: 0xffd166,
    particleCount: 14,
    sound: "punch",
  },
  {
    key: "hammer",
    category: "tap",
    group: "tap",
    label: "뿅망치",
    emoji: "🔨",
    hint: "부장님을 탭해서 뿅뿅",
    strength: 9,
    shake: 1.2,
    color: 0xff8fab,
    particleCount: 12,
    sound: "boing",
  },
  // ── hands: 캐릭터 직접 조작 — 싸대기·잡아던지기·꼬집기 ──────────────
  {
    key: "slap",
    category: "swipe",
    group: "hands",
    label: "싸대기",
    emoji: "✋",
    hint: "문지르듯 휘둘러 싸대기",
    strength: 14,
    shake: 1.3,
    color: 0xef476f,
    particleCount: 12,
    sound: "slap",
  },
  {
    key: "grab",
    category: "grab",
    group: "hands",
    label: "잡아던지기",
    emoji: "🤏",
    hint: "부장님을 잡아 휘둘러 던지기",
    strength: 20,
    shake: 2.0,
    color: 0xef476f,
    particleCount: 14,
    sound: "whoosh",
  },
  {
    key: "pinch",
    category: "pinch",
    group: "hands",
    label: "꼬집기",
    emoji: "🤌",
    hint: "부장님을 잡아 늘려 꼬집기",
    strength: 10,
    shake: 1.0,
    color: 0xff8fab,
    particleCount: 8,
    sound: "squeak",
  },
  // ── projectile: 날아가는 것 — 책·키보드·비비탄 ───────────────────
  {
    key: "book",
    category: "throw",
    group: "projectile",
    label: "책",
    emoji: "📚",
    hint: "무기를 잡고 휘둘러 던지기",
    strength: 16,
    shake: 1.6,
    color: 0x8b5a2b,
    particleCount: 10,
    sound: "thud",
    mass: 1.6,
    projectileSize: 52,
    impact: "blunt",
  },
  {
    key: "keyboard",
    category: "throw",
    group: "projectile",
    label: "키보드",
    emoji: "⌨️",
    hint: "무기를 잡고 휘둘러 던지기",
    strength: 20,
    shake: 1.8,
    color: 0xa0a0a0,
    particleCount: 12,
    sound: "thud",
    mass: 2.4,
    projectileSize: 56,
    impact: "blunt",
  },
  {
    key: "gun",
    category: "shoot",
    group: "projectile",
    label: "비비탄총",
    emoji: "🔫",
    hint: "빈 곳을 꾹 누르면 자동 발사",
    strength: 4,
    shake: 0.4,
    color: 0xffe066,
    particleCount: 5,
    sound: "pop",
  },
  // ── draw: 펜 ─────────────────────────────────────────────────────
  {
    key: "pen",
    category: "draw",
    group: "draw",
    label: "펜",
    emoji: "🖊️",
    hint: "얼굴에 낙서",
    strength: 3,
    shake: 0.0,
    color: 0x1a1a1a,
    particleCount: 0,
    sound: "scribble",
    strokeWidth: 3,
  },
] as const;

/**
 * 은퇴 무기 — 표시 전용(과거 scores/weapon_summary 행 라벨·집계 라벨).
 * 선택·신규 제출 로스터(WEAPONS)에서 빠졌지만 역사 데이터가 남아 있어 판독은 유지한다.
 */
export const RETIRED_WEAPONS: readonly Weapon[] = [
  {
    key: "paper",
    category: "throw",
    group: "projectile",
    label: "종이",
    emoji: "📄",
    hint: "무기를 잡고 휘둘러 던지기",
    strength: 8,
    shake: 0.5,
    color: 0xffffff,
    particleCount: 18,
    sound: "rustle",
    mass: 0.4,
    projectileSize: 44,
    impact: "scatter",
  },
] as const;

export function resolveWeapon(key?: string | null): Weapon {
  return (
    WEAPONS.find((w) => w.key === key) ??
    RETIRED_WEAPONS.find((w) => w.key === key) ??
    WEAPONS[0]
  );
}

/**
 * 롤 반영 무기 힌트. boss 는 기존 hint 와 동일(회귀 0), 그 외 롤은 힌트 속 대상 명사
 * ("부장님을")를 해당 롤의 목적격(targetObj, 예 "거래처를")으로 치환. 대상 명사가 없는
 * 힌트("무기를 잡고…" 등)는 그대로. WEAPONS.hint 를 깨지 않고 함수로 감싼다.
 */
export function weaponHint(
  key: string | null | undefined,
  role: RoleId = "boss",
  cfg?: RoleConfig
): string {
  const hint = resolveWeapon(key).hint;
  if (role === "boss") return hint;
  return hint.replace(roleObj(roleFrom("boss", cfg).label), roleObj(roleFrom(role, cfg).label));
}
