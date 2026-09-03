import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PREFLIGHT_CONTINUE_LIMIT,
  PREFLIGHT_CONTINUE_MAX_AGE_ACCEPTED_MS,
  PREFLIGHT_CONTINUE_MIN_AGE_MS,
  PREFLIGHT_STALE_RELEASE_AGE_MS,
  selectContinuationTargets,
} from "../../lib/character-gen/preflight-continuation-targets.ts";

const NOW = Date.parse("2026-09-03T05:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("continuation targets: accepted 1~9min, committed with expired lease up to 30min, oldest first, capped", () => {
  const rows = [
    { id: "a1", owner_id: "o", state: "accepted", continuation_state: "pending", continuation_leased_until: null, created_at: ago(30_000) },
    { id: "a2", owner_id: "o", state: "accepted", continuation_state: "pending", continuation_leased_until: null, created_at: ago(5 * 60_000) },
    { id: "a3", owner_id: "o", state: "accepted", continuation_state: "pending", continuation_leased_until: null, created_at: ago(9 * 60_000) },
    { id: "a4", owner_id: "o", state: "accepted", continuation_state: "pending", continuation_leased_until: null, created_at: ago(2 * 60_000) },
    { id: "c1", owner_id: "o", state: "committed", continuation_state: "running", continuation_leased_until: ago(-60_000), created_at: ago(3 * 60_000) },
    { id: "c2", owner_id: "o", state: "committed", continuation_state: "running", continuation_leased_until: ago(10_000), created_at: ago(8 * 60_000) },
    { id: "c3", owner_id: "o", state: "committed", continuation_state: "submitted", continuation_leased_until: null, created_at: ago(4 * 60_000) },
    { id: "c4", owner_id: "o", state: "committed", continuation_state: "pending", continuation_leased_until: null, created_at: ago(31 * 60_000) },
    { id: "x1", owner_id: "o", state: "claimed", continuation_state: "pending", continuation_leased_until: null, created_at: ago(5 * 60_000) },
  ];
  const all = selectContinuationTargets(rows, NOW, Number.MAX_SAFE_INTEGER).map((r) => r.id);
  assert.deepEqual(all, ["c2", "a2", "a4"]);
  assert.deepEqual(
    selectContinuationTargets(rows, NOW).map((r) => r.id),
    ["c2", "a2", "a4"].slice(0, PREFLIGHT_CONTINUE_LIMIT),
  );
  // 경계: 9분 accepted 는 release_stale(10분) 창과 겹치지 않게 제외, 1분 미만은 웹훅/클라 몫.
  assert.ok(PREFLIGHT_CONTINUE_MAX_AGE_ACCEPTED_MS < PREFLIGHT_STALE_RELEASE_AGE_MS);
  assert.equal(PREFLIGHT_CONTINUE_MIN_AGE_MS, 60_000);
});

test("face webhook continues only accepted reservations and keeps cleanup for the rest", () => {
  const webhook = readFileSync("app/api/fal/face-webhook/route.ts", "utf8");
  const accepted = webhook.indexOf('finalized.outcome === "accepted"');
  const continued = webhook.indexOf("continueReservationServerSide({");
  const cleanup = webhook.lastIndexOf("await cleanupTerminalInput()");
  assert.ok(accepted >= 0 && continued > accepted, "accepted branch must continue server-side");
  assert.ok(cleanup > continued, "non-accepted outcomes still clean the retained face");
  assert.match(webhook, /export const maxDuration = 30;/);
});

test("submit route delegates the continuation and keeps its strict ordering contract", () => {
  const route = readFileSync("app/api/fal/route.ts", "utf8");
  assert.match(route, /runGenerationContinuation\(\{/);
  assert.match(route, /faceSource: \{ kind: "bytes", prepared \}/);
  assert.doesNotMatch(route, /"claim_generation_submit_work"/);
  const lib = readFileSync("lib/character-gen/generation-continuation.ts", "utf8");
  for (const rpc of [
    '"commit_generation_preflight"',
    '"claim_generation_preflight_continuation"',
    '"claim_generation_submit_work"',
    '"record_generation_submit_outcome"',
    '"complete_generation_preflight_continuation"',
  ]) {
    assert.ok(lib.includes(rpc), `${rpc} must live in the shared continuation`);
  }
  // 보존본 복사 → 원본 삭제 순서(정책 #1): 복사 후 requestId 경로 정리.
  const copy = lib.indexOf("materializeFinalFace({");
  const requestCleanup = lib.indexOf("cleanupFace(tmpFacePath(ownerId, requestId))");
  assert.ok(copy >= 0 && requestCleanup > copy);
  assert.match(lib, /faceSource\.kind === "bytes"[\s\S]*uploadFaceTmp\([\s\S]*copyFaceTmp\(/);
});

test("gen-recover runs continuation first and stale release last", () => {
  const route = readFileSync("app/api/ops/gen-recover/route.ts", "utf8");
  const stagesStart = route.indexOf("for (const stage of [");
  const stages = route.slice(stagesStart, route.indexOf("]) {", stagesStart));
  const order = [
    "continuePendingPreflights",
    "terminalizeDeletedOwnerGenerations",
    "recoverIncompleteTargets",
    "failStuckQueuedGenerations",
    "expireStaleDoneGenerations",
    "cleanupTerminalArtifacts",
    "reRefundFailedGenerations",
    "releaseStalePreflights",
  ].map((name) => stages.indexOf(name));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), stages);
  assert.match(route, /continued: counters\.continued/);
  assert.match(route, /stalePreflightsReleased: counters\.stalePreflightsReleased/);
});

test("reservation reads go through the 0118 service-role RPCs, never the revoked table", () => {
  for (const path of [
    "lib/character-gen/generation-continuation.ts",
    "lib/character-gen/generation-sweep.ts",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /from\("generation_preflight_reservations"\)/, path);
  }
  const continuation = readFileSync("lib/character-gen/generation-continuation.ts", "utf8");
  assert.match(continuation, /"read_generation_preflight_for_continuation"/);
  const sweep = readFileSync("lib/character-gen/generation-sweep.ts", "utf8");
  assert.match(sweep, /"list_generation_preflight_continuations"/);
  assert.match(sweep, /"list_stale_generation_preflight_owners"/);
  const migration = readFileSync(
    "supabase/migrations/0118_generation_preflight_read_rpcs.sql",
    "utf8",
  );
  for (const fn of [
    "read_generation_preflight_for_continuation",
    "list_generation_preflight_continuations",
    "list_stale_generation_preflight_owners",
  ]) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`));
  }
});
