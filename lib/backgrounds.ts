export const BACKGROUNDS = [
  { key: "office", label: "사무실", url: "/bg/office.jpg" },
  { key: "pantry", label: "탕비실", url: "/bg/pantry.jpg" },
  { key: "meeting", label: "회의실", url: "/bg/meeting.jpg" },
  { key: "hwesik", label: "회식자리", url: "/bg/hwesik.jpg" },
] as const;

export type BgKey = (typeof BACKGROUNDS)[number]["key"];
export type Background = (typeof BACKGROUNDS)[number];

export function resolveBackground(key?: string | null): Background {
  const found = BACKGROUNDS.find((b) => b.key === key);
  if (found) return found;
  return BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
}
