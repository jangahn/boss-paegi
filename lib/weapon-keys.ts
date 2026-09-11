/**
 * 무기 키 어휘 — **데이터 어휘(활성 + 은퇴)**. scores.weapon·weapon_summary 등
 * 저장된 역사 행의 판독( lib/history-read.ts )에 쓰이므로 은퇴 무기도 제거하지 않는다.
 * 활성 로스터(선택·게임플레이)는 lib/weapons.ts WEAPONS 가 단일 소스(투척은 맵별 2종, v1.35).
 * ⚠ 키 추가 시 DB 함수 allowlist 도 함께: bp_submit_score_with_review_core(제출)·telemetry_rollup_rows_for_day(c_weapon_order).
 */
export const WEAPON_KEY_VALUES = [
  "fist",
  "hammer",
  "slap",
  "book",
  "keyboard",
  "paper", // 2026-08 은퇴 → 2026-09 v1.35 복사실 투척(경)으로 복귀. 역사 행과 같은 키.
  "pinch",
  "gun",
  "grab",
  "pen",
  // ── v1.35 맵별 투척 무기(경·중) — 탕비실·복사실·회의실·엘리베이터·회식자리. DB allowlist(0125)와 동일 순서. ──
  "mug",
  "ramen",
  "printer",
  "note",
  "laptop",
  "phone",
  "umbrella",
  "beer",
  "chicken",
] as const;

export type WeaponKey = (typeof WEAPON_KEY_VALUES)[number];
