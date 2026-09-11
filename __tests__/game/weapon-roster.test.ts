// weapon-roster.test.ts — 맵별 투척 무기 로스터(v1.35) 회귀 가드: 어휘·맵 배정·피커 칸 순서·맵 전환 보정·봉투 불변.
//   실행: node --test __tests__/game/weapon-roster.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  WEAPONS,
  RETIRED_WEAPONS,
  THROW_WEAPONS,
  THROW_FACTOR_MAX,
  throwWeaponsForMap,
  weaponsForMap,
  remapWeaponForMap,
  resolveWeapon,
} = await import("../../lib/weapons.ts");
const { WEAPON_KEY_VALUES } = await import("../../lib/weapon-keys.ts");
const { BACKGROUNDS } = await import("../../lib/backgrounds.ts");

test("로스터 19종 = 공통 7 + 맵 6 × 투척 2, 키는 유일하고 전부 데이터 어휘 안", () => {
  assert.equal(WEAPONS.length, 19);
  assert.equal(THROW_WEAPONS.length, 12);
  assert.equal(WEAPONS.filter((w) => w.category !== "throw").length, 7);
  const keys = WEAPONS.map((w) => w.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.ok((WEAPON_KEY_VALUES as readonly string[]).includes(k), k);
  assert.deepEqual([...RETIRED_WEAPONS], [], "종이 복귀 후 은퇴 목록은 비어 있다");
  assert.equal(resolveWeapon("paper").map, "copy");
});

test("투척 무기는 맵마다 정확히 경·중 하나씩, 시그니처·수치 규약을 지킨다", () => {
  for (const bg of BACKGROUNDS) {
    const pair = throwWeaponsForMap(bg.key);
    assert.equal(pair.length, 2, bg.key);
    assert.deepEqual(pair.map((w) => w.tier), ["light", "heavy"], bg.key);
    assert.equal(pair[0].strength, 16);
    assert.equal(pair[1].strength, 20);
    for (const w of pair) {
      assert.equal(w.map, bg.key);
      assert.ok(w.signature, `${w.key} signature`);
      assert.ok(w.projectileSize && w.mass, `${w.key} physics`);
    }
  }
  const signatures = THROW_WEAPONS.map((w) => w.signature);
  assert.equal(new Set(signatures).size, signatures.length, "시그니처는 무기마다 고유");
  // 무기별 어뷰징 봉투(effectiveMaxBase = strength × THROW_FACTOR_MAX)는 책·키보드와 동일 → 최대 44
  const maxBase = Math.max(...THROW_WEAPONS.map((w) => Math.round(w.strength * THROW_FACTOR_MAX)));
  assert.equal(maxBase, Math.round(20 * THROW_FACTOR_MAX));
});

test("피커 로스터는 9칸, 칸 순서(탭 2 | 손 3 | 투척 2 + 비비탄 | 펜)는 맵과 무관하게 같다", () => {
  const office = weaponsForMap("office").map((w) => w.key);
  assert.deepEqual(office, ["fist", "hammer", "slap", "grab", "pinch", "book", "keyboard", "gun", "pen"]);
  const hwesik = weaponsForMap("hwesik").map((w) => w.key);
  assert.deepEqual(hwesik, ["fist", "hammer", "slap", "grab", "pinch", "beer", "chicken", "gun", "pen"]);
  assert.deepEqual(weaponsForMap("no-such-map").map((w) => w.key), office, "미지 맵은 사무실 로스터");
  assert.deepEqual(weaponsForMap(null).map((w) => w.key), office);
});

test("맵 전환 보정: 다른 맵의 투척 무기는 같은 칸으로, 공통 무기와 같은 맵 무기는 그대로", () => {
  const book = resolveWeapon("book");
  const keyboard = resolveWeapon("keyboard");
  assert.equal(remapWeaponForMap(book, "pantry").key, "mug");
  assert.equal(remapWeaponForMap(keyboard, "pantry").key, "ramen");
  assert.equal(remapWeaponForMap(keyboard, "elevator").key, "umbrella");
  assert.equal(remapWeaponForMap(book, "office").key, "book");
  assert.equal(remapWeaponForMap(resolveWeapon("fist"), "hwesik").key, "fist");
  assert.equal(remapWeaponForMap(resolveWeapon("gun"), "meeting").key, "gun");
});
