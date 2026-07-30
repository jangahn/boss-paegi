import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedJsonRequest } from "../../lib/http/bounded-json-request.ts";

function request(
  body: Uint8Array,
  contentType = "application/json; charset=utf-8",
): {
  headers: Headers;
  body: ReadableStream<Uint8Array>;
} {
  return {
    headers: new Headers({ "content-type": contentType }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
}

test("bounded JSON request distinguishes valid, media, UTF-8, syntax, and size classes", async () => {
  const encoder = new TextEncoder();
  assert.deepEqual(
    await readBoundedJsonRequest(request(encoder.encode('{"ok":true}')), 64),
    { ok: true, value: { ok: true } },
  );
  assert.deepEqual(
    await readBoundedJsonRequest(
      request(encoder.encode("{}"), "text/plain"),
      64,
    ),
    { ok: false, error: "invalid_content_type" },
  );
  assert.deepEqual(
    await readBoundedJsonRequest(request(Uint8Array.from([0xc3, 0x28])), 64),
    { ok: false, error: "invalid_json" },
  );
  assert.deepEqual(
    await readBoundedJsonRequest(request(encoder.encode("{")), 64),
    { ok: false, error: "invalid_json" },
  );
  assert.deepEqual(
    await readBoundedJsonRequest(request(new Uint8Array(65)), 64),
    { ok: false, error: "too_large" },
  );
});
