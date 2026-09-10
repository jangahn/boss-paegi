// taunts.test.ts — 시비 멘트 셔플백(v1.32) 회귀 가드: 사이클 무반복·이음새·인접 tier 혼합 2:1·인접 백 커서 연속·
//   풀 대조·영속 포맷·지터 범위.
//   실행: node --test __tests__/game/taunts.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  TAUNT_ADJACENT_TIER,
  TAUNT_INTERVAL_MAX_MS,
  TAUNT_INTERVAL_MIN_MS,
  TAUNT_MIX_BLOCK,
  TAUNT_VISIBLE_MS,
  createTauntSelectorState,
  nextTaunt,
  nextTauntDelayMs,
  parseTauntBags,
  serializeTauntBags,
  tauntBagKey,
} = await import("../../lib/taunts.ts");
const { TIER_COUNT, SCORE_THRESHOLDS_DEFAULT } = await import("../../lib/score-tiers.ts");
const { roleFrom, roleVoice } = await import("../../lib/config/domains/roles.ts");

/** 결정적 LCG — 테스트 재현용. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const POOLS = roleVoice(roleFrom("boss"), "male").taunts;
/** tier 진입 점수(기본 경계). */
const TIER_SCORE = [0, ...SCORE_THRESHOLDS_DEFAULT];

test("인접 tier 규칙: 길이 = TIER_COUNT, T0↔T1·T2←T1 만 섞고 T3·T4 는 순수", () => {
  assert.equal(TAUNT_ADJACENT_TIER.length, TIER_COUNT);
  assert.deepEqual([...TAUNT_ADJACENT_TIER], [1, 0, 1, null, null]);
  assert.equal(TAUNT_MIX_BLOCK, 3);
});

test("순수 tier(T4): 한 사이클 안에선 풀 전체가 한 번씩, 다음 사이클 첫 줄은 직전 줄과 다르다", () => {
  const pool = POOLS[4];
  assert.ok(pool.length >= 2);
  const state = createTauntSelectorState();
  const rng = lcg(7);
  const first = Array.from({ length: pool.length }, () => nextTaunt(state, { score: TIER_SCORE[4], rng }));
  assert.deepEqual([...first].sort(), [...pool].sort());
  const seam = nextTaunt(state, { score: TIER_SCORE[4], rng });
  assert.notEqual(seam, first[first.length - 1]);
  const second = [seam, ...Array.from({ length: pool.length - 1 }, () => nextTaunt(state, { score: TIER_SCORE[4], rng }))];
  assert.deepEqual([...second].sort(), [...pool].sort());
});

test("이음새 회피는 시드와 무관: 여러 시드에서 연속 동일이 0", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const state = createTauntSelectorState();
    const rng = lcg(seed);
    let last = "";
    for (let i = 0; i < 40; i++) {
      const t = nextTaunt(state, { score: TIER_SCORE[3], rng });
      assert.notEqual(t, last, `seed ${seed} draw ${i}`);
      last = t;
    }
  }
});

test("혼합 tier(T0): 3회 묶음마다 인접(T1) 줄이 정확히 1개 — 30회면 T1 10개·T0 20개", () => {
  const state = createTauntSelectorState();
  const rng = lcg(11);
  const t0 = new Set(POOLS[0]);
  const t1 = new Set(POOLS[1]);
  const draws = Array.from({ length: 30 }, () => nextTaunt(state, { score: 0, rng }));
  for (let b = 0; b < 30; b += TAUNT_MIX_BLOCK) {
    const block = draws.slice(b, b + TAUNT_MIX_BLOCK);
    assert.equal(block.filter((l) => t1.has(l)).length, 1, `block ${b / 3}`);
    assert.equal(block.filter((l) => t0.has(l)).length, 2, `block ${b / 3}`);
  }
});

test("인접 백 커서 연속: T0 구간에서 인접으로 나온 T1 줄은 T1 진입 뒤 그 사이클이 끝나기 전엔 다시 안 나온다", () => {
  const state = createTauntSelectorState();
  const rng = lcg(23);
  const t1 = new Set(POOLS[1]);
  const heardAtT0 = Array.from({ length: 6 }, () => nextTaunt(state, { score: 0, rng })).filter((l) => t1.has(l));
  assert.equal(heardAtT0.length, 2);
  // T1 진입 — T1 풀에서 나오는 줄만 세어 남은 6줄이 먼저 다 나와야 한다.
  const seenT1: string[] = [];
  while (seenT1.length < POOLS[1].length - heardAtT0.length) {
    const l = nextTaunt(state, { score: TIER_SCORE[1], rng });
    if (t1.has(l)) seenT1.push(l);
  }
  for (const l of heardAtT0) assert.ok(!seenT1.includes(l), `${l} 가 사이클 안에서 반복`);
});

test("T3·T4 는 인접 혼합 없이 자기 풀만", () => {
  for (const tier of [3, 4]) {
    const state = createTauntSelectorState();
    const rng = lcg(5 + tier);
    const own = new Set(POOLS[tier]);
    for (let i = 0; i < 24; i++) assert.ok(own.has(nextTaunt(state, { score: TIER_SCORE[tier], rng })));
  }
});

test("풀 대조: 저장된 백의 사라진 줄은 버리고 남은 순서는 유지, 백은 판 사이에 이어진다", () => {
  const key = tauntBagKey("boss", "male", 4);
  const pool = POOLS[4];
  const kept = [pool[3], pool[1]];
  const state = createTauntSelectorState({ [key]: { remaining: [pool[3], "발행에서 사라진 줄", pool[1]] } });
  const rng = lcg(3);
  assert.equal(nextTaunt(state, { score: TIER_SCORE[4], rng }), kept[0]);
  assert.equal(nextTaunt(state, { score: TIER_SCORE[4], rng }), kept[1]);
  // 커서 소진 → 새 사이클(전체 풀), 직전 줄 회피.
  const next = nextTaunt(state, { score: TIER_SCORE[4], rng });
  assert.ok(pool.includes(next));
  assert.notEqual(next, kept[1]);
  assert.equal(state.bags[key].remaining.length, pool.length - 1);
});

test("영속 포맷: 직렬화 왕복, 불량·구버전·이형 값은 빈 백", () => {
  const bags = { [tauntBagKey("boss", "female", 0)]: { remaining: ["a", "b"] } };
  assert.deepEqual(parseTauntBags(serializeTauntBags(bags)), bags);
  assert.deepEqual(parseTauntBags(null), {});
  assert.deepEqual(parseTauntBags(""), {});
  assert.deepEqual(parseTauntBags("{not json"), {});
  assert.deepEqual(parseTauntBags(JSON.stringify({ version: 0, bags })), {});
  assert.deepEqual(parseTauntBags(JSON.stringify({ version: 1, bags: { k: { remaining: [1, 2] } } })), {});
  assert.deepEqual(parseTauntBags(JSON.stringify({ version: 1, bags: { k: { remaining: ["x"] }, j: "bad" } })), {
    k: { remaining: ["x"] },
  });
});

test("지터: [MIN, MAX] 정수 ms, 최소 간격이 노출 시간보다 길어 말풍선이 겹치지 않는다", () => {
  assert.equal(nextTauntDelayMs(() => 0), TAUNT_INTERVAL_MIN_MS);
  assert.equal(nextTauntDelayMs(() => 0.999999), TAUNT_INTERVAL_MAX_MS);
  assert.ok(TAUNT_INTERVAL_MIN_MS > TAUNT_VISIBLE_MS);
  const rng = lcg(9);
  for (let i = 0; i < 200; i++) {
    const d = nextTauntDelayMs(rng);
    assert.ok(Number.isInteger(d) && d >= TAUNT_INTERVAL_MIN_MS && d <= TAUNT_INTERVAL_MAX_MS);
  }
});
