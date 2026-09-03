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
  options: { durationMs?: number; maxCombo?: number; ultimateCount?: number } = {},
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
      bgVisits: [],
      intervalCV: null,
    }),
  );
}

test("v2.1 우선순위: 궁극기 10 → 무기 9종 → 콤보 400, 임계는 문서대로 닫힘", () => {
  assert.equal(personaFor({ fist: 10 }, { ultimateCount: 9 }).id, "barehand");
  assert.equal(personaFor({ fist: 10 }, { ultimateCount: 10 }).id, "ult_dependent");

  const eight = { fist: 1, hammer: 1, slap: 1, pinch: 1, book: 1, keyboard: 1, gun: 1, grab: 1 };
  // 8종(각 12.5%)은 웨폰 마스터도 무기 유형도 아니다 → 폴백. 9종(전 무기)부터 웨폰 마스터.
  assert.equal(personaFor(eight, { maxCombo: 1 }).id, "balanced");
  assert.equal(personaFor({ ...eight, pen: 1 }).id, "carpet");
  // 8종은 더 이상 웨폰 마스터가 아니다(구 7종 임계 회귀 방지) — 주력 무기 유형으로 떨어진다
  assert.equal(personaFor({ ...eight, fist: 100 }).id, "barehand");
  // 궁극기가 무기 9종보다 앞선다
  assert.equal(personaFor({ ...eight, pen: 1 }, { ultimateCount: 10 }).id, "ult_dependent");

  assert.equal(personaFor({ fist: 600 }, { maxCombo: 399 }).id, "barehand");
  assert.equal(personaFor({ fist: 600 }, { maxCombo: 400 }).id, "combo");
  // 무기 9종이 콤보 400보다 앞선다
  assert.equal(personaFor({ ...eight, pen: 600 }, { maxCombo: 600 }).id, "carpet");
});

test("무기 유형: 비중 40% 이상인 무기 중 최고 비중 무기로, 무기 단위 매핑", () => {
  assert.equal(personaFor({ pinch: 39, fist: 30, slap: 31 }).id, "balanced");
  assert.equal(personaFor({ pinch: 40, fist: 30, slap: 30 }).id, "pinch");
  // 40%+ 가 둘이면(45/42) 더 높은 쪽
  assert.equal(personaFor({ slap: 45, pinch: 42, fist: 13 }).id, "slap");
  const expect: Record<string, string> = {
    fist: "barehand",
    hammer: "hammer",
    slap: "slap",
    pinch: "pinch",
    book: "book",
    keyboard: "keyboard",
    gun: "sniper",
    grab: "grabber",
    pen: "graffiti",
  };
  for (const [weapon, id] of Object.entries(expect)) {
    const counts = weapon === "fist" ? { fist: 5 } : { [weapon]: 5, fist: 2 };
    assert.equal(personaFor(counts).id, id, weapon);
  }
  // 은퇴 무기(paper)가 최고 비중이면 매핑이 없어 폴백
  assert.equal(personaFor({ paper: 8, fist: 2 }).id, PERSONA_FALLBACK_ID);
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
  const eight = { fist: 1, hammer: 1, slap: 1, pinch: 1, book: 1, keyboard: 1, gun: 1, grab: 1 };
  const reached = new Set([
    personaFor({ fist: 1 }, { ultimateCount: 10 }).id,
    personaFor({ ...eight, pen: 1 }).id,
    personaFor({ fist: 600 }, { maxCombo: 400 }).id,
    ...["fist", "hammer", "slap", "pinch", "book", "keyboard", "gun", "grab", "pen"].map(
      (w) => personaFor({ [w]: 5 }).id,
    ),
    personaFor({ fist: 3, slap: 3, book: 3 }).id,
  ]);
  assert.deepEqual([...reached].sort(), [...ids].sort());
});
