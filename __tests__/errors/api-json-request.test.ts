import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_API_JSON_BODY_MAX_BYTES,
  readApiJsonObjectRequest,
} from "../../lib/http/api-json-request.ts";

function partitions(length: number): number[][] {
  if (length === 0) return [[]];
  const values: number[][] = [];
  for (let mask = 0; mask < 2 ** (length - 1); mask += 1) {
    const sizes: number[] = [];
    let current = 1;
    for (let offset = 0; offset < length - 1; offset += 1) {
      if ((mask & (1 << offset)) !== 0) {
        sizes.push(current);
        current = 1;
      } else {
        current += 1;
      }
    }
    sizes.push(current);
    values.push(sizes);
  }
  return values;
}

function request(
  bytes: Uint8Array,
  sizes: readonly number[],
  options: {
    contentType?: string;
    contentLength?: string | null;
  } = {},
): {
  headers: Headers;
  body: ReadableStream<Uint8Array>;
} {
  let offset = 0;
  let index = 0;
  const headers = new Headers({
    "content-type":
      options.contentType ?? "application/json; charset=UTF-8",
  });
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers.set("content-length", options.contentLength);
  }
  return {
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === sizes.length) {
          controller.close();
          return;
        }
        const size = sizes[index++]!;
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
    }),
  };
}

test("every partition of exact-limit JSON succeeds and one-byte-over JSON is rejected", async () => {
  const encoder = new TextEncoder();
  const exact = encoder.encode('{"a":1}'); // seven bytes
  const over = encoder.encode('{"a":10}'); // eight bytes
  assert.equal(exact.byteLength, 7);
  assert.equal(over.byteLength, 8);

  for (const sizes of partitions(exact.byteLength)) {
    assert.deepEqual(
      await readApiJsonObjectRequest(request(exact, sizes), 7),
      { ok: true, value: { a: 1 } },
      sizes.join("+"),
    );
  }
  for (const sizes of partitions(over.byteLength)) {
    assert.deepEqual(
      await readApiJsonObjectRequest(request(over, sizes), 7),
      { ok: false, error: "payload_too_large", status: 413 },
      sizes.join("+"),
    );
  }
});

test("all small UTF-8 split points and invalid JSON/object shapes fail closed", async () => {
  const encoder = new TextEncoder();
  const unicode = encoder.encode('{"한":"🙂"}');
  for (const sizes of partitions(unicode.byteLength)) {
    assert.deepEqual(
      await readApiJsonObjectRequest(
        request(unicode, sizes),
        unicode.byteLength,
      ),
      { ok: true, value: { 한: "🙂" } },
      sizes.join("+"),
    );
  }

  const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  for (const sizes of partitions(invalidUtf8.byteLength)) {
    assert.deepEqual(
      await readApiJsonObjectRequest(request(invalidUtf8, sizes), 64),
      { ok: false, error: "invalid_body", status: 400 },
      sizes.join("+"),
    );
  }
  for (const value of ["", "{", "null", "[]", '"text"', "1", "true"]) {
    const bytes = encoder.encode(value);
    assert.deepEqual(
      await readApiJsonObjectRequest(
        request(bytes, bytes.byteLength === 0 ? [] : [bytes.byteLength]),
        64,
      ),
      { ok: false, error: "invalid_body", status: 400 },
      value,
    );
  }
});

test("canonical Content-Length is checked before body consumption", async () => {
  const bytes = new TextEncoder().encode("{}");
  for (let length = 0; length <= 7; length += 1) {
    const result = await readApiJsonObjectRequest(
      request(bytes, [bytes.byteLength], {
        contentLength: String(length),
      }),
      7,
    );
    assert.equal(result.ok, true, String(length));
  }

  for (const declared of [
    "8",
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "9".repeat(1_000),
  ]) {
    let readerRequests = 0;
    assert.deepEqual(
      await readApiJsonObjectRequest(
        {
          headers: {
            get(name: string) {
              if (name.toLowerCase() === "content-type") {
                return "application/json";
              }
              if (name.toLowerCase() === "content-length") return declared;
              return null;
            },
          } as Headers,
          body: {
            getReader() {
              readerRequests += 1;
              throw new Error("body must not be consumed");
            },
          } as unknown as ReadableStream<Uint8Array>,
        },
        7,
      ),
      { ok: false, error: "payload_too_large", status: 413 },
      declared,
    );
    assert.equal(readerRequests, 0, declared);
  }
});

test("content type, missing/broken bodies, and production default cap are strict", async () => {
  const bytes = new TextEncoder().encode("{}");
  for (const contentType of [
    "",
    "text/plain",
    "application/x-json",
    "application/jsonp",
    "application/json-seq",
  ]) {
    assert.deepEqual(
      await readApiJsonObjectRequest(
        request(bytes, [bytes.byteLength], { contentType }),
        64,
      ),
      { ok: false, error: "invalid_body", status: 400 },
      contentType,
    );
  }
  assert.deepEqual(
    await readApiJsonObjectRequest(
      {
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
      },
      64,
    ),
    { ok: false, error: "invalid_body", status: 400 },
  );
  assert.deepEqual(
    await readApiJsonObjectRequest(
      {
        headers: new Headers({ "content-type": "application/json" }),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("aborted"));
          },
        }),
      },
      64,
    ),
    { ok: false, error: "invalid_body", status: 400 },
  );
  assert.equal(DEFAULT_API_JSON_BODY_MAX_BYTES, 65_536);
});
