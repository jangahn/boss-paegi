import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFalCallbackUrl,
  createFalCallbackToken,
  FAL_QUEUE_ACK_MAX_BODY_BYTES,
  FAL_OBJECT_LIFECYCLE_PREFERENCE,
  FAL_QUEUE_START_TIMEOUT_SECONDS,
  hashFalCallbackToken,
  hashFalSubmitPayload,
  submitFalQueueOnce,
} from "../../lib/character-gen/fal-submit-once.ts";

const base = {
  endpoint: "fal-ai/flux-pulid",
  input: { prompt: "safe", guidance_scale: 3.5 },
  webhookUrl:
    "https://boss-paegi.example/api/fal/webhook?g=11111111-1111-4111-8111-111111111111&c=0&t=token",
  credentials: "secret",
  timeoutMs: 1000,
} as const;

test("queue submit performs exactly one HTTP attempt for every response-loss class", async () => {
  for (const scenario of ["throw", "503", "bad-json"] as const) {
    let calls = 0;
    const result = await submitFalQueueOnce({
      ...base,
      fetchImpl: (async () => {
        calls++;
        if (scenario === "throw") throw new TypeError("socket lost");
        if (scenario === "503") return new Response("retry", { status: 503 });
        return new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    assert.equal(calls, 1, scenario);
    assert.deepEqual(result, {
      kind: "uncertain",
      requestId: null,
      httpStatus:
        scenario === "throw" ? null : scenario === "503" ? 503 : 200,
    });
  }
});

test("only a valid 2xx request id is acknowledged", async () => {
  const result = await submitFalQueueOnce({
    ...base,
    fetchImpl: (async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://queue.fal.run");
      assert.equal(parsed.pathname, "/fal-ai/flux-pulid");
      assert.equal(parsed.searchParams.get("fal_webhook"), base.webhookUrl);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Key secret",
      );
      assert.equal(
        new Headers(init?.headers).get("x-fal-request-timeout"),
        String(FAL_QUEUE_START_TIMEOUT_SECONDS),
      );
      assert.equal(
        new Headers(init?.headers).get("x-fal-store-io"),
        "0",
      );
      assert.deepEqual(
        JSON.parse(
          new Headers(init?.headers).get(
            "x-fal-object-lifecycle-preference",
          ) ?? "",
        ),
        {
          expiration_duration_seconds: 6 * 60 * 60,
          initial_acl: { default: "forbid", rules: [] },
        },
      );
      assert.equal(
        new Headers(init?.headers).get(
          "x-fal-object-lifecycle-preference",
        ),
        FAL_OBJECT_LIFECYCLE_PREFERENCE,
      );
      assert.equal(init?.method, "POST");
      return Response.json(
        { request_id: "11111111-1111-4111-8111-111111111111" },
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assert.deepEqual(result, {
    kind: "acknowledged",
    requestId: "11111111-1111-4111-8111-111111111111",
    httpStatus: 200,
  });
});

test("oversized, invalid UTF-8, and chunked queue acknowledgements stay uncertain", async () => {
  const malformedBodies: BodyInit[] = [
    new Uint8Array(FAL_QUEUE_ACK_MAX_BODY_BYTES + 1),
    Uint8Array.from([0xc3, 0x28]),
  ];
  for (const body of malformedBodies) {
    const result = await submitFalQueueOnce({
      ...base,
      fetchImpl: (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    assert.deepEqual(result, {
      kind: "uncertain",
      requestId: null,
      httpStatus: 200,
    });
  }

  const declared = await submitFalQueueOnce({
    ...base,
    fetchImpl: (async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(FAL_QUEUE_ACK_MAX_BODY_BYTES + 1),
        },
      })) as typeof fetch,
  });
  assert.equal(declared.kind, "uncertain");
});

test("validation/auth HTTP rejections are definite but retryable statuses remain uncertain", async () => {
  for (const status of [400, 401, 403, 404, 405, 413, 415, 422]) {
    const result = await submitFalQueueOnce({
      ...base,
      fetchImpl: (async () => new Response("", { status })) as typeof fetch,
    });
    assert.equal(result.kind, "rejected", String(status));
  }
  for (const status of [408, 409, 429, 500, 502, 503, 504]) {
    const result = await submitFalQueueOnce({
      ...base,
      fetchImpl: (async () => new Response("", { status })) as typeof fetch,
    });
    assert.equal(result.kind, "uncertain", String(status));
  }
});

test("callback tokens are random, hash-only durable, and URL-bound", () => {
  const tokenA = createFalCallbackToken();
  const tokenB = createFalCallbackToken();
  assert.match(tokenA, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(tokenA, tokenB);
  assert.match(hashFalCallbackToken(tokenA), /^[0-9a-f]{64}$/);
  const url = new URL(
    buildFalCallbackUrl({
      siteUrl: "https://boss-paegi.example/base",
      generationId: "11111111-1111-4111-8111-111111111111",
      candidateIndex: 2,
      token: tokenA,
      payloadHash: "a".repeat(64),
    }),
  );
  assert.equal(url.pathname, "/api/fal/webhook");
  assert.equal(url.searchParams.get("c"), "2");
  assert.equal(url.searchParams.get("t"), tokenA);
  assert.equal(url.searchParams.get("p"), "a".repeat(64));
  assert.throws(() =>
    buildFalCallbackUrl({
      siteUrl: "https://boss-paegi.example",
      generationId: "x",
      candidateIndex: 3,
      token: tokenA,
      payloadHash: "a".repeat(64),
    }),
  );
});

test("payload hash binds the exact transmitted JSON bytes", () => {
  assert.equal(
    hashFalSubmitPayload({ a: 1, b: 2 }),
    hashFalSubmitPayload({ a: 1, b: 2 }),
  );
  assert.notEqual(
    hashFalSubmitPayload({ a: 1, b: 2 }),
    hashFalSubmitPayload({ b: 2, a: 1 }),
  );
});
