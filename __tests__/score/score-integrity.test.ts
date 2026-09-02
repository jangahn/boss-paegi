import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  isMissingCommitScoreReportRpcError,
  isMissingSubmitterBindingSchemaError,
  legacyTelemetryScoreSubmissionId,
  ownsTelemetrySession,
  parseScoreReportRpcResult,
  parseScoreSubmissionRpcResult,
  readOptionalScorePercentile,
  scoreSubmissionFingerprint,
  telemetrySubmitterBinding,
} = await import("../../lib/score-submission.ts");
const {
  requireSupabaseSuccess,
  SupabaseOperationError,
} = await import("../../lib/supabase-operation.ts");
const {
  ANTI_ABUSE_RULES_VERSION,
  S2_MARGIN,
  S2_MIN_HITS,
  evaluateSubmission,
  maxUltimateUsesForHits,
} = await import("../../lib/anti-abuse-rules.ts");
const { buildGameplayStats, validateGameplayStats } = await import(
  "../../lib/stats.ts"
);
const {
  FRESH_WEAPON_BONUS,
  GRAB_FLING_POWER_BONUS,
  PINCH_STRETCH_BONUS,
  SWITCH_ULT_BONUS_RATIO,
  THROW_FACTOR_MAX,
  SWIPE_FACTOR_MAX,
  WEAPONS,
} = {
  ...(await import("../../lib/game-tuning.ts")),
  ...(await import("../../lib/weapons.ts")),
};
const { MAX_COMBO_MULTIPLIER } = await import(
  "../../lib/score-limits.ts"
);
const {
  SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS,
  elapsedScoreDurationMs,
  isScoreSubmissionId,
  scoreSubmissionIdentityForGame,
  scoreSubmissionRetryDelayMs,
} = await import("../../lib/score-retry.ts");
const { isLegacyScoreDetailSchemaError } = await import(
  "../../lib/score-detail.ts"
);
const { isVisibleReviewStatus } = await import(
  "../../lib/score-visibility.ts"
);
const {
  InvalidStrictConfigError,
  resolveStrictSettingResult,
} = await import("../../lib/config/get.ts");
const { z } = await import("zod");

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000001";
const BINDING =
  "bad7313391508e4129c338752b2cc8094d16dff2c1ff59d93aa4402ce632bfc9";

test("public score visibility fails closed for every absent or unknown status", () => {
  for (const status of ["registered", "pending", "cleared", "voided", null, undefined, ""]) {
    assert.equal(
      isVisibleReviewStatus(status),
      status === "registered" || status === "cleared",
      String(status),
    );
  }
});

test("session binding is canonical and byte-identical to the SQL golden vector", () => {
  assert.equal(telemetrySubmitterBinding(SESSION, USER_B), BINDING);
  assert.equal(
    telemetrySubmitterBinding(SESSION.toUpperCase(), USER_B.toUpperCase()),
    BINDING,
  );
  assert.equal(telemetrySubmitterBinding("not-a-uuid", USER_B), null);
  assert.equal(telemetrySubmitterBinding(SESSION, "not-a-uuid"), null);
});

test("legacy cached clients derive one canonical RFC 4122 key only from stable telemetry", () => {
  const derived = legacyTelemetryScoreSubmissionId(USER_A, SESSION);
  assert.equal(derived, "ee91c536-20c5-51d6-9f78-90c2a342cd1c");
  assert.equal(
    legacyTelemetryScoreSubmissionId(USER_A.toUpperCase(), SESSION.toUpperCase()),
    derived,
  );
  assert.equal(isScoreSubmissionId(derived), true);
  assert.notEqual(
    legacyTelemetryScoreSubmissionId(USER_B, SESSION),
    derived,
  );
  assert.equal(legacyTelemetryScoreSubmissionId(USER_A, null), null);
  assert.equal(legacyTelemetryScoreSubmissionId(USER_A, "not-a-uuid"), null);
  assert.equal(legacyTelemetryScoreSubmissionId("not-a-uuid", SESSION), null);
});

test("member/anonymous telemetry ownership state matrix has exactly one accepting shape each", () => {
  for (const isMember of [false, true]) {
    for (const isAnon of [false, true]) {
      for (const ownerId of [null, USER_A, USER_B]) {
        for (const binding of [
          null,
          telemetrySubmitterBinding(SESSION, USER_A),
          telemetrySubmitterBinding(SESSION, USER_B),
        ]) {
          const actual = ownsTelemetrySession(
            {
              owner_id: ownerId,
              is_anon: isAnon,
              submitter_binding: binding,
            },
            USER_A,
            isMember,
            SESSION,
          );
          const expected = isMember
            ? !isAnon &&
              ownerId === USER_A &&
              binding === telemetrySubmitterBinding(SESSION, USER_A)
            : isAnon &&
              ownerId === null &&
              binding === telemetrySubmitterBinding(SESSION, USER_A);
          assert.equal(
            actual,
            expected,
            JSON.stringify({ isMember, isAnon, ownerId, binding }),
          );
        }
      }
    }
  }
});

test("only the additive submitter_binding schema errors activate rollout fallback", () => {
  for (const error of [
    { code: "42703", message: "undefined column" },
    {
      code: "PGRST204",
      message: "Could not find submitter_binding in the schema cache",
    },
    {
      code: "other",
      message: 'column "submitter_binding" does not exist',
    },
  ]) {
    assert.equal(isMissingSubmitterBindingSchemaError(error), true);
  }
  for (const error of [
    { code: "42501", message: "permission denied" },
    { code: "PGRST301", message: "JWT expired" },
    { code: "", message: "network failure" },
  ]) {
    assert.equal(isMissingSubmitterBindingSchemaError(error), false);
  }
});

test("only a genuinely missing commit_score_report RPC activates legacy rollout", () => {
  for (const error of [
    {
      code: "PGRST202",
      message:
        "Could not find the function public.commit_score_report in the schema cache",
    },
    {
      code: "42883",
      message: "function public.commit_score_report(...) does not exist",
    },
  ]) {
    assert.equal(isMissingCommitScoreReportRpcError(error), true);
  }
  for (const error of [
    { code: "42501", message: "permission denied for commit_score_report" },
    { code: "57014", message: "commit_score_report statement timeout" },
    { code: "PGRST202", message: "another_function is absent" },
  ]) {
    assert.equal(isMissingCommitScoreReportRpcError(error), false);
  }
});

test("score detail falls back only for additive relation/column schema drift", () => {
  for (const error of [
    { code: "42703", message: 'column "review_status" does not exist' },
    {
      code: "PGRST200",
      message: "Could not find a relationship between scores and score_stats",
    },
    {
      code: "PGRST204",
      message: "Could not find the max_combo column in the schema cache",
    },
  ]) {
    assert.equal(isLegacyScoreDetailSchemaError(error), true);
  }
  for (const error of [
    { code: "42501", message: "permission denied for score_stats" },
    { code: "PGRST301", message: "JWT expired" },
    { code: "XX000", message: "network unavailable" },
    { code: "42703", message: "unrelated_missing_column" },
  ]) {
    assert.equal(isLegacyScoreDetailSchemaError(error), false);
  }
});

test("score best-effort calls surface both resolved and thrown dependency errors", async () => {
  for (const injected of [
    async () => ({ data: null, error: { code: "XX001", message: "resolved" } }),
    async () => {
      throw new Error("thrown");
    },
  ]) {
    await assert.rejects(
      requireSupabaseSuccess("score.injected", injected),
      (error: unknown) => {
        assert.ok(error instanceof SupabaseOperationError);
        assert.equal(error.operation, "score.injected");
        return true;
      },
    );
  }
});

test("immutable report config defaults only on no-row and fails closed on DB/validation errors", () => {
  const schema = z.object({ enabled: z.boolean() });
  const fallback = { enabled: false };
  assert.equal(
    resolveStrictSettingResult("badge_catalog", schema, fallback, {
      data: null,
      error: null,
    }),
    fallback,
  );
  assert.deepEqual(
    resolveStrictSettingResult("badge_catalog", schema, fallback, {
      data: { value: { enabled: true }, version: 1 },
      error: null,
    }),
    { enabled: true },
  );
  assert.throws(
    () =>
      resolveStrictSettingResult("badge_catalog", schema, fallback, {
        data: null,
        error: { code: "XX001", message: "resolved failure" },
      }),
    SupabaseOperationError,
  );
  assert.throws(
    () =>
      resolveStrictSettingResult("badge_catalog", schema, fallback, {
        data: { value: { enabled: "yes" }, version: 2 },
        error: null,
      }),
    InvalidStrictConfigError,
  );
});

test("score submit/report RPC responses reject every partial or malformed success", () => {
  const scoreId = "00000000-0000-4000-8000-000000000010";
  assert.deepEqual(
    parseScoreSubmissionRpcResult({
      scoreId,
      reviewStatus: "registered",
      duplicate: false,
    }),
    { scoreId, reviewStatus: "registered", duplicate: false },
  );
  for (const malformed of [
    null,
    {},
    { scoreId, reviewStatus: "registered" },
    { scoreId: "bad", reviewStatus: "registered", duplicate: false },
    { scoreId, reviewStatus: "unknown", duplicate: false },
    { scoreId, reviewStatus: "registered", duplicate: 0 },
  ]) {
    assert.equal(parseScoreSubmissionRpcResult(malformed), null);
  }

  const report = {
    personaId: "steady",
    percentile: 50,
    newBadges: ["score_1"],
    collectedCount: 1,
  };
  assert.deepEqual(parseScoreReportRpcResult(report), report);
  for (const malformed of [
    null,
    {},
    { ...report, personaId: null },
    { ...report, percentile: 50.5 },
    { ...report, percentile: 101 },
    { ...report, newBadges: ["score_1", "score_1"] },
    { ...report, newBadges: [1] },
    { ...report, collectedCount: -1 },
    { ...report, collectedCount: 1.5 },
  ]) {
    assert.equal(parseScoreReportRpcResult(malformed), null);
  }
});

test("percentile failure intentionally snapshots null while valid 1..100 values survive", async () => {
  assert.deepEqual(
    await readOptionalScorePercentile(async () => ({
      data: 42,
      error: null,
    })),
    { value: 42, error: null },
  );
  for (const data of [null, "42", 0, 42.5, 101, Number.NaN]) {
    assert.deepEqual(
      await readOptionalScorePercentile(async () => ({ data, error: null })),
      { value: null, error: null },
    );
  }
  const resolvedError = { code: "XX001", message: "resolved" };
  assert.deepEqual(
    await readOptionalScorePercentile(async () => ({
      data: 42,
      error: resolvedError,
    })),
    { value: null, error: resolvedError },
  );
  const thrown = new Error("network");
  assert.deepEqual(
    await readOptionalScorePercentile(async () => {
      throw thrown;
    }),
    { value: null, error: thrown },
  );
});

test("score convergence retry is bounded exponential with manual handoff", () => {
  assert.equal(SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS, 4);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) =>
      scoreSubmissionRetryDelayMs(index),
    ),
    [null, 1_000, 2_000, 4_000, null, null],
  );
});

test("score duration keeps the valid startedAt=0 boundary and rejects every invalid ordering", () => {
  assert.equal(elapsedScoreDurationMs(0, 1), 1);
  assert.equal(elapsedScoreDurationMs(0, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const [startedAt, endedAt] of [
    [0, null],
    [0, 0],
    [1, 0],
    [Number.NaN, 1],
    [0, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [0, Number.POSITIVE_INFINITY],
  ] as const) {
    assert.equal(elapsedScoreDurationMs(startedAt, endedAt), 0);
  }
});

test("route and migration share the exact RFC 4122 submission UUID domain", () => {
  for (const version of ["1", "2", "3", "4", "5"]) {
    for (const variant of ["8", "9", "a", "b"]) {
      assert.equal(
        isScoreSubmissionId(
          `00000000-0000-${version}000-${variant}000-000000000001`,
        ),
        true,
      );
    }
  }
  for (const invalid of [
    "00000000-0000-0000-8000-000000000001",
    "00000000-0000-6000-8000-000000000001",
    "00000000-0000-4000-7000-000000000001",
    "00000000-0000-4000-c000-000000000001",
    "not-a-uuid",
  ]) {
    assert.equal(isScoreSubmissionId(invalid), false);
  }
  assert.equal(
    isScoreSubmissionId("AAAAAAAA-AAAA-4AAA-BAAA-AAAAAAAAAAAA"),
    true,
  );
});

test("per-game submission identity is stable across retries and rotates once for a new game", () => {
  let minted = 0;
  const mint = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, "0")}`;
  const first = scoreSubmissionIdentityForGame(null, 100, mint);
  const retry = scoreSubmissionIdentityForGame(first, 100, mint);
  const nextGame = scoreSubmissionIdentityForGame(retry, 200, mint);
  const sameTimestampNewOpen = scoreSubmissionIdentityForGame(
    nextGame,
    200,
    mint,
    true,
  );
  assert.equal(retry, first);
  assert.equal(retry.submissionId, first.submissionId);
  assert.notEqual(nextGame.submissionId, first.submissionId);
  assert.notEqual(sameTimestampNewOpen.submissionId, nextGame.submissionId);
  assert.equal(minted, 3);
});

test("submission fingerprint is key-order canonical and binds requested links/stats", () => {
  const base = {
    dollId: null,
    score: 100,
    weapon: "fist",
    durationMs: 1_000,
    maxCombo: 1,
    endReason: "normal",
    telemetrySessionId: null,
    gameplayStats: {
      version: 2,
      hitCount: 1,
      weaponCounts: { fist: 1 },
      weaponScores: { fist: 100 },
    },
  };
  const reordered = {
    ...base,
    gameplayStats: {
      weaponScores: { fist: 100 },
      weaponCounts: { fist: 1 },
      hitCount: 1,
      version: 2,
    },
  };
  const fingerprint = scoreSubmissionFingerprint(base);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(scoreSubmissionFingerprint(reordered), fingerprint);
  assert.notEqual(
    scoreSubmissionFingerprint({
      ...base,
      gameplayStats: { ...base.gameplayStats, hitCount: 2 },
    }),
    fingerprint,
  );
  assert.notEqual(
    scoreSubmissionFingerprint({ ...base, telemetrySessionId: SESSION }),
    fingerprint,
  );
  assert.notEqual(
    scoreSubmissionFingerprint({ ...base, dollId: USER_B }),
    fingerprint,
  );
});

function statsFor(
  weaponKey: string,
  count: number,
  weaponScore: number,
  opts: { ultScore?: number; ultimateCount?: number } = {},
) {
  const ultScore = opts.ultScore ?? 0;
  return buildGameplayStats({
    hitCount: count,
    maxCombo: count,
    durationMs: Math.max(1_000, count * 1_000),
    weaponCounts: count === 0 ? {} : { [weaponKey]: count },
    weaponScores: count === 0 ? {} : { [weaponKey]: weaponScore },
    ultScore,
    ultimateCount: opts.ultimateCount ?? 0,
    firstHitMs: count === 0 ? null : 100,
    bgVisits: ["office"],
    intervalCV: null,
  });
}

test("v2 stats require exact, known, integer weapon-key and score conservation", () => {
  const valid = statsFor("fist", 3, 336);
  assert.equal(validateGameplayStats(valid, 336), true);

  const mutations = [
    { ...valid, hitCount: 4 },
    { ...valid, maxCombo: 4 },
    { ...valid, durationMs: 0 },
    { ...valid, weaponCounts: { fist: 2.5 } },
    {
      ...valid,
      weaponCounts: { fist: 3 },
      weaponScores: { hammer: 336 },
    },
    {
      ...valid,
      weaponCounts: { unknown: 3 },
      weaponScores: { unknown: 336 },
    },
    { ...valid, weaponScores: { fist: 335 } },
    { ...valid, weaponScores: { fist: Number.MAX_SAFE_INTEGER } },
  ];
  for (const mutated of mutations) {
    assert.equal(
      validateGameplayStats(mutated, 336),
      false,
      JSON.stringify(mutated),
    );
  }
});

function effectiveMaxBase(weapon: (typeof WEAPONS)[number]): number {
  if (weapon.category === "swipe") {
    return Math.round(weapon.strength * SWIPE_FACTOR_MAX);
  }
  if (weapon.category === "throw") {
    return Math.round(weapon.strength * THROW_FACTOR_MAX);
  }
  if (weapon.category === "grab") {
    return weapon.strength + GRAB_FLING_POWER_BONUS;
  }
  if (weapon.category === "pinch") {
    return weapon.strength + PINCH_STRETCH_BONUS;
  }
  return weapon.strength;
}

test("S2 checks every 1..19-hit weapon payload instead of leaving the old split bypass", () => {
  assert.equal(S2_MIN_HITS, 1);
  assert.match(ANTI_ABUSE_RULES_VERSION, /v8$/);

  for (const weapon of WEAPONS) {
    const perHitCap =
      effectiveMaxBase(weapon) * MAX_COMBO_MULTIPLIER * 2;
    for (let count = 1; count < 20; count += 1) {
      const physicalMax =
        FRESH_WEAPON_BONUS + count * perHitCap;
      const clean = statsFor(weapon.key, count, physicalMax);
      const cleanDecision = evaluateSubmission({
        score: physicalMax,
        durationMs: clean.durationMs,
        telemetrySessionId: SESSION,
        stats: clean,
        telemetry: null,
        isBanned: false,
      });
      assert.equal(
        cleanDecision.signals.some((signal) =>
          signal.id.startsWith("S2_WEAPON_AVG:"),
        ),
        false,
        `${weapon.key}/${count} physical max`,
      );

      const impossiblePerHit = Math.floor(perHitCap * S2_MARGIN) + 1;
      const impossibleScore =
        FRESH_WEAPON_BONUS + count * impossiblePerHit;
      const impossible = statsFor(
        weapon.key,
        count,
        impossibleScore,
      );
      const decision = evaluateSubmission({
        score: impossibleScore,
        durationMs: impossible.durationMs,
        telemetrySessionId: SESSION,
        stats: impossible,
        telemetry: null,
        isBanned: false,
      });
      assert.ok(
        decision.signals.some(
          (signal) => signal.id === `S2_WEAPON_AVG:${weapon.key}`,
        ),
        `${weapon.key}/${count}`,
      );
    }
  }
});

test("ultimate-count bound matches the exact maximal gauge envelope for 0..1000 hits", () => {
  for (let hits = 0; hits <= 1_000; hits += 1) {
    const progress =
      hits === 0
        ? 0
        : hits / 100 + (hits - 1) * SWITCH_ULT_BONUS_RATIO;
    assert.equal(
      maxUltimateUsesForHits(hits),
      Math.floor(progress + Number.EPSILON * hits),
      `hits=${hits}`,
    );
  }
});

test("one ultimate beyond the mathematical hit envelope is always flagged", () => {
  for (let hits = 0; hits <= 300; hits += 1) {
    const manualScore =
      hits === 0 ? 0 : FRESH_WEAPON_BONUS + hits * 12;
    const stats = statsFor("fist", hits, manualScore, {
      ultimateCount: maxUltimateUsesForHits(hits) + 1,
    });
    const decision = evaluateSubmission({
      score: manualScore,
      durationMs: stats.durationMs,
      telemetrySessionId: SESSION,
      stats,
      telemetry: null,
      isBanned: false,
    });
    assert.ok(
      decision.signals.some((signal) => signal.id === "S10_ULT_COUNT"),
      `hits=${hits}`,
    );
  }
});
