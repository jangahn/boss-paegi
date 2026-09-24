import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  TIME_LIMIT_SECONDS_DEFAULT,
  activePlayMs,
  formatRemaining,
  formatSecondsKo,
  grantedBonusMs,
  playSecondsAfterUltimates,
  reachedMaxPlay,
  remainingMs,
  timeLimitConfigFromSeconds,
  ultimatesToMaxPlay,
} = await import("../../lib/time-limit.ts");
const { selectPlayMs, selectRemainingMs, useGameStore } = await import("../../store/gameStore.ts");
const { SESSION_LIMITS_DEFAULT, sessionLimitsSchema } = await import("../../lib/config/domains/session.ts");
const { buildGameplayStats, validateGameplayStats, validTimeLimitStats } = await import("../../lib/stats.ts");

test("사용자 확정 기본값 — 기본 60초 · 최대 120초 · 궁극기 +10초", () => {
  assert.deepEqual(TIME_LIMIT_SECONDS_DEFAULT, { baseSeconds: 60, maxPlaySeconds: 120, ultimateBonusSeconds: 10 });
  assert.deepEqual(SESSION_LIMITS_DEFAULT.timeLimit, TIME_LIMIT_SECONDS_DEFAULT);
  assert.deepEqual(timeLimitConfigFromSeconds(TIME_LIMIT_SECONDS_DEFAULT), {
    baseMs: 60_000,
    maxPlayMs: 120_000,
    ultimateBonusMs: 10_000,
  });
});

test("추가 시간은 최대 플레이 시간을 넘는 몫이 잘린다", () => {
  assert.equal(grantedBonusMs(60_000, 10_000, 120_000), 10_000);
  assert.equal(grantedBonusMs(115_000, 10_000, 120_000), 5_000);
  assert.equal(grantedBonusMs(120_000, 10_000, 120_000), 0);
  assert.equal(grantedBonusMs(60_000, 0, 120_000), 0);
  // 최대 플레이 시간 = 기본 시간이면 늘릴 여지가 없다
  assert.equal(grantedBonusMs(60_000, 10_000, 60_000), 0);
});

test("활성 시계 — 멈춘 구간은 흐르지 않고 남은 시간은 0 아래로 내려가지 않는다", () => {
  assert.equal(activePlayMs({ accumMs: 5_000, runningSince: null }, 99_999), 5_000);
  assert.equal(activePlayMs({ accumMs: 5_000, runningSince: 1_000 }, 3_500), 7_500);
  assert.equal(remainingMs(60_000, 61_000), 0);
  assert.equal(remainingMs(60_000, 12_000), 48_000);
});

test("남은 시간 표시 — 초 올림, 항상 초 숫자", () => {
  assert.equal(formatRemaining(60_000), "60");
  assert.equal(formatRemaining(59_001), "60");
  assert.equal(formatRemaining(59_000), "59");
  assert.equal(formatRemaining(120_000), "120");
  assert.equal(formatRemaining(0), "0");
  assert.equal(formatRemaining(-5), "0");
  assert.equal(formatSecondsKo(120), "2분");
  assert.equal(formatSecondsKo(90), "1분 30초");
  assert.equal(formatSecondsKo(45), "45초");
});

test("어드민 미리보기 — 궁극기 횟수별 판 길이와 최대 도달 횟수", () => {
  assert.equal(playSecondsAfterUltimates(TIME_LIMIT_SECONDS_DEFAULT, 0), 60);
  assert.equal(playSecondsAfterUltimates(TIME_LIMIT_SECONDS_DEFAULT, 1), 70);
  assert.equal(playSecondsAfterUltimates(TIME_LIMIT_SECONDS_DEFAULT, 9), 120);
  assert.equal(ultimatesToMaxPlay(TIME_LIMIT_SECONDS_DEFAULT), 6);
  assert.equal(ultimatesToMaxPlay({ baseSeconds: 60, maxPlaySeconds: 60, ultimateBonusSeconds: 10 }), null);
  assert.equal(ultimatesToMaxPlay({ baseSeconds: 60, maxPlaySeconds: 120, ultimateBonusSeconds: 0 }), null);
});

test("최대 플레이 시간까지 늘렸는가(연장근무 판정 입력)", () => {
  assert.equal(reachedMaxPlay({ timeBaseMs: 60_000, timeCapMs: 120_000, timeBonusMs: 60_000 }), true);
  assert.equal(reachedMaxPlay({ timeBaseMs: 60_000, timeCapMs: 120_000, timeBonusMs: 50_000 }), false);
  // 늘릴 여지가 없는 설정·구 판(필드 없음)은 아님
  assert.equal(reachedMaxPlay({ timeBaseMs: 60_000, timeCapMs: 60_000, timeBonusMs: 0 }), false);
  assert.equal(reachedMaxPlay({}), false);
});

test("스토어 — 첫 타격부터 흐르고, 멈춤 동안 정지, 궁극기 추가 시간은 최대에서 잘리고, 종료로 얼어붙는다", (t) => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const store = useGameStore;
  store.getState().setClockPaused(false);
  store.getState().configureTimeLimit(timeLimitConfigFromSeconds(TIME_LIMIT_SECONDS_DEFAULT));
  store.getState().start();

  now = 5_000; // 첫 타격 전에는 흐르지 않는다
  assert.equal(selectRemainingMs(store.getState(), now), 60_000);
  store.getState().hit(12, "fist");
  assert.equal(store.getState().clockStarted, true);
  now = 15_000;
  assert.equal(selectPlayMs(store.getState(), now), 10_000);

  store.getState().setClockPaused(true); // 탭 숨김 20초
  now = 35_000;
  assert.equal(selectPlayMs(store.getState(), now), 10_000);
  store.getState().setClockPaused(false);
  now = 40_000;
  assert.equal(selectPlayMs(store.getState(), now), 15_000);
  assert.equal(selectRemainingMs(store.getState(), now), 45_000);

  // 궁극기 6회로 +60초 → 최대 120초, 7번째는 0초(최대 시간)
  for (let i = 0; i < 6; i += 1) store.getState().consumeUlt();
  assert.equal(store.getState().timeBudgetMs, 120_000);
  assert.equal(store.getState().timeBonusMs, 60_000);
  assert.equal(store.getState().timeBonusCount, 6);
  store.getState().consumeUlt();
  assert.equal(store.getState().timeBudgetMs, 120_000);
  assert.equal(store.getState().timeBonusCount, 6);
  assert.equal(store.getState().lastTimeBonus?.amount, 0);

  store.getState().end();
  now = 90_000;
  assert.equal(selectPlayMs(store.getState(), now), 15_000);

  // 재시작은 시계·추가 시간을 비우고 설정은 유지
  store.getState().start();
  assert.equal(store.getState().clockStarted, false);
  assert.equal(store.getState().timeBudgetMs, 60_000);
  assert.equal(store.getState().timeBonusMs, 0);
});

test("멈춘 채로 첫 타격이 오면 재개 순간부터 흐른다", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const store = useGameStore;
  store.getState().setClockPaused(false);
  store.getState().start();
  store.getState().setClockPaused(true);
  store.getState().hit(12, "fist");
  now = 10_000;
  assert.equal(selectPlayMs(store.getState(), now), 0);
  store.getState().setClockPaused(false);
  now = 13_000;
  assert.equal(selectPlayMs(store.getState(), now), 3_000);
  store.getState().setClockPaused(false);
});

test("설정 — 발행본 v4(구 키 maxPlaySeconds = 벽시계 30분)는 최대 경과 시간으로 승계, 시간 규칙은 기본값 충전", () => {
  const parsed = sessionLimitsSchema.parse({ maxScore: 5_000_000, maxPlaySeconds: 1800 });
  assert.deepEqual(parsed, {
    maxElapsedSeconds: 1800,
    maxScore: 5_000_000,
    timeLimit: { baseSeconds: 60, maxPlaySeconds: 120, ultimateBonusSeconds: 10 },
  });
  // 새 모양은 그대로
  const next = { maxElapsedSeconds: 900, maxScore: 100_000, timeLimit: { baseSeconds: 45, maxPlaySeconds: 90, ultimateBonusSeconds: 5 } };
  assert.deepEqual(sessionLimitsSchema.parse(next), next);
});

test("설정 — 최대 플레이 시간 < 기본 시간, 최대 경과 시간 < 최대 플레이 시간은 거부", () => {
  const base = { maxElapsedSeconds: 1800, maxScore: 5_000_000 };
  assert.equal(
    sessionLimitsSchema.safeParse({ ...base, timeLimit: { baseSeconds: 60, maxPlaySeconds: 30, ultimateBonusSeconds: 10 } }).success,
    false,
  );
  assert.equal(
    sessionLimitsSchema.safeParse({
      maxElapsedSeconds: 100,
      maxScore: 5_000_000,
      timeLimit: { baseSeconds: 60, maxPlaySeconds: 120, ultimateBonusSeconds: 10 },
    }).success,
    false,
  );
  assert.equal(
    sessionLimitsSchema.safeParse({ ...base, timeLimit: { baseSeconds: 60, maxPlaySeconds: 120, ultimateBonusSeconds: 31 } }).success,
    false,
  );
});

test("판 통계 — 제한 시간 필드는 다섯이 함께, 정합(추가 ≤ 최대−기본, 추가 횟수 ≤ 궁극기)", () => {
  const stats = (timeLimit?: Record<string, number>, ultimateCount = 2) =>
    buildGameplayStats({
      hitCount: 3,
      maxCombo: 3,
      durationMs: 80_000,
      weaponCounts: { fist: 3 },
      weaponScores: { fist: 336 },
      ultScore: 0,
      ultimateCount,
      firstHitMs: 1_000,
      bgVisits: ["office"],
      intervalCV: null,
      timeLimit,
    });
  const ok = stats({ playMs: 79_000, timeBaseMs: 60_000, timeCapMs: 120_000, timeBonusMs: 20_000, timeBonusCount: 2 });
  assert.equal(validTimeLimitStats(ok), true);
  assert.equal(validateGameplayStats(ok, 336), true);
  // 구 클라(필드 없음) 통과
  assert.equal(validateGameplayStats(stats(undefined), 336), true);
  // 추가 시간이 최대−기본을 넘음
  assert.equal(validTimeLimitStats(stats({ playMs: 1, timeBaseMs: 60_000, timeCapMs: 120_000, timeBonusMs: 70_000, timeBonusCount: 2 })), false);
  // 추가 횟수 > 궁극기 횟수
  assert.equal(validTimeLimitStats(stats({ playMs: 1, timeBaseMs: 60_000, timeCapMs: 120_000, timeBonusMs: 10_000, timeBonusCount: 3 })), false);
  // 일부만 있음
  const partial = { ...ok, timeBonusCount: undefined };
  assert.equal(validTimeLimitStats(partial), false);
});
