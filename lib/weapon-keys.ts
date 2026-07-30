export const WEAPON_KEY_VALUES = [
  "fist",
  "hammer",
  "slap",
  "book",
  "keyboard",
  "paper",
  "gun",
  "grab",
  "pen",
] as const;

export type WeaponKey = (typeof WEAPON_KEY_VALUES)[number];
