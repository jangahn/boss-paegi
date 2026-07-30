import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerationSubmitIntents,
  generationSubmitIntentRpcPayload,
  isPreparedSubmitSagaResult,
  parseSubmitClaimResult,
  parseSubmitRecordResult,
  publicFalWebhookOrigin,
} from "../../lib/character-gen/generation-submit-saga.ts";
import type { GenerationPlan } from "../../lib/character-gen/plan.ts";

const plan: GenerationPlan = {
  request: {
    imageSize: "portrait_4_3",
    numInferenceSteps: 20,
    guidanceScale: 3.5,
    trueCfg: 1,
    idWeight: 1,
    candidateCount: 3,
    enableSafetyChecker: true,
    maxSequenceLength: 128,
  },
  snapshot: {
    headTemplate: "",
    tail: "",
    identity: "",
    negative: "",
    glassesPrompt: "",
    glassesIdentityPrompt: "",
    subject: "",
    attireTemplate: "",
    expression: "",
  },
  negative: "negative",
  candidates: [0, 1, 2].map((index) => ({
    index,
    suitColor: `color-${index}`,
    positivePrompt: `prompt-${index}`,
  })),
};

test("only public HTTPS origins can receive fal callbacks", () => {
  assert.equal(
    publicFalWebhookOrigin("https://boss-paegi.example/path?q=1"),
    "https://boss-paegi.example",
  );
  for (const value of [
    "",
    "not-a-url",
    "http://boss-paegi.example",
    "https://localhost:3000",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://172.31.255.255",
    "https://192.168.0.1",
    "https://169.254.1.1",
    "https://host.local",
    "https://user:pass@boss-paegi.example",
  ]) {
    assert.equal(publicFalWebhookOrigin(value), null, value);
  }
});

test("three intents bind exact payloads while only hashes become RPC data", () => {
  const intents = createGenerationSubmitIntents({
    generationId: "11111111-1111-4111-8111-111111111111",
    siteOrigin: "https://boss-paegi.example",
    faceImageUrl: "https://signed.example/face",
    plan,
    credentials: "test-fal-key",
  });
  assert.deepEqual(
    intents.map((intent) => intent.index),
    [0, 1, 2],
  );
  assert.equal(new Set(intents.map((intent) => intent.callbackToken)).size, 3);
  for (const intent of intents) {
    assert.match(intent.payloadHash, /^[0-9a-f]{64}$/);
    assert.match(intent.callbackTokenHash, /^[0-9a-f]{64}$/);
    const url = new URL(intent.webhookUrl);
    assert.equal(url.searchParams.get("c"), String(intent.index));
    assert.equal(url.searchParams.get("p"), intent.payloadHash);
    assert.equal(url.searchParams.get("t"), intent.callbackToken);
  }
  const rpc = generationSubmitIntentRpcPayload(intents);
  assert.equal(JSON.stringify(rpc).includes("callbackToken"), true);
  assert.equal(
    rpc.some((item) =>
      intents.some((intent) =>
        Object.values(item).includes(intent.callbackToken),
      ),
    ),
    false,
  );
});

test("prepare/claim/record parsers reject null and partial false-success", () => {
  assert.equal(
    isPreparedSubmitSagaResult({ ok: true, outcome: "prepared" }),
    true,
  );
  for (const value of [
    null,
    {},
    { ok: false, outcome: "prepared" },
    { ok: true, outcome: "other" },
  ]) {
    assert.equal(isPreparedSubmitSagaResult(value), false);
  }
  assert.deepEqual(parseSubmitClaimResult({ ok: true, outcome: "claimed" }), {
    kind: "claimed",
  });
  assert.deepEqual(
    parseSubmitClaimResult({
      ok: true,
      outcome: "already_acknowledged",
      requestId: "r",
    }),
    { kind: "already_acknowledged", requestId: "r" },
  );
  assert.equal(parseSubmitClaimResult(null).kind, "blocked");
  assert.equal(
    parseSubmitClaimResult({
      ok: true,
      outcome: "already_acknowledged",
      requestId: null,
    }).kind,
    "blocked",
  );
  assert.equal(
    parseSubmitRecordResult({ ok: true, outcome: "acknowledged" }),
    "acknowledged",
  );
  assert.equal(
    parseSubmitRecordResult({
      ok: false,
      outcome: "request_id_conflict",
    }),
    "request_id_conflict",
  );
  assert.equal(
    parseSubmitRecordResult({ ok: true, outcome: "request_id_conflict" }),
    "blocked",
  );
  assert.equal(parseSubmitRecordResult(null), "blocked");
});
