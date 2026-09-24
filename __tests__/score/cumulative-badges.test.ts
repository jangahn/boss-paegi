import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { buildGameplayStats } = await import("../../lib/stats.ts");
const { BADGE_CATALOG_DEFAULT, FAMILY_BASIS, evaluateBadges, familyValue, gamePlayMs } = await import(
  "../../lib/config/domains/badges.ts"
);
const { PLAY_TOTALS_ZERO, parsePlayTotals } = await import("../../lib/play-totals.ts");
const { resolvePlayTotalsRead } = await import("../../lib/badge-owned.ts");

function game(options: { hits?: number; ults?: number; durationMs?: number; playMs?: number } = {}) {
  const hits = options.hits ?? 10;
  return buildGameplayStats({
    hitCount: hits,
    maxCombo: 1,
    durationMs: options.durationMs ?? 30_000,
    weaponCounts: { fist: hits },
    weaponScores: { fist: 0 },
    ultScore: 0,
    ultimateCount: options.ults ?? 0,
    firstHitMs: 0,
    bgVisits: [],
    intervalCV: null,
    timeLimit:
      options.playMs === undefined
        ? undefined
        : { playMs: options.playMs, timeBaseMs: 60_000, timeCapMs: 120_000, timeBonusMs: 0, timeBonusCount: 0 },
  });
}

test("v1.55 기준: 타격 · 궁극기 · 플레이 = 누적, 점수 · 콤보 · 무기 · 맵 = 한 판, 유형 = 유형 판정", () => {
  assert.deepEqual(
    Object.entries(FAMILY_BASIS).filter(([, basis]) => basis === "cumulative").map(([key]) => key).sort(),
    ["hits", "time", "ult"],
  );
  assert.deepEqual(
    Object.entries(FAMILY_BASIS).filter(([, basis]) => basis === "game").map(([key]) => key).sort(),
    ["combo", "map", "score", "weapon"],
  );
  assert.equal(FAMILY_BASIS.persona, "persona");
  for (const family of BADGE_CATALOG_DEFAULT.families) assert.ok(family.key in FAMILY_BASIS, family.key);
});

test("누적 달성값 = 이전 합계 + 이 판, 한 판 카테고리는 합계를 보지 않는다", () => {
  const totals = { hits: 1_100, ultimates: 4, playMs: 50_000 };
  const stats = game({ hits: 150, ults: 1, playMs: 15_000 });
  assert.equal(familyValue("hits", stats, 999, totals), 1_250);
  assert.equal(familyValue("ult", stats, 999, totals), 5);
  assert.equal(familyValue("time", stats, 999, totals), 65_000 / 60_000);
  assert.equal(familyValue("score", stats, 999, totals), 999);
  assert.equal(familyValue("hits", stats, 999, PLAY_TOTALS_ZERO), 150);

  const earned = evaluateBadges(stats, 999, BADGE_CATALOG_DEFAULT, totals);
  for (const slug of ["hits_150", "hits_400", "hits_700", "hits_1200", "ult_1", "ult_2", "ult_3", "ult_5", "time_1"]) {
    assert.ok(earned.includes(slug), slug);
  }
  for (const slug of ["hits_2500", "ult_10", "time_2", "score_1000"]) assert.ok(!earned.includes(slug), slug);
  // 합계를 모르는 표시 폴백(0)은 이 판 값만 — 한 판 기준으로 딴 뱃지는 누적에서도 그대로
  const alone = evaluateBadges(stats, 999, BADGE_CATALOG_DEFAULT, PLAY_TOTALS_ZERO);
  assert.ok(alone.includes("hits_150") && alone.includes("ult_1"));
  assert.ok(!alone.includes("hits_400") && !alone.includes("time_1"));
});

test("플레이 시간: 제한 시간 판은 playMs(첫 타격부터, 멈춘 구간 제외), 그 전 판은 소요 시간 — 0132 합계와 같은 규칙", () => {
  assert.equal(gamePlayMs(game({ durationMs: 90_000, playMs: 61_000 })), 61_000);
  assert.equal(gamePlayMs(game({ durationMs: 90_000 })), 90_000);
  const sql = readFileSync(new URL("../../supabase/migrations/0132_play_totals.sql", import.meta.url), "utf8");
  assert.match(sql, /coalesce\(\(st\.gameplay_stats ->> 'playMs'\)::numeric, s\.duration_ms::numeric\)/);
  assert.match(sql, /review_status in \('registered', 'cleared'\)/);
});

test("누적 문구: 코드 기본 라벨 · 설명이 누적 기준을 말한다(발행본이 정본)", () => {
  const bySlug = new Map(BADGE_CATALOG_DEFAULT.badges.map((b) => [b.slug, b]));
  assert.equal(bySlug.get("hits_1200")?.label, "누적 1,200타");
  assert.equal(bySlug.get("hits_1200")?.desc, "모든 판 합계 1,200타 (궁극기 제외)");
  assert.equal(bySlug.get("ult_5")?.label, "누적 궁극기 5회");
  assert.equal(bySlug.get("ult_5")?.desc, "모든 판 합계 궁극기 5회 발동");
  assert.equal(bySlug.get("time_10")?.label, "누적 10분");
  assert.equal(bySlug.get("time_10")?.desc, "모든 판 합계 10분 플레이 (일시정지 제외)");
});

test("합계 RPC 응답 검증: 한 행의 음이 아닌 정수 셋만, 그 외는 null(서버 재시도, 도전 중지)", () => {
  assert.deepEqual(parsePlayTotals([{ hits: 3, ultimates: 1, play_ms: 61_000 }]), { hits: 3, ultimates: 1, playMs: 61_000 });
  assert.deepEqual(parsePlayTotals([{ hits: 0, ultimates: 0, play_ms: 0 }]), PLAY_TOTALS_ZERO);
  for (const bad of [
    [],
    null,
    [{ hits: 3, ultimates: 1 }],
    [{ hits: "3", ultimates: 1, play_ms: 0 }],
    [{ hits: -1, ultimates: 1, play_ms: 0 }],
    [{ hits: 1.5, ultimates: 1, play_ms: 0 }],
    [{ hits: 1, ultimates: 1, play_ms: 0 }, { hits: 1, ultimates: 1, play_ms: 0 }],
  ]) {
    assert.equal(parsePlayTotals(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(resolvePlayTotalsRead({ data: [{ hits: 1, ultimates: 0, play_ms: 5 }], error: null }), { hits: 1, ultimates: 0, playMs: 5 });
  assert.throws(() => resolvePlayTotalsRead({ data: null, error: { message: "boom" } }));
  assert.throws(() => resolvePlayTotalsRead({ data: [], error: null }));
});

test("부여 계약: 서버는 이 판을 뺀 이전 합계로 평가하고 합계를 모르면 리포트 재시도, 도전과 종료 화면은 판 시작 합계를 공유", () => {
  const route = readFileSync(new URL("../../app/api/score/route.ts", import.meta.url), "utf8");
  assert.match(route, /admin\.rpc\("get_play_totals", \{ p_owner: user\.id, p_exclude_score: scoreId \}\)/);
  assert.match(route, /if \(!priorTotals\) throw new Error\("score_play_totals_invalid"\)/);
  assert.match(route, /evaluateBadges\(canonicalStats, score, catalog, priorTotals\)/);
  const hook = readFileSync(new URL("../../app/play/useBadgeChallenge.ts", import.meta.url), "utf8");
  assert.match(hook, /rpc\("get_my_play_totals"\)/);
  assert.match(hook, /totals = resolvePlayTotalsRead\(totalsResult\)/);
  const page = readFileSync(new URL("../../app/play/page.tsx", import.meta.url), "utf8");
  assert.match(page, /playTotals=\{playTotals\}/);
  const modal = readFileSync(new URL("../../components/GameOverModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /evaluateBadges\(gameplayStats, score, badgeCatalog, playTotals \?\? PLAY_TOTALS_ZERO\)/);
  assert.match(modal, /new Set\(\[\.\.\.earnedBadges, \.\.\.newBadges\]\)/);
});
