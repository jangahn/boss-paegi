import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  QUEUED_STALE_MS,
  SUBMIT_ACK_STALE_MS,
} from "../../lib/character-gen/generation-deadlines.ts";

const memberRoute = readFileSync(
  new URL("../../app/api/generations/route.ts", import.meta.url),
  "utf8",
);
// v1.04: cron 회수 표면의 실체는 스윕 스테이지 lib(route 는 오케스트레이션만).
const cronRoute = readFileSync(
  new URL("../../lib/character-gen/generation-sweep.ts", import.meta.url),
  "utf8",
);
const recovery = readFileSync(
  new URL("../../lib/generation-recovery.ts", import.meta.url),
  "utf8",
);
const contentMaintenance = readFileSync(
  new URL("../../app/api/ops/content-maintain/route.ts", import.meta.url),
  "utf8",
);
const faceUpload = readFileSync(
  new URL("../../lib/character-gen/upload-face.ts", import.meta.url),
  "utf8",
);
const submitOnce = readFileSync(
  new URL("../../lib/character-gen/fal-submit-once.ts", import.meta.url),
  "utf8",
);
const packageJson = readFileSync(
  new URL("../../package.json", import.meta.url),
  "utf8",
);
const qualityWorkflow = readFileSync(
  new URL("../../.github/workflows/quality.yml", import.meta.url),
  "utf8",
);
const raceHarness = readFileSync(
  new URL("../../scripts/qa/test-fal-submit-races.sh", import.meta.url),
  "utf8",
);

test("signed acknowledgement deadline strictly exceeds ordinary queue timeout", () => {
  assert.equal(QUEUED_STALE_MS, 30 * 60 * 1000);
  assert.equal(SUBMIT_ACK_STALE_MS, 200 * 60 * 1000);
  assert.ok(SUBMIT_ACK_STALE_MS > QUEUED_STALE_MS);
  assert.match(cronRoute, /RECOVER_WINDOW_MS = 4 \* 60 \* 60 \* 1000/);
});

test("raw face crash cleanup starts only after its exact signed URL horizon", () => {
  assert.match(
    faceUpload,
    /FACE_INPUT_SIGNED_TTL_SECONDS = 10 \* 60/,
  );
  assert.match(
    submitOnce,
    /FAL_QUEUE_START_TIMEOUT_SECONDS = 8 \* 60/,
  );
  assert.match(
    contentMaintenance,
    /TMP_FACE_MAX_AGE_MS = 12 \* 60 \* 1000/,
  );
});

test("all recovery surfaces fence unresolved submit acknowledgements", () => {
  assert.match(memberRoute, /hasUnresolvedSubmitAcknowledgement/);
  assert.match(memberRoute, /SUBMIT_ACK_STALE_MS/);
  assert.match(cronRoute, /hasUnresolvedSubmitAcknowledgement/);
  assert.match(cronRoute, /SUBMIT_ACK_STALE_MS/);
  assert.match(
    recovery,
    /hasUnresolvedSubmitAcknowledgement\(generation\.gen_params\)[\s\S]*status:\s*"pending"/,
  );
  assert.doesNotMatch(
    cronRoute,
    /\.select\("id, owner_id"\)[\s\S]{0,250}\.limit\(SWEEP_LIMIT\)/,
  );
});

test("recovery consumes durable webhook output before any provider fallback", () => {
  const durableRead = recovery.indexOf(
    '"list_generation_submit_provider_outputs"',
  );
  const providerStatus = recovery.indexOf("fal.queue.status");
  assert.ok(durableRead >= 0);
  assert.ok(providerStatus > durableRead);
  assert.match(
    recovery,
    /persistedOutputs\.some\([\s\S]*requestByIndex\.get\(item\.candidateIndex\) !== item\.requestId/,
  );
  assert.match(
    recovery,
    /if \(persistedByIndex\.has\(index\)\) return "COMPLETED_PERSISTED"/,
  );
  assert.match(
    recovery,
    /const persisted = persistedByIndex\.get\(request\.index\)\?\.result;[\s\S]*if \(persisted\)/,
  );
});

test("stale timeout decisions carry the selected generation version into the refund fence", () => {
  assert.match(
    memberRoute,
    /failGeneration\([\s\S]{0,180}r\.version as number/,
  );
  assert.match(
    cronRoute,
    /failGeneration\([\s\S]{0,180}r\.version/,
  );
  assert.match(
    cronRoute,
    /failGeneration\([\s\S]{0,180}g\.version/,
  );
  assert.match(recovery, /p_expected_version:\s*expectedVersion \?\? null/);
  assert.match(recovery, /parseGenerationFailureRpcResult\(data\)/);
});

test("two-session FAL acknowledgement races are executable CI gates", () => {
  assert.match(packageJson, /"qa:db:fal-submit-race"/);
  assert.match(qualityWorkflow, /npm run qa:db:fal-submit-race/);
  assert.match(raceHarness, /"claimed"[\s\S]*"not_claimable"/);
  assert.match(
    raceHarness,
    /"acknowledged"[\s\S]*"already_acknowledged"/,
  );
  assert.match(
    raceHarness,
    /"acknowledged"[\s\S]*"version_conflict"/,
  );
  assert.match(raceHarness, /"refunded"[\s\S]*"late_acknowledged"/);
  assert.match(raceHarness, /deadlocks_after/);
});
