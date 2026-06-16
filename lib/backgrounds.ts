export const BACKGROUNDS = [
  { key: "office", label: "사무실", url: "/bg/office.jpg" },
  { key: "pantry", label: "탕비실", url: "/bg/pantry.jpg" },
  { key: "copy", label: "복사실", url: "/bg/copy.jpg" },
  { key: "meeting", label: "회의실", url: "/bg/meeting.jpg" },
  { key: "elevator", label: "엘리베이터", url: "/bg/elevator.jpg" },
  { key: "hwesik", label: "회식자리", url: "/bg/hwesik.jpg" },
] as const;

export type BgKey = (typeof BACKGROUNDS)[number]["key"];
export type Background = (typeof BACKGROUNDS)[number];

// key 매칭만 — 폴백 없음. 유효성 판별용(매칭 실패/누락 시 undefined).
export function findBackground(key?: string | null): Background | undefined {
  return BACKGROUNDS.find((b) => b.key === key);
}

// key 로 배경을 찾는다 — 결정적(deterministic). 매칭 실패 시 첫 배경으로 폴백.
// SSR/hydration 일치를 위해 절대 여기서 random 을 쓰지 않는다.
// "초기 1회 random" 은 client 전용 randomBackground() 으로 분리 (page.tsx 마운트 effect).
export function resolveBackground(key?: string | null): Background {
  return findBackground(key) ?? BACKGROUNDS[0];
}

// 클라이언트 전용 — 초기 배경 random 1회 선택용.
// SSR 이나 render 중 호출 금지: 서버/클라 결과가 달라 hydration mismatch 가 난다.
export function randomBackground(): Background {
  return BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
}
