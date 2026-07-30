import assert from "node:assert/strict";
import test from "node:test";
import {
  readBoundedResponseBytes,
  responseContentLengthAllowed,
  type ResponseBodySurface,
} from "../../lib/http/bounded-response.ts";

function surface(
  chunks: Uint8Array[],
  contentLength: string | null = null,
): ResponseBodySurface {
  let index = 0;
  return {
    headers: new Headers(
      contentLength === null ? {} : { "content-length": contentLength },
    ),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) {
          controller.close();
        } else {
          controller.enqueue(chunks[index++]!);
        }
      },
    }),
  };
}

test("bounded response accepts exactly canonical declared lengths in range", () => {
  assert.equal(responseContentLengthAllowed(null, 64), true);
  for (let length = 0; length <= 64; length += 1) {
    assert.equal(
      responseContentLengthAllowed(String(length), 64),
      true,
    );
  }
  for (const value of [
    "65",
    "999999999999999999999999999999999999",
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
  ]) {
    assert.equal(responseContentLengthAllowed(value, 64), false, value);
  }
  assert.equal(responseContentLengthAllowed("0", -1), false);
  assert.equal(
    responseContentLengthAllowed("0", Number.MAX_VALUE),
    false,
  );
});

test("bounded response holds for every partition of modeled byte streams", async () => {
  const max = 7;
  for (let total = 0; total <= max + 2; total += 1) {
    const compositions = total === 0 ? 1 : 2 ** (total - 1);
    for (let mask = 0; mask < compositions; mask += 1) {
      const sizes: number[] = [];
      let current = total === 0 ? 0 : 1;
      for (let position = 0; position < total - 1; position += 1) {
        if ((mask & (1 << position)) !== 0) {
          sizes.push(current);
          current = 1;
        } else {
          current += 1;
        }
      }
      if (total > 0) sizes.push(current);
      const result = await readBoundedResponseBytes(
        surface(sizes.map((size) => new Uint8Array(size))),
        max,
      );
      assert.equal(result.ok, total <= max, `${total}: ${sizes.join("+")}`);
      if (result.ok) assert.equal(result.bytes.byteLength, total);
      else assert.equal(result.error, "too_large");
    }
  }
});

test("declared oversize and broken streams fail without unbounded fallback", async () => {
  assert.deepEqual(
    await readBoundedResponseBytes(surface([], "8"), 7),
    { ok: false, error: "too_large" },
  );
  assert.deepEqual(
    await readBoundedResponseBytes(
      {
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("broken"));
          },
        }),
      },
      7,
    ),
    { ok: false, error: "read_failed" },
  );
});
