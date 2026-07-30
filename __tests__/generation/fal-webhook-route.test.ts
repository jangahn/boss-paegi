import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isWebhookPath } from "../../lib/routes.ts";

const route = readFileSync(
  new URL("../../app/api/fal/webhook/route.ts", import.meta.url),
  "utf8",
);
const adminGenerationProjection = [
  "../../lib/character-gen/admin-generation-state.ts",
  "../../app/admin/generations/page.tsx",
  "../../app/admin/generations/[id]/page.tsx",
]
  .map((relative) =>
    readFileSync(new URL(relative, import.meta.url), "utf8"),
  )
  .join("\n");

test("fal webhook bypasses session middleware but remains route-verified", () => {
  assert.equal(isWebhookPath("/api/fal/webhook"), true);
  assert.equal(isWebhookPath("/api/fal/face-webhook"), true);
  assert.equal(isWebhookPath("/api/fal/pick-webhook"), true);
  assert.match(route, /readBoundedResponseBytes/);
  assert.doesNotMatch(route, /req\.(?:arrayBuffer|text|json)\(\)/);
  assert.match(route, /verifyFalWebhookSignature/);
  assert.match(route, /refreshFalWebhookKeys/);
  assert.match(route, /parseFalWebhookPayload/);
  assert.match(route, /parseFluxPulidWebhookResult/);
  assert.match(route, /hashFalCallbackToken/);
  assert.match(route, /record_generation_submit_outcome/);
  assert.match(route, /record_generation_submit_provider_output/);
  assert.doesNotMatch(route, /req\.json\(\)/);
});

test("webhook persists canonical output before raw-face cleanup and retries outages", () => {
  assert.match(
    route,
    /verification_unavailable[\s\S]*status:\s*503/,
  );
  assert.match(route, /record_unavailable[\s\S]*status:\s*503/);
  assert.ok(
    route.indexOf('"record_generation_submit_provider_output"') <
      route.indexOf('"get_generation_face_cleanup_readiness"'),
  );
  assert.match(
    route,
    /request_id_conflict[\s\S]*late_acknowledged[\s\S]*reconciliation:\s*true/,
  );
});

test("private provider URL evidence is absent from logs and admin projections", () => {
  const logCalls = [...route.matchAll(
    /log\.(?:info|warn|error)\([\s\S]*?\);/g,
  )]
    .map((match) => match[0])
    .join("\n");
  assert.doesNotMatch(
    logCalls,
    /providerResult|outputData|p_output|image\.url|v3b\.fal\.media/,
  );
  assert.doesNotMatch(
    adminGenerationProjection,
    /provider_output|v3b\.fal\.media/,
  );
});
