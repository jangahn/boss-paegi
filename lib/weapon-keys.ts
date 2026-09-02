/**
 * 무기 키 어휘 — **데이터 어휘(활성 + 은퇴)**. scores.weapon·weapon_summary 등
 * 저장된 역사 행의 판독( lib/history-read.ts )에 쓰이므로 은퇴 무기도 제거하지 않는다.
 * 활성 로스터(선택·게임플레이)는 lib/weapons.ts WEAPONS 가 단일 소스.
 */
export const WEAPON_KEY_VALUES = [
  "fist",
  "hammer",
  "slap",
  "book",
  "keyboard",
  "paper", // 2026-08 은퇴(최저 사용 — 30일 552타) → pinch 로 교체. 역사 행 판독용으로만 유지.
  "pinch",
  "gun",
  "grab",
  "pen",
] as const;

export type WeaponKey = (typeof WEAPON_KEY_VALUES)[number];
