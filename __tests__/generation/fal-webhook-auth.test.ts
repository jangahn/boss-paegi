import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";
import {
  FAL_WEBHOOK_MAX_BODY_BYTES,
  FAL_WEBHOOK_JWKS_MAX_BODY_BYTES,
  getFalWebhookKeys,
  parseFalWebhookPayload,
  refreshFalWebhookKeys,
  verifyFalWebhookSignature,
  type FalWebhookJwk,
} from "../../lib/fal-webhook-auth.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as FalWebhookJwk;
const nowMs = Date.parse("2026-07-29T00:00:00.000Z");
const timestamp = String(Math.floor(nowMs / 1000));
const requestId = "11111111-1111-4111-8111-111111111111";
const userId = "fal-user";
const rawBody = Buffer.from(
  JSON.stringify({ request_id: requestId, status: "OK", payload: {} }),
);

function signedHeaders(
  body = rawBody,
  timestampValue = timestamp,
): Headers {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = Buffer.from(
    `${requestId}\n${userId}\n${timestampValue}\n${bodyHash}`,
  );
  const signature = sign(null, message, privateKey).toString("hex");
  return new Headers({
    "x-fal-webhook-request-id": requestId,
    "x-fal-webhook-user-id": userId,
    "x-fal-webhook-timestamp": timestampValue,
    "x-fal-webhook-signature": signature,
  });
}

test("valid ED25519 webhook signature and exact payload binding pass", () => {
  const verified = verifyFalWebhookSignature({
    headers: signedHeaders(),
    rawBody,
    keys: [jwk],
    nowMs,
  });
  assert.deepEqual(verified, { ok: true, requestId, userId });
  assert.deepEqual(parseFalWebhookPayload(rawBody, requestId), {
    requestId,
    status: "OK",
  });
});

test("timestamp accepts exact ±300 second boundaries and rejects one beyond", () => {
  for (const delta of [-300, 300]) {
    const ts = String(Math.floor(nowMs / 1000) + delta);
    assert.equal(
      verifyFalWebhookSignature({
        headers: signedHeaders(rawBody, ts),
        rawBody,
        keys: [jwk],
        nowMs,
      }).ok,
      true,
    );
  }
  for (const delta of [-301, 301]) {
    const ts = String(Math.floor(nowMs / 1000) + delta);
    assert.deepEqual(
      verifyFalWebhookSignature({
        headers: signedHeaders(rawBody, ts),
        rawBody,
        keys: [jwk],
        nowMs,
      }),
      { ok: false, reason: "stale_timestamp" },
    );
  }
});

test("missing, ambiguous, noncanonical, and oversized inputs fail closed", () => {
  assert.deepEqual(
    verifyFalWebhookSignature({
      headers: new Headers(),
      rawBody,
      keys: [jwk],
      nowMs,
    }),
    { ok: false, reason: "missing_headers" },
  );
  for (const ts of ["", "01", "+1", "1.0", "1e3", "NaN", "Infinity"]) {
    const headers = signedHeaders();
    headers.set("x-fal-webhook-timestamp", ts);
    assert.deepEqual(
      verifyFalWebhookSignature({
        headers,
        rawBody,
        keys: [jwk],
        nowMs,
      }),
      { ok: false, reason: "invalid_header" },
      ts,
    );
  }
  assert.deepEqual(
    verifyFalWebhookSignature({
      headers: signedHeaders(),
      rawBody: new Uint8Array(FAL_WEBHOOK_MAX_BODY_BYTES + 1),
      keys: [jwk],
      nowMs,
    }),
    { ok: false, reason: "body_too_large" },
  );
});

test("body/header/signature/key tampering never verifies", () => {
  const tampered = Buffer.from(rawBody);
  tampered[tampered.length - 2] ^= 1;
  assert.deepEqual(
    verifyFalWebhookSignature({
      headers: signedHeaders(),
      rawBody: tampered,
      keys: [jwk],
      nowMs,
    }),
    { ok: false, reason: "invalid_signature" },
  );
  const other = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  }) as FalWebhookJwk;
  assert.deepEqual(
    verifyFalWebhookSignature({
      headers: signedHeaders(),
      rawBody,
      keys: [other],
      nowMs,
    }),
    { ok: false, reason: "invalid_signature" },
  );
});

test("payload parser requires valid UTF-8 JSON, status, and signed request id", () => {
  assert.equal(parseFalWebhookPayload(Buffer.from("{"), requestId), null);
  assert.equal(
    parseFalWebhookPayload(
      Buffer.from(
        JSON.stringify({ request_id: "other", status: "OK" }),
      ),
      requestId,
    ),
    null,
  );
  assert.equal(
    parseFalWebhookPayload(
      Buffer.from(JSON.stringify({ request_id: requestId, status: "DONE" })),
      requestId,
    ),
    null,
  );
  assert.equal(
    parseFalWebhookPayload(Uint8Array.from([0xc3, 0x28]), requestId),
    null,
  );
});

test("JWKS cache refreshes after signature-failure throttle and bounds upstream bodies", async () => {
  const oldJwk = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  }) as FalWebhookJwk;
  const newJwk = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  }) as FalWebhookJwk;
  let calls = 0;
  const fetchKeys = (async () => {
    calls++;
    return Response.json({ keys: calls === 1 ? [oldJwk] : [newJwk] });
  }) as typeof fetch;

  assert.deepEqual(await getFalWebhookKeys(fetchKeys, 0), [oldJwk]);
  assert.deepEqual(await refreshFalWebhookKeys(fetchKeys, 30_000), [oldJwk]);
  assert.equal(calls, 1, "forced refresh is rate-limited");
  assert.deepEqual(await refreshFalWebhookKeys(fetchKeys, 60_001), [newJwk]);
  assert.equal(calls, 2);

  const oversized = (async () =>
    new Response("{}", {
      headers: {
        "content-length": String(FAL_WEBHOOK_JWKS_MAX_BODY_BYTES + 1),
      },
    })) as typeof fetch;
  await assert.rejects(
    getFalWebhookKeys(oversized, 24 * 60 * 60 * 1000),
    /fal_jwks_too_large/,
  );

  const chunkedOversized = (async () =>
    new Response(
      new Uint8Array(FAL_WEBHOOK_JWKS_MAX_BODY_BYTES + 1),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    getFalWebhookKeys(chunkedOversized, 48 * 60 * 60 * 1000),
    /fal_jwks_too_large/,
  );
});
