// juggle-windows.test.ts — v1.36 시간 창 저글링: 무기변경(10초 창)·맵변경(2곳 ×1.5·3곳 ×2.0, 창 시작 시점 맵 포함)·
//   콤보 창 2.0초(어드민 설정)·합산 최대 ×4·score_config.juggle 스키마 기본값/범위.
//   실행: node --test __tests__/score/juggle-windows.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { useGameStore, comboMultiplier } = await import("../../store/gameStore.ts");
const {
  JUGGLE_CONFIG_DEFAULT,
  JUGGLE_SECONDS_DEFAULT,
  MAP_VARIETY_CAP,
  MAP_VARIETY_FULL_AT,
  SWITCH_COMBO_GRACE_MS,
  VARIETY_CAP,
  VARIETY_FULL_AT,
  juggleConfigFromSeconds,
  mapsInWindow,
  varietyMultiplier,
} = await import("../../lib/game-tuning.ts");
const { scoreConfigSchema, SCORE_CONFIG_DEFAULT } = await import("../../lib/config/domains/score.ts");
const { MAX_AVG_SCORE_PER_SEC, MAX_SCORE_HARD, MAX_DURATION_MS } = await import("../../lib/score-limits.ts");
const { SCORE_PER_SEC_MAX, S7_LONG_SESSION_SCORE_FLOOR } = await import("../../lib/anti-abuse-rules.ts");

function withClock<T>(t: { mock: { method: (obj: object, name: string, impl: () => number) => unknown } }, run: (set: (ms: number) => void) => T): T {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  return run((ms) => {
    now = ms;
  });
}

test("배율 표: 무기 2·3·4·5종 → ×1.25·1.5·1.75·2.0, 맵 2곳 ×1.5·3곳 ×2.0, 기본 창 10초/10초/콤보 2.0초", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((d) => 1 + varietyMultiplier(d, VARIETY_FULL_AT, VARIETY_CAP)), [1, 1.25, 1.5, 1.75, 2, 2]);
  assert.deepEqual([1, 2, 3, 4].map((d) => 1 + varietyMultiplier(d, MAP_VARIETY_FULL_AT, MAP_VARIETY_CAP)), [1, 1.5, 2, 2]);
  assert.deepEqual(JUGGLE_SECONDS_DEFAULT, { weaponWindowSec: 10, mapWindowSec: 10, comboWindowSec: 2 });
  assert.deepEqual(JUGGLE_CONFIG_DEFAULT, { weaponWindowMs: 10_000, mapWindowMs: 10_000, comboWindowMs: 2_000 });
  assert.deepEqual(juggleConfigFromSeconds({ weaponWindowSec: 3, mapWindowSec: 60, comboWindowSec: 1.5 }), {
    weaponWindowMs: 3_000,
    mapWindowMs: 60_000,
    comboWindowMs: 1_500,
  });
});

test("mapsInWindow: 창 안 전환 맵 + 창 시작 시점에 머물던 맵을 센다", () => {
  const log = [
    { t: 0, map: "office" },
    { t: 5_000, map: "pantry" },
    { t: 8_000, map: "copy" },
  ];
  assert.equal(mapsInWindow(log, 9_000, 10_000), 3, "0~9s 창: office(시작)·pantry·copy");
  assert.equal(mapsInWindow(log, 16_000, 10_000), 2, "6~16s 창: pantry(창 시작 시점 체류)·copy");
  assert.equal(mapsInWindow(log, 19_000, 10_000), 1, "9~19s 창: copy 만");
  assert.equal(mapsInWindow([], 1_000, 10_000), 0);
});

test("무기변경은 10초 창 — 5종 후 같은 무기만 치면 창이 비면서 ×1 로 돌아온다", (t) => {
  withClock(t, (set) => {
    const store = useGameStore.getState();
    store.configureJuggle(JUGGLE_CONFIG_DEFAULT);
    store.start();
    set(1_000);
    for (const w of ["fist", "hammer", "slap", "grab", "pinch"]) useGameStore.getState().hit(10, w);
    assert.equal(useGameStore.getState().varietyMult, VARIETY_CAP, "5종 → ×2");
    set(1_000 + 9_000);
    useGameStore.getState().hit(10, "fist");
    assert.equal(useGameStore.getState().varietyMult, VARIETY_CAP, "9초 뒤에도 창 안이면 유지");
    set(1_000 + 9_000 + 10_001);
    useGameStore.getState().hit(10, "fist");
    assert.equal(useGameStore.getState().varietyMult, 0, "앞선 5종이 창 밖으로 나가고 fist 만 남으면 ×1");
  });
});

test("맵변경은 곱으로 — 2곳 ×1.5·3곳 ×2.0, 무기 5종과 겹치면 최대 ×4, 창이 지나면 식는다", (t) => {
  withClock(t, (set) => {
    const store = useGameStore.getState();
    store.configureJuggle(JUGGLE_CONFIG_DEFAULT);
    store.start();
    set(1_000);
    store.noteMap("office");
    assert.equal(useGameStore.getState().mapMult, 0);
    set(2_000);
    useGameStore.getState().noteMap("pantry");
    assert.equal(useGameStore.getState().mapMult, 0.5, "2곳 → ×1.5");
    set(3_000);
    useGameStore.getState().noteMap("copy");
    assert.equal(useGameStore.getState().mapMult, MAP_VARIETY_CAP, "3곳 → ×2.0");
    // 5종 무기 + 3맵: 콤보 1 (첫 타격) 기준 base = strength × 1 × 2 × 2
    for (const w of ["fist", "hammer", "slap", "grab"]) useGameStore.getState().hit(10, w);
    const before = useGameStore.getState().score;
    const gain = useGameStore.getState().hit(10, "pinch");
    const s = useGameStore.getState();
    assert.equal(s.varietyMult, VARIETY_CAP);
    assert.equal(s.mapMult, MAP_VARIETY_CAP);
    assert.equal(gain, Math.round(10 * comboMultiplier(s.combo) * (1 + VARIETY_CAP) * (1 + MAP_VARIETY_CAP)));
    assert.equal(s.score - before, gain + 300, "fresh 300 은 배율 밖");
    // 14초 뒤: 마지막 전환(copy, 3s)이 창(4~14s) 밖 → copy 만 체류 → ×1
    set(3_000 + 11_000);
    useGameStore.getState().hit(10, "pinch");
    assert.equal(useGameStore.getState().mapMult, 0);
  });
});

test("콤보 유지 창 2.0초(설정 가능) + 전환 여유 0.3초", (t) => {
  withClock(t, (set) => {
    const store = useGameStore.getState();
    store.configureJuggle(JUGGLE_CONFIG_DEFAULT);
    store.start();
    set(1_000);
    useGameStore.getState().hit(10, "fist");
    set(1_000 + 1_900);
    useGameStore.getState().hit(10, "fist");
    assert.equal(useGameStore.getState().combo, 2, "1.9초 뒤 같은 무기 → 유지");
    set(1_000 + 1_900 + 2_100);
    useGameStore.getState().hit(10, "fist");
    assert.equal(useGameStore.getState().combo, 1, "2.1초 뒤 → 끊김");
    set(1_000 + 1_900 + 2_100 + 2_200);
    useGameStore.getState().hit(10, "hammer");
    assert.equal(useGameStore.getState().combo, 2, `전환 타격은 +${SWITCH_COMBO_GRACE_MS}ms 여유 → 2.2초도 유지`);
    // 어드민이 1.0초로 줄이면 1.5초 간격은 끊긴다
    useGameStore.getState().configureJuggle(juggleConfigFromSeconds({ weaponWindowSec: 10, mapWindowSec: 10, comboWindowSec: 1 }));
    set(1_000 + 1_900 + 2_100 + 2_200 + 1_500);
    useGameStore.getState().hit(10, "hammer");
    assert.equal(useGameStore.getState().combo, 1);
  });
});

test("score_config.juggle 스키마: 기본값 충전·범위 검사, start 는 창 설정을 유지한다", () => {
  const parsed = scoreConfigSchema.parse({ thresholds: [10_000, 30_000, 60_000, 100_000], grades: SCORE_CONFIG_DEFAULT.grades });
  assert.deepEqual(parsed.juggle, JUGGLE_SECONDS_DEFAULT, "발행행에 없던 키는 기본값");
  assert.equal(scoreConfigSchema.safeParse({ ...SCORE_CONFIG_DEFAULT, juggle: { weaponWindowSec: 2, mapWindowSec: 10, comboWindowSec: 2 } }).success, false);
  assert.equal(scoreConfigSchema.safeParse({ ...SCORE_CONFIG_DEFAULT, juggle: { weaponWindowSec: 10, mapWindowSec: 61, comboWindowSec: 2 } }).success, false);
  assert.equal(scoreConfigSchema.safeParse({ ...SCORE_CONFIG_DEFAULT, juggle: { weaponWindowSec: 10, mapWindowSec: 10, comboWindowSec: 3.5 } }).success, false);
  assert.equal(scoreConfigSchema.safeParse({ ...SCORE_CONFIG_DEFAULT, juggle: { weaponWindowSec: 7.5, mapWindowSec: 10, comboWindowSec: 2 } }).success, false);
  assert.equal(scoreConfigSchema.safeParse({ ...SCORE_CONFIG_DEFAULT, juggle: { weaponWindowSec: 3, mapWindowSec: 60, comboWindowSec: 1 } }).success, true);
  const store = useGameStore.getState();
  store.configureJuggle(juggleConfigFromSeconds({ weaponWindowSec: 5, mapWindowSec: 7, comboWindowSec: 1.5 }));
  store.start();
  assert.deepEqual(useGameStore.getState().juggle, { weaponWindowMs: 5_000, mapWindowMs: 7_000, comboWindowMs: 1_500 });
});

test("봉투 계층: 저장 상한 4000/초 ≥ S3 2800 · S7 = S3 × 900초 · 30분 × 4000 ≤ 점수 하드캡 800만", () => {
  assert.equal(MAX_AVG_SCORE_PER_SEC, 4000);
  assert.equal(SCORE_PER_SEC_MAX, 2800);
  assert.ok(MAX_AVG_SCORE_PER_SEC >= SCORE_PER_SEC_MAX);
  assert.equal(S7_LONG_SESSION_SCORE_FLOOR, 2_520_000);
  assert.equal(MAX_SCORE_HARD, 8_000_000);
  assert.ok((MAX_DURATION_MS / 1000) * MAX_AVG_SCORE_PER_SEC <= MAX_SCORE_HARD);
});
