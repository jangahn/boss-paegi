import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { OPS_CRON_STALE_THRESHOLD_MS } = await import(
  "../../lib/ops-cron-heartbeat.ts"
);

/**
 * ops cron 상호 침묵 감시(v1.02) 계약 — cron-job.org 알림은 "실행됐지만 실패"만 덮으므로,
 * "아예 안 옴"(잡 삭제·비활성)은 이웃 cron 이 심박(last_started_at) 정지로 감지해
 * ops.cron_heartbeat_stale(error) 로 승격해야 한다.
 */

test("silence thresholds leave headroom above each schedule and stay far under fal/candidate deadlines", () => {
  // 5분 잡은 최소 3주기 여유(오탐 방지), credit-expire 는 일 1회 + 2h 여유.
  assert.equal(OPS_CRON_STALE_THRESHOLD_MS["reconcile"], 20 * 60 * 1000);
  assert.equal(OPS_CRON_STALE_THRESHOLD_MS["gen-recover"], 20 * 60 * 1000);
  assert.equal(
    OPS_CRON_STALE_THRESHOLD_MS["credit-expire"],
    26 * 60 * 60 * 1000,
  );
  assert.ok(OPS_CRON_STALE_THRESHOLD_MS["gen-recover"] >= 3 * 5 * 60 * 1000);
});

test("the two 5-minute crons watch each other and reconcile also watches credit-expire", () => {
  const reconcile = readFileSync("app/api/ops/reconcile/route.ts", "utf8");
  const genRecover = readFileSync("app/api/ops/gen-recover/route.ts", "utf8");
  assert.match(
    reconcile,
    /alertIfOpsCronSilent\(admin, "gen-recover", deadline\.signal\)[\s\S]*?alertIfOpsCronSilent\(admin, "credit-expire", deadline\.signal\)/,
  );
  assert.match(
    genRecover,
    /alertIfOpsCronSilent\(admin, "reconcile", deadline\.signal\)/,
  );
  // 감시는 자기 심박 기록 다음, 본 작업 전에 — 본 작업 실패가 감시를 굶기지 않게.
  assert.match(
    genRecover,
    /heartbeat\(admin, "start", undefined, deadline\.signal\);[\s\S]{0,300}alertIfOpsCronSilent\(admin, "reconcile"/,
  );
});

test("gen-recover records the reconcile-convention heartbeat phases", () => {
  const genRecover = readFileSync("app/api/ops/gen-recover/route.ts", "utf8");
  assert.match(genRecover, /heartbeat\(admin, "start", undefined, deadline\.signal\)/);
  assert.match(
    genRecover,
    /heartbeat\([\s\S]*?admin,[\s\S]*?"failure",[\s\S]*?status === 503 \? "system_error" : "incomplete"/,
  );
  assert.match(genRecover, /heartbeat\(admin, "failure", "query_failed", deadline\.signal\)/);
  assert.match(
    genRecover,
    /heartbeat\([\s\S]*?createAdminClient\(\),[\s\S]*?"failure",[\s\S]*?"time_budget",[\s\S]*?AbortSignal\.timeout\(1_000\)/,
  );
});

test("migration 0109 extends the RPC allow-list to gen-recover and nothing else", () => {
  const migration = readFileSync(
    "supabase/migrations/0109_ops_cron_heartbeat_gen_recover.sql",
    "utf8",
  );
  assert.match(
    migration,
    /p_job not in \('credit-expire', 'reconcile', 'gen-recover'\)/,
  );
  assert.match(migration, /grant execute on function public\.ops_cron_heartbeat/);
  // 함수 허용 목록과 테이블 CHECK 는 같은 잡 목록을 봐야 한다(0062 는 둘 다 제한).
  assert.match(
    migration,
    /add constraint ops_cron_heartbeats_job_name_check[\s\S]*?'credit-expire', 'reconcile', 'gen-recover'/,
  );
  // 기존 컬럼 갱신 로직 불변(0062 원본과 동일한 upsert 형태).
  assert.match(migration, /on conflict \(job_name\) do update set/);
});

test("watchdog and recorder stay best-effort — they never kill the host cron", () => {
  const lib = readFileSync("lib/ops-cron-heartbeat.ts", "utf8");
  assert.match(
    lib,
    /ops\.cron_heartbeat_stale/,
  );
  // 기록·감시의 모든 실패 경로는 warn 이며 throw 하지 않는다.
  assert.match(lib, /ops\.cron_heartbeat_fail/);
  assert.match(lib, /ops\.cron_heartbeat_watch_fail/);
  assert.doesNotMatch(lib, /throw /);
  // row 부재는 부트스트랩 — 침묵으로 치지 않는다.
  assert.match(lib, /if \(data === null\) return;/);
});
