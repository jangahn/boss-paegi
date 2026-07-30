import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PORTONE_WEBHOOK_MAX_BODY_BYTES,
  portoneWebhookBodyBytesAllowed,
  portoneWebhookContentLengthAllowed,
  readPortoneWebhookBody,
} from "../../lib/pay/webhook-request-boundary.ts";

function requestSurface(
  chunks: Uint8Array[],
  contentLength: string | null = null,
) {
  let index = 0;
  return {
    headers: new Headers(
      contentLength === null ? {} : { "content-length": contentLength },
    ),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]!);
      },
    }),
  };
}

test("PortOne webhook accepts exactly every canonical declared length in range", () => {
  assert.equal(portoneWebhookContentLengthAllowed(null), true);
  for (let length = 0; length <= PORTONE_WEBHOOK_MAX_BODY_BYTES; length += 1) {
    assert.equal(
      portoneWebhookContentLengthAllowed(String(length)),
      true,
      `declared length ${length}`,
    );
  }
});

test("PortOne webhook rejects every modeled malformed or oversized declared length", () => {
  for (const value of [
    String(PORTONE_WEBHOOK_MAX_BODY_BYTES + 1),
    "99999999999999999999999999999999999999999999999999",
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    "NaN",
    "Infinity",
    " 1",
    "1 ",
    "1,2",
    "１",
  ]) {
    assert.equal(
      portoneWebhookContentLengthAllowed(value),
      false,
      JSON.stringify(value),
    );
  }
});

test("PortOne webhook body limit is exact in UTF-8 bytes for ASCII, Korean, and emoji", () => {
  const asciiExact = "a".repeat(PORTONE_WEBHOOK_MAX_BODY_BYTES);
  assert.equal(portoneWebhookBodyBytesAllowed(asciiExact), true);
  assert.equal(portoneWebhookBodyBytesAllowed(`${asciiExact}a`), false);

  const koreanExact =
    "한".repeat(Math.floor(PORTONE_WEBHOOK_MAX_BODY_BYTES / 3)) +
    "a".repeat(PORTONE_WEBHOOK_MAX_BODY_BYTES % 3);
  assert.equal(Buffer.byteLength(koreanExact, "utf8"), PORTONE_WEBHOOK_MAX_BODY_BYTES);
  assert.equal(portoneWebhookBodyBytesAllowed(koreanExact), true);
  assert.equal(portoneWebhookBodyBytesAllowed(`${koreanExact}한`), false);

  const emojiExact =
    "😀".repeat(Math.floor(PORTONE_WEBHOOK_MAX_BODY_BYTES / 4)) +
    "a".repeat(PORTONE_WEBHOOK_MAX_BODY_BYTES % 4);
  assert.equal(Buffer.byteLength(emojiExact, "utf8"), PORTONE_WEBHOOK_MAX_BODY_BYTES);
  assert.equal(portoneWebhookBodyBytesAllowed(emojiExact), true);
  assert.equal(portoneWebhookBodyBytesAllowed(`${emojiExact}😀`), false);
});

test("PortOne webhook streams exact signed UTF-8 text without an unbounded fallback", async () => {
  const encoded = new TextEncoder().encode('{"한":"😀"}');
  for (let split = 0; split <= encoded.byteLength; split += 1) {
    const result = await readPortoneWebhookBody(
      requestSurface([
        encoded.slice(0, split),
        encoded.slice(split),
      ]),
    );
    assert.deepEqual(result, { ok: true, rawBody: '{"한":"😀"}' });
  }

  assert.deepEqual(
    await readPortoneWebhookBody(
      requestSurface(
        [new Uint8Array(PORTONE_WEBHOOK_MAX_BODY_BYTES + 1)],
      ),
    ),
    { ok: false, error: "body_too_large" },
  );
  assert.deepEqual(
    await readPortoneWebhookBody(requestSurface([], "01")),
    { ok: false, error: "body_too_large" },
  );
  assert.deepEqual(
    await readPortoneWebhookBody(
      requestSurface([Uint8Array.of(0xc3, 0x28)]),
    ),
    { ok: false, error: "invalid_body" },
  );
});

test("PortOne route cannot bypass the bounded raw-body reader", () => {
  const route = readFileSync(
    new URL("../../app/api/pay/webhook/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /readPortoneWebhookBody\(req\)/);
  assert.doesNotMatch(
    route,
    /\breq\.(?:json|text|arrayBuffer|blob|formData)\(\)/,
  );
});
