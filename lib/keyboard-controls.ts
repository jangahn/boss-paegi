import type { WeaponCategory } from "./weapons";

/**
 * PC 키보드 조작(v1.50) — 키 해석과 안내 문구의 단일 소스(순수 모듈: React 훅·무기 피커 툴팁·테스트 공용).
 *
 * 인식 키는 네 묶음뿐(사용자 확정): 숫자 1~9 = 무기 피커 1~9칸 · Q W E R T Y = 맵 6종 · 스페이스·방향키 = 공격.
 * 판별은 `KeyboardEvent.code`(물리 키) — 한글 입력 상태에서는 `key` 가 "ㅂ"·"Process" 로 와서 글자로는 못 읽는다.
 * 숫자는 상단 숫자줄만(넘패드는 NumLock 이 꺼지면 방향키로 동작해 겹친다).
 */
export type AttackKey = "space" | "up" | "down" | "left" | "right";
export type KeyPhase = "down" | "up";
export type GameKey =
  | { kind: "weapon"; slot: number }
  | { kind: "map"; index: number }
  | { kind: "attack"; key: AttackKey };

/** 맵 선택 키 — `BACKGROUNDS` 순서(사무실·탕비실·복사실·회의실·엘리베이터·회식자리)와 1:1. */
export const MAP_KEY_LABELS = ["Q", "W", "E", "R", "T", "Y"] as const;
/** 무기 피커 칸 수(전 맵 고정 9칸) = 숫자키 1~9. */
export const WEAPON_KEY_COUNT = 9;

const ATTACK_CODES: Readonly<Record<string, AttackKey>> = {
  Space: "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function resolveGameKey(code: string): GameKey | null {
  const attack = ATTACK_CODES[code];
  if (attack) return { kind: "attack", key: attack };
  const digit = /^Digit([1-9])$/.exec(code);
  if (digit) return { kind: "weapon", slot: Number(digit[1]) - 1 };
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) {
    const index = (MAP_KEY_LABELS as readonly string[]).indexOf(letter[1]);
    if (index >= 0) return { kind: "map", index };
  }
  return null;
}

type KeyEventLike = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: unknown;
};

/** 브라우저 단축키(Ctrl/Cmd/Alt 조합)와 글자 입력 중(입력 필드·의견 위젯)에는 게임 키로 받지 않는다. */
export function shouldIgnoreKeyEvent(e: KeyEventLike): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const t = e.target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined;
  if (!t || typeof t !== "object") return false;
  if (t.isContentEditable === true) return true;
  const tag = typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * 무기 종류별 키 동작 안내 — 무기 피커 hover 툴팁(안내 캡슐)에 그대로 쓴다(무기 이름은 넣지 않는다 — 사용자 결정).
 * 방향키 규칙(사용자 확정): 주먹·뿅망치·투척·비비탄총 = **그 방향 부위를 타격**(투척·총은 그쪽에서 날아와 맞는다),
 * 싸대기·잡아던지기 = **그 방향으로** 치고·던진다, 꼬집기·펜 = 누르는 동안 그 방향으로 조종. 방향은 8방향(두 키 = 대각선).
 */
export const KEYBOARD_HELP: Readonly<Record<WeaponCategory, { space: string; arrows: string }>> = {
  tap: { space: "랜덤 부위 타격", arrows: "그 방향 부위 타격" },
  swipe: { space: "상하좌우 랜덤으로 왕복 두 대", arrows: "그 방향으로 왕복 두 대" },
  grab: { space: "랜덤 방향으로 던지기", arrows: "그 방향으로 던지기" },
  pinch: { space: "누르는 동안 이리저리 늘리기", arrows: "누르는 동안 그 방향으로 늘리기" },
  throw: { space: "랜덤한 곳에서 투척", arrows: "그 방향 부위로 투척" },
  shoot: { space: "누르는 동안 자동 발사", arrows: "그 방향 부위로 자동 발사" },
  draw: { space: "누르는 동안 자동 낙서", arrows: "누르는 동안 직접 그리기" },
};

export function keyboardHint(category: WeaponCategory): string {
  const help = KEYBOARD_HELP[category];
  return `스페이스: ${help.space} · 방향키: ${help.arrows}`;
}
