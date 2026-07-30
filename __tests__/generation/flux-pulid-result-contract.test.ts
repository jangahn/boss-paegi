import assert from "node:assert/strict";
import test from "node:test";
import {
  FAL_GENERATED_IMAGE_MAX_PIXELS,
  fluxPulidResultEvidence,
  parseFluxPulidResult,
  parseFluxPulidWebhookResult,
  parsePersistedFluxPulidResult,
  parsePersistedFluxPulidResults,
} from "../../lib/character-gen/flux-pulid-result-contract.ts";

const valid = {
  images: [
    {
      url: "https://v3b.fal.media/files/b/opaque/output.png",
      width: 768,
      height: 1024,
      content_type: "image/jpeg",
      file_size: 123_456,
    },
  ],
  seed: 4_294_967_295,
  has_nsfw_concepts: [false],
};

test("Flux PuLID result requires exact media and safety evidence", () => {
  assert.deepEqual(parseFluxPulidResult(valid), {
    image: {
      url: valid.images[0].url,
      width: 768,
      height: 1024,
      contentType: "image/jpeg",
      fileSize: 123_456,
    },
    seed: 4_294_967_295,
    nsfw: false,
  });
  assert.equal(
    parseFluxPulidResult({
      ...valid,
      images: [
        {
          url: "https://v3b.fal.media/files/b/opaque/nsfw.jpg",
          width: 1,
          height: FAL_GENERATED_IMAGE_MAX_PIXELS,
        },
      ],
      seed: 0,
      has_nsfw_concepts: [true],
    })?.nsfw,
    true,
  );
  assert.equal(
    parseFluxPulidResult({
      ...valid,
      images: [
        {
          ...valid.images[0],
          url: "https://storage.googleapis.com/falserverless/output.jpg",
        },
      ],
    }),
    null,
  );
});

test("malformed, unsafe-origin, ambiguous, and coerced verdicts fail closed", () => {
  for (const value of [
    null,
    [],
    {},
    { ...valid, images: [] },
    { ...valid, images: [valid.images[0], valid.images[0]] },
    { ...valid, images: [null] },
    {
      ...valid,
      images: [{ ...valid.images[0], url: "https://localhost/image.jpg" }],
    },
    { ...valid, images: [{ ...valid.images[0], width: 0 }] },
    { ...valid, images: [{ ...valid.images[0], width: 1.5 }] },
    {
      ...valid,
      images: [{
        ...valid.images[0],
        width: 2,
        height: FAL_GENERATED_IMAGE_MAX_PIXELS,
      }],
    },
    { ...valid, images: [{ ...valid.images[0], content_type: "image/png" }] },
    { ...valid, images: [{ ...valid.images[0], file_size: 0 }] },
    { ...valid, seed: -1 },
    { ...valid, seed: 1.5 },
    { ...valid, seed: Number.NaN },
    { ...valid, has_nsfw_concepts: [] },
    { ...valid, has_nsfw_concepts: [false, false] },
    { ...valid, has_nsfw_concepts: ["false"] },
    { ...valid, has_nsfw_concepts: [0] },
    { ...valid, has_nsfw_concepts: [null] },
  ]) {
    assert.equal(parseFluxPulidResult(value), null);
  }
});

test("canonical provider evidence round-trips without coercion", () => {
  const parsed = parseFluxPulidResult(valid);
  assert.ok(parsed);
  const evidence = fluxPulidResultEvidence(parsed);
  assert.deepEqual(evidence, {
    image: {
      url: valid.images[0].url,
      width: 768,
      height: 1024,
      content_type: "image/jpeg",
      file_size: 123_456,
    },
    seed: 4_294_967_295,
    nsfw: false,
  });
  assert.deepEqual(parsePersistedFluxPulidResult(evidence), parsed);
  assert.equal(
    parsePersistedFluxPulidResult({
      ...evidence,
      ignored: true,
    }),
    null,
  );
});

test("persisted output list requires exact unique candidate/request bindings", () => {
  const result = parseFluxPulidResult(valid);
  assert.ok(result);
  const output = fluxPulidResultEvidence(result);
  assert.deepEqual(
    parsePersistedFluxPulidResults([
      { candidate_index: 2, request_id: "req-2", output },
      { candidate_index: 0, request_id: "req-0", output },
    ]),
    [
      { candidateIndex: 0, requestId: "req-0", result },
      { candidateIndex: 2, requestId: "req-2", result },
    ],
  );
  for (const malformed of [
    [{ candidate_index: 0, request_id: "req-0", output, extra: true }],
    [
      { candidate_index: 0, request_id: "req-0", output },
      { candidate_index: 0, request_id: "req-other", output },
    ],
    [{ candidate_index: 3, request_id: "req-3", output }],
    [{ candidate_index: 0, request_id: "", output }],
    [{ candidate_index: 0, request_id: "bad\nrequest", output }],
    [
      { candidate_index: 0, request_id: "req-0", output },
      { candidate_index: 1, request_id: "req-1", output },
      { candidate_index: 2, request_id: "req-2", output },
      { candidate_index: 0, request_id: "req-0", output },
    ],
  ]) {
    assert.equal(parsePersistedFluxPulidResults(malformed), null);
  }
});

test("verified webhook parser binds request id and requires a complete OK result", () => {
  const requestId = "req-webhook-0";
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const parsed = parseFluxPulidResult(valid);
  assert.ok(parsed);
  assert.deepEqual(
    parseFluxPulidWebhookResult(
      bytes({ request_id: requestId, status: "OK", payload: valid }),
      requestId,
    ),
    { status: "OK", result: parsed },
  );
  assert.deepEqual(
    parseFluxPulidWebhookResult(
      bytes({ request_id: requestId, status: "ERROR", error: "provider" }),
      requestId,
    ),
    { status: "ERROR", result: null },
  );
  assert.equal(
    parseFluxPulidWebhookResult(
      bytes({ request_id: "other", status: "OK", payload: valid }),
      requestId,
    ),
    null,
  );
  assert.equal(
    parseFluxPulidWebhookResult(
      bytes({ request_id: requestId, status: "OK", payload: {} }),
      requestId,
    ),
    null,
  );
  assert.equal(
    parseFluxPulidWebhookResult(
      new Uint8Array([0xff]),
      requestId,
    ),
    null,
  );
});
