// telemetry-ingest-envelope.test.ts — 텔레메트리 적재 RPC 의 봉투 리터럴(0130) = TS 저장 봉투 상수(단일 소스 계약, v1.47/anti-abuse v11).
//   0126 이 제출 RPC 리터럴만 올리고 적재 RPC(0074)의 c_max_avg_per_sec 2000·c_max_score 5000000 을 남겨 S8 오탐이 난 드리프트 재발 방지.
//   실행: node --test __tests__/score/telemetry-ingest-envelope.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { FORCE_END_GRACE_MS, MAX_AVG_SCORE_PER_SEC, MAX_DURATION_MS, MAX_SCORE_HARD } = await import("../../lib/score-limits.ts");
const { ANTI_ABUSE_RULES_VERSION, SCORE_PER_SEC_MAX } = await import("../../lib/anti-abuse-rules.ts");

const sql = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0130_telemetry_ingest_envelope_x4.sql"), "utf8");

test("0130 적재 RPC 리터럴 = 저장 봉투 상수(4000/초·800만·30분+grace)", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.bp_ingest_telemetry_delta_core\(p_session_id\ uuid,\ p_owner_id\ uuid,\ p_is_member\ boolean,\ p_payload\ jsonb\)/);
  const lit = (name: string) => {
    const m = sql.match(new RegExp(`\\n  ${name} \\w+ := (\\d+);`));
    assert.ok(m, `${name} literal`);
    return Number(m![1]);
  };
  assert.equal(lit("c_max_avg_per_sec"), MAX_AVG_SCORE_PER_SEC);
  assert.equal(lit("c_max_score"), MAX_SCORE_HARD);
  assert.equal(lit("c_max_duration"), MAX_DURATION_MS + FORCE_END_GRACE_MS);
  assert.equal(sql.match(/c_max_avg_per_sec int := /g)!.length, 1, "리터럴 선언 1회");
  // 의심 비율 판정은 이 리터럴을 쓴다(S3 가 아니라 저장 상한)
  assert.match(sql, /v_suspicious :=\s*v_score > \(\s*greatest\(1, pg_catalog\.ceil\(v_dur \/ 1000\.0\)\)\s*\* c_max_avg_per_sec\s*\)/);
  assert.ok(SCORE_PER_SEC_MAX < MAX_AVG_SCORE_PER_SEC, "S3 는 적재 의심 임계(=저장 상한)보다 아래");
});

test("0130 데이터 정정: v1.36 이후 세션만, 새 규칙(비율 4000 + 타격 합계 보존) 통과 행만 해제", () => {
  const fix = sql.slice(sql.indexOf("update public.telemetry_sessions t"));
  assert.match(fix, /set suspicious = false/);
  assert.match(fix, /where t\.suspicious\s+and t\.started_at >= '2026-09-11 00:00:00\+09'/);
  assert.match(fix, /t\.score <= greatest\(1, pg_catalog\.ceil\(t\.duration_ms \/ 1000\.0\)\) \* 4000/);
  assert.match(fix, /<= greatest\(10, t\.hit_count \* 0\.2\)/);
});

test("규칙 버전 v11 · 아웃박스 점수 상한도 MAX_SCORE_HARD 단일 소스", () => {
  assert.equal(ANTI_ABUSE_RULES_VERSION, "2026-09-anti-abuse-v11");
  const outbox = fs.readFileSync(path.resolve(process.cwd(), "lib/score-outbox.ts"), "utf8");
  assert.match(outbox, /\(value\.score as number\) <= MAX_SCORE_HARD &&/);
  assert.match(outbox, /\(value\.durationMs as number\) <= MAX_DURATION_MS &&/);
  assert.doesNotMatch(outbox, /5_000_000/);
});
