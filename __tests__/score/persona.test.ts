import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { buildGameplayStats } = await import("../../lib/stats.ts");
const {
  PERSONA_DEFS,
  PERSONA_FALLBACK_ID,
  RETIRED_PERSONA_DEFS,
  matchPersona,
  personaById,
} = await import("../../lib/persona.ts");

function personaFor(
  weaponCounts: Record<string, number>,
  options: { durationMs?: number; maxCombo?: number; ultimateCount?: number; bgVisits?: string[] } = {},
) {
  const hitCount = Object.values(weaponCounts).reduce((sum, count) => sum + count, 0);
  const weaponScores = Object.fromEntries(Object.keys(weaponCounts).map((key) => [key, 0]));
  return matchPersona(
    buildGameplayStats({
      hitCount,
      maxCombo: options.maxCombo ?? Math.min(hitCount, 1),
      durationMs: options.durationMs ?? 60_000,
      weaponCounts,
      weaponScores,
      ultScore: 0,
      ultimateCount: options.ultimateCount ?? 0,
      firstHitMs: hitCount > 0 ? 0 : null,
      bgVisits: options.bgVisits ?? [],
      intervalCV: null,
    }),
  );
}
const FIVE_MAPS = ["office", "pantry", "copy", "meeting", "elevator"];
/** 공통 7 + 사무실 2 = 한 맵 로스터 9종 */
const NINE = { fist: 1, hammer: 1, slap: 1, pinch: 1, book: 1, keyboard: 1, gun: 1, grab: 1, pen: 1 };

test("v3 우선순위: 궁극기 10 → 맵 5곳 → 무기 10종 → 콤보 400 → 투척 40% → 무기 유형, 임계는 문서대로 닫힘", () => {
  assert.equal(personaFor({ fist: 10 }, { ultimateCount: 9 }).id, "barehand");
  assert.equal(personaFor({ fist: 10 }, { ultimateCount: 10 }).id, "ult_dependent");
  // 맵 5곳 — 궁극기 다음, 무기 10종보다 앞
  assert.equal(personaFor({ fist: 10 }, { bgVisits: FIVE_MAPS.slice(0, 4) }).id, "barehand");
  assert.equal(personaFor({ fist: 10 }, { bgVisits: FIVE_MAPS }).id, "tourist");
  assert.equal(personaFor({ ...NINE, mug: 1 }, { bgVisits: FIVE_MAPS }).id, "tourist");
  assert.equal(personaFor({ ...NINE, mug: 1 }, { bgVisits: FIVE_MAPS, ultimateCount: 10 }).id, "ult_dependent");
  // 무기 10종(한 맵 9종으론 불가) — 9종은 비중 11% 씩이라 폴백
  assert.equal(personaFor(NINE, { maxCombo: 1 }).id, "balanced");
  assert.equal(personaFor({ ...NINE, mug: 1 }).id, "carpet");
  assert.equal(personaFor({ ...NINE, mug: 1, fist: 100 }).id, "carpet");
  assert.equal(personaFor({ fist: 600 }, { maxCombo: 399 }).id, "barehand");
  assert.equal(personaFor({ fist: 600 }, { maxCombo: 400 }).id, "combo");
  assert.equal(personaFor({ ...NINE, mug: 1, pen: 600 }, { maxCombo: 600 }).id, "carpet");
  // 맵 5곳 근거 문구, 중복 방문은 한 곳
  assert.match(personaFor({ fist: 1 }, { bgVisits: FIVE_MAPS }).evidence, /맵 5곳 순회/);
  assert.equal(personaFor({ fist: 1 }, { bgVisits: ["office", "office", "pantry", "copy", "meeting"] }).id, "barehand");
});

test("무기 유형: 투척은 카테고리 합산 40%+ 면 투척왕, 그 외는 비중 40%+ 최고 무기 단위", () => {
  assert.equal(personaFor({ pinch: 39, fist: 30, slap: 31 }).id, "balanced");
  assert.equal(personaFor({ pinch: 40, fist: 30, slap: 30 }).id, "pinch");
  // 40%+ 가 둘이면(45/42) 더 높은 쪽
  assert.equal(personaFor({ slap: 45, pinch: 42, fist: 13 }).id, "slap");
  const expect: Record<string, string> = {
    fist: "barehand",
    hammer: "hammer",
    slap: "slap",
    pinch: "pinch",
    gun: "sniper",
    grab: "grabber",
    pen: "graffiti",
  };
  for (const [weapon, id] of Object.entries(expect)) {
    const counts = weapon === "fist" ? { fist: 5 } : { [weapon]: 5, fist: 2 };
    assert.equal(personaFor(counts).id, id, weapon);
  }
  // 투척 12종은 개별 무기가 아니라 카테고리 합산 — 여러 투척 무기를 섞어도 합이 40% 면 투척왕
  for (const w of ["book", "keyboard", "paper", "mug", "ramen", "printer", "note", "laptop", "phone", "umbrella", "beer", "chicken"]) {
    assert.equal(personaFor({ [w]: 5, fist: 2 }).id, "thrower", w);
  }
  assert.equal(personaFor({ book: 2, chicken: 2, fist: 6 }).id, "thrower", "합산 40% 정확히");
  assert.equal(personaFor({ book: 2, chicken: 1, fist: 7 }).id, "barehand", "합산 30% 는 투척왕 아님");
  assert.match(personaFor({ paper: 8, fist: 2 }).evidence, /투척 비중 80%/);
  assert.match(personaFor({ pinch: 6, fist: 4 }).evidence, /비중 60%/);
});

test("폴백·카탈로그: 은퇴 유형은 판정 불가·표시 정의만, 활성 유형은 전부 도달 가능", () => {
  assert.equal(PERSONA_FALLBACK_ID, "balanced");
  // v2.1 라벨 개명 — id·뱃지 slug 는 동결이므로 라벨만 바뀐다
  assert.equal(personaById("ult_dependent")?.label, "궁극기 폭격기");
  const ids = PERSONA_DEFS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of RETIRED_PERSONA_DEFS) {
    assert.ok(!ids.includes(r.id), `${r.id} retired`);
    assert.equal(personaById(r.id)?.label, r.label);
  }
  // v3: 책·키보드 유형 은퇴(표시 정의 보존), 투척왕 복귀, 투어리스트 신설
  assert.equal(personaById("book")?.label, "독서 강요형");
  assert.ok(ids.includes("thrower") && ids.includes("tourist"));
  const reached = new Set([
    personaFor({ fist: 1 }, { ultimateCount: 10 }).id,
    personaFor({ fist: 1 }, { bgVisits: FIVE_MAPS }).id,
    personaFor({ ...NINE, mug: 1 }).id,
    personaFor({ fist: 600 }, { maxCombo: 400 }).id,
    ...["fist", "hammer", "slap", "pinch", "book", "gun", "grab", "pen"].map((w) => personaFor({ [w]: 5 }).id),
    personaFor({ fist: 3, slap: 3, gun: 3 }).id,
  ]);
  assert.deepEqual([...reached].sort(), [...ids].sort());
});
