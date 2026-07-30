import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  PLAYER_GRADES,
  TIER_COUNT,
  TIER_STEP,
  bossReaction,
  dollDepartment,
  dollRank,
  dollTrait,
  formatDuration,
  gradeFor,
  reportNo,
  scoreTier,
  timeAgo,
} = await import("../../lib/report.ts");
const {
  DEFAULT_ROLE,
  ROLE_IDS,
  asRole,
  getRoleContent,
  isRoleId,
  josaEul,
  josaEun,
  josaEuro,
} = await import("../../lib/roles/index.ts");

test("score tier is total, monotone, and exact for every integer through the cap", () => {
  let previous = 0;
  for (let score = -1; score <= TIER_STEP * (TIER_COUNT + 1); score += 1) {
    const expected =
      score <= 0
        ? 0
        : Math.min(TIER_COUNT - 1, Math.floor(score / TIER_STEP));
    const tier = scoreTier(score);
    assert.equal(tier, expected, `score=${score}`);
    assert.ok(tier >= previous, `score=${score}`);
    previous = tier;
  }
  for (const invalid of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(scoreTier(invalid), 0);
  }
});

test("every role, tier, and representative seed selects deterministic catalog content", () => {
  const seeds = ["", "0", "a", "한글", "\u0000", "ffffffff-ffff-ffff-ffff-ffffffffffff"];
  for (const role of ROLE_IDS) {
    const content = getRoleContent(role);
    for (let tier = 0; tier < TIER_COUNT; tier += 1) {
      const score = tier * TIER_STEP;
      assert.equal(gradeFor(score), PLAYER_GRADES[tier]);
      for (const seed of seeds) {
        const first = bossReaction(score, seed, role);
        assert.equal(bossReaction(score, seed, role), first);
        assert.ok(content.reactions[tier].includes(first));
      }
    }
    for (const seed of seeds) {
      assert.ok(content.traits.includes(dollTrait(seed, role)));
      assert.ok(content.ranks.includes(dollRank(seed, role)));
      assert.ok(content.departments.includes(dollDepartment(seed, role)));
    }
  }
});

test("duration and relative-time formatters close invalid and exact unit boundaries", () => {
  for (const [milliseconds, expected] of [
    [0, "0초"],
    [499, "0초"],
    [500, "1초"],
    [59_499, "59초"],
    [59_500, "1분 0초"],
    [60_500, "1분 1초"],
  ] as const) {
    assert.equal(formatDuration(milliseconds), expected);
  }
  for (const invalid of [-1, Number.NaN, Infinity, -Infinity]) {
    assert.equal(formatDuration(invalid), "—");
  }

  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-30T12:00:00.000Z");
  try {
    assert.equal(timeAgo("not-a-date"), "—");
    assert.equal(timeAgo("2026-07-30T12:00:01.000Z"), "방금");
    assert.equal(timeAgo("2026-07-30T11:59:01.000Z"), "방금");
    assert.equal(timeAgo("2026-07-30T11:59:00.000Z"), "1분 전");
    assert.equal(timeAgo("2026-07-30T11:00:00.000Z"), "1시간 전");
    assert.equal(timeAgo("2026-07-29T12:00:00.000Z"), "1일 전");
  } finally {
    Date.now = originalNow;
  }
});

test("report number uses KST identically on both sides of the UTC midnight boundary", () => {
  const id = "abcd1234-1111-4111-8111-111111111111";
  assert.equal(
    reportNo(id, "2026-07-29T14:59:59.999Z"),
    "제20260729-ABCD호",
  );
  assert.equal(
    reportNo(id, "2026-07-29T15:00:00.000Z"),
    "제20260730-ABCD호",
  );
  assert.equal(
    reportNo(id, new Date("2026-12-31T15:00:00.000Z")),
    "제20270101-ABCD호",
  );
  assert.equal(reportNo(id, "not-a-date"), "문서번호 확인 불가");
});

test("Korean particles are exact for every precomposed Hangul syllable", () => {
  for (let code = 0xac00; code <= 0xd7a3; code += 1) {
    const syllable = String.fromCharCode(code);
    const jong = (code - 0xac00) % 28;
    assert.equal(josaEul(syllable), jong === 0 ? "를" : "을", syllable);
    assert.equal(josaEun(syllable), jong === 0 ? "는" : "은", syllable);
    assert.equal(
      josaEuro(syllable),
      jong === 0 || jong === 8 ? "로" : "으로",
      syllable,
    );
  }
  for (const nonHangul of ["", "A", "1", "🙂"]) {
    assert.equal(josaEul(nonHangul), "를");
    assert.equal(josaEun(nonHangul), "는");
    assert.equal(josaEuro(nonHangul), "로");
  }
});

test("role read and write normalization exhausts the finite role registry", () => {
  for (const role of ROLE_IDS) {
    assert.equal(asRole(role), role);
    assert.equal(isRoleId(role), true);
    assert.ok(getRoleContent(role).reactions.length === TIER_COUNT);
  }
  for (const invalid of [
    null,
    undefined,
    "",
    "Boss",
    " boss",
    "intern",
    0,
    false,
    {},
  ]) {
    assert.equal(asRole(invalid), DEFAULT_ROLE);
    assert.equal(isRoleId(invalid), false);
    assert.equal(
      getRoleContent(invalid as (typeof ROLE_IDS)[number]),
      getRoleContent(DEFAULT_ROLE),
    );
  }
});
