// score-tiers.test.ts — 5단계 단일 소스(lib/score-tiers) + score_config/role_content 정규화(v1.24) 회귀 가드.
//   실행: node --test __tests__/score/score-tiers.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  SCORE_THRESHOLDS_DEFAULT,
  THRESHOLD_STEP,
  TIER_COUNT,
  isValidThresholds,
  scoreTier,
  tierBandLabel,
} = await import("../../lib/score-tiers.ts");
const {
  LEGACY_GRADE_PICK,
  SCORE_CONFIG_DEFAULT,
  normalizeScoreConfigInput,
} = await import("../../lib/config/domains/score.ts");
const { scoreConfigSchema } = await import("../../lib/config/domains/score-schema.ts");
const {
  ROLE_CONFIG_DEFAULT,
  mergeLegacyTiers,
  normalizeRoleContentInput,
} = await import("../../lib/config/domains/roles.ts");
const { roleConfigSchema } = await import("../../lib/config/domains/roles-schema.ts");
const { MAX_SCORE_HARD } = await import("../../lib/score-limits.ts");
const { ROLE_IDS } = await import("../../lib/roles/ids.ts");

test("scoreTier honors injected thresholds and clamps to the last tier", () => {
  const t = [10_000, 30_000, 60_000, 100_000];
  assert.deepEqual(t, [...SCORE_THRESHOLDS_DEFAULT]);
  assert.equal(scoreTier(0, t), 0);
  assert.equal(scoreTier(9_999, t), 0);
  assert.equal(scoreTier(10_000, t), 1);
  assert.equal(scoreTier(29_999, t), 1);
  assert.equal(scoreTier(30_000, t), 2);
  assert.equal(scoreTier(59_999, t), 2);
  assert.equal(scoreTier(60_000, t), 3);
  assert.equal(scoreTier(99_999, t), 3);
  assert.equal(scoreTier(100_000, t), 4);
  assert.equal(scoreTier(733_467, t), 4);
  // 다른 경계를 주입하면 같은 점수의 단계가 바뀐다(경계 = 라이브 config).
  assert.equal(scoreTier(25_000, [20_000, 40_000, 60_000, 80_000]), 1);
  assert.equal(scoreTier(25_000, [30_000, 40_000, 60_000, 80_000]), 0);
});

test("tierBandLabel renders ranges from the thresholds and an open top band", () => {
  assert.equal(tierBandLabel(0), "0~9,999");
  assert.equal(tierBandLabel(1), "10,000~29,999");
  assert.equal(tierBandLabel(2), "30,000~59,999");
  assert.equal(tierBandLabel(3), "60,000~99,999");
  assert.equal(tierBandLabel(4), "100,000+");
  assert.equal(tierBandLabel(9), "100,000+");
  assert.equal(tierBandLabel(1, [5_000, 6_000, 7_000, 8_000]), "5,000~5,999");
});

test("threshold validation enforces count, step, monotonicity, and bounds", () => {
  assert.equal(isValidThresholds([10_000, 30_000, 60_000, 100_000], THRESHOLD_STEP, MAX_SCORE_HARD), true);
  assert.equal(isValidThresholds([10_000, 30_000, 60_000], THRESHOLD_STEP, MAX_SCORE_HARD), false, "count");
  assert.equal(isValidThresholds([10_500, 30_000, 60_000, 100_000], THRESHOLD_STEP, MAX_SCORE_HARD), false, "step");
  assert.equal(isValidThresholds([10_000, 10_000, 60_000, 100_000], THRESHOLD_STEP, MAX_SCORE_HARD), false, "strict asc");
  assert.equal(isValidThresholds([30_000, 10_000, 60_000, 100_000], THRESHOLD_STEP, MAX_SCORE_HARD), false, "order");
  assert.equal(isValidThresholds([0, 30_000, 60_000, 100_000], THRESHOLD_STEP, MAX_SCORE_HARD), false, "min");
  assert.equal(isValidThresholds([10_000, 30_000, 60_000, MAX_SCORE_HARD + 1000], THRESHOLD_STEP, MAX_SCORE_HARD), false, "max");
  assert.equal(isValidThresholds("nope"), false);
});

test("score_config: legacy ten-grade rows normalize to the confirmed five and gain default thresholds", () => {
  const legacy = {
    grades: Array.from({ length: 10 }, (_, i) => ({ label: `등급${i}`, comment: `평${i}` })),
  };
  const normalized = normalizeScoreConfigInput(legacy) as { grades: { label: string }[] };
  assert.deepEqual(
    normalized.grades.map((g) => g.label),
    LEGACY_GRADE_PICK.map((i) => `등급${i}`),
  );
  assert.deepEqual([...LEGACY_GRADE_PICK], [0, 1, 5, 7, 9]);
  const parsed = scoreConfigSchema.safeParse(legacy);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.grades.length, TIER_COUNT);
    assert.deepEqual(parsed.data.thresholds, [...SCORE_THRESHOLDS_DEFAULT]);
  }
  // 이미 5단계 + thresholds 명시 → 그대로.
  const current = { thresholds: [5_000, 6_000, 7_000, 8_000], grades: legacy.grades.slice(0, 5) };
  const ok = scoreConfigSchema.safeParse(current);
  assert.equal(ok.success, true);
  if (ok.success) assert.deepEqual(ok.data.thresholds, [5_000, 6_000, 7_000, 8_000]);
  // 잘못된 경계는 거절(어드민 발행 400).
  for (const bad of [
    [5_500, 6_000, 7_000, 8_000],
    [8_000, 6_000, 7_000, 9_000],
    [1_000, 2_000, 3_000],
    [1_000, 2_000, 3_000, MAX_SCORE_HARD + 1_000],
  ]) {
    assert.equal(scoreConfigSchema.safeParse({ ...current, thresholds: bad }).success, false, JSON.stringify(bad));
  }
  // 코드 기본값 자체가 스키마를 통과한다.
  assert.equal(scoreConfigSchema.safeParse(SCORE_CONFIG_DEFAULT).success, true);
});

test("role_content: legacy ten-tier rows merge adjacent pairs and keep every edited line", () => {
  const tiers10 = (prefix: string, n: number) =>
    Array.from({ length: 10 }, (_, t) => Array.from({ length: n }, (_, k) => `${prefix}${t}-${k}`));
  const legacyRole = (name: string) => ({
    label: name,
    reactions: tiers10(`${name}R`, 3),
    taunts: tiers10(`${name}T`, 4),
    traits: ["t1"],
    ranks: ["r1"],
    departments: ["d1"],
  });
  // v18 발행행 모양: 5롤(coworker 포함)·10단계·desc 없음.
  const LEGACY_KEPT = ["boss", "exec", "teamlead", "client"] as const;
  const legacy = Object.fromEntries(
    [...LEGACY_KEPT, "coworker"].map((r) => [r, legacyRole(r)]),
  );
  const merged = mergeLegacyTiers(legacy.boss.reactions) as string[][];
  assert.equal(merged.length, TIER_COUNT);
  assert.deepEqual(merged[0], ["bossR0-0", "bossR0-1", "bossR0-2", "bossR1-0", "bossR1-1", "bossR1-2"]);
  assert.deepEqual(merged[4], ["bossR8-0", "bossR8-1", "bossR8-2", "bossR9-0", "bossR9-1", "bossR9-2"]);

  const parsed = roleConfigSchema.safeParse(normalizeRoleContentInput(legacy));
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3)));
  if (parsed.success) {
    const data = parsed.data as Record<string, { reactions: string[][]; taunts: string[][]; desc: string; label: string }>;
    assert.deepEqual(Object.keys(data).sort(), [...ROLE_IDS].sort(), "정확히 7롤");
    assert.equal("coworker" in data, false, "구 alias 키는 제거");
    for (const r of LEGACY_KEPT) {
      assert.equal(data[r].reactions.length, TIER_COUNT);
      assert.equal(data[r].taunts.length, TIER_COUNT);
      for (const tier of data[r].reactions) assert.equal(tier.length, 6);
      for (const tier of data[r].taunts) assert.equal(tier.length, 8);
      // 편집된 줄 전부 보존(합집합 == 원본 전체).
      assert.deepEqual(data[r].reactions.flat(), legacy[r].reactions.flat());
      assert.deepEqual(data[r].taunts.flat(), legacy[r].taunts.flat());
      // desc 는 발행행에 없으므로 롤별 코드 기본값 충전.
      assert.equal(data[r].desc, ROLE_CONFIG_DEFAULT[r].desc);
    }
    // 신규 3롤은 코드 기본값 시드(friend 는 coworker 문구를 승계하지 않음 — 감사 이력에만 남음).
    for (const r of ["ceo", "junior", "friend"] as const) {
      assert.deepEqual(data[r], ROLE_CONFIG_DEFAULT[r]);
    }
  }
  // 스키마는 preprocess 를 내장하므로 raw legacy 도 바로 통과한다(발행행 읽기 경로).
  assert.equal(roleConfigSchema.safeParse(legacy).success, true);
  // 5단계 입력은 무변경, 다른 길이(예: 7)는 손대지 않아 스키마가 거절.
  assert.equal((mergeLegacyTiers([[], [], [], [], []]) as unknown[]).length, 5);
  assert.equal(
    roleConfigSchema.safeParse({ ...legacy, boss: { ...legacy.boss, reactions: tiers10("x", 1).slice(0, 7) } }).success,
    false,
  );
  // 미지 롤 키는 정규화가 건드리지 않아 strict 가 거절(API 경계).
  assert.equal(roleConfigSchema.safeParse({ ...ROLE_CONFIG_DEFAULT, intern: ROLE_CONFIG_DEFAULT.boss }).success, false);
  // 코드 기본값 자체가 스키마를 통과한다.
  assert.equal(roleConfigSchema.safeParse(ROLE_CONFIG_DEFAULT).success, true);
});
