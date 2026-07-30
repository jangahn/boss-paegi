import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERATION_FORM_MAX_BODY_BYTES,
  GENERATION_IMAGE_MAX_BYTES,
  generationContentLengthAllowed,
  readGenerationFormData,
  readGenerationRequestBody,
} from "../../lib/character-gen/request-boundary.ts";

function streamRequest(
  chunks: Uint8Array[],
  contentLength: string | null = null,
): {
  headers: Headers;
  body: ReadableStream<Uint8Array>;
} {
  let index = 0;
  return {
    headers: new Headers(
      contentLength === null ? {} : { "content-length": contentLength },
    ),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]!);
      },
    }),
  };
}

test("generation upload declared length accepts only canonical integers within the exact cap", () => {
  assert.equal(generationContentLengthAllowed(null), true);
  for (const value of [
    "0",
    "1",
    String(GENERATION_FORM_MAX_BODY_BYTES - 1),
    String(GENERATION_FORM_MAX_BODY_BYTES),
  ]) {
    assert.equal(generationContentLengthAllowed(value), true, value);
  }
  for (const value of [
    String(GENERATION_FORM_MAX_BODY_BYTES + 1),
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
    assert.equal(generationContentLengthAllowed(value), false, value);
  }
  assert.equal(generationContentLengthAllowed("0", -1), false);
  assert.equal(generationContentLengthAllowed("0", Number.MAX_VALUE), false);
});

test("generation raw stream cap holds for every partition of modeled bodies", async () => {
  const max = 7;
  for (let total = 0; total <= max + 2; total += 1) {
    // Every composition of total bytes: each bit chooses whether to split.
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
      const result = await readGenerationRequestBody(
        streamRequest(sizes.map((size) => new Uint8Array(size))),
        max,
      );
      assert.equal(result.ok, total <= max, `${total}: ${sizes.join("+")}`);
      if (result.ok) assert.equal(result.bytes.byteLength, total);
      else assert.equal(result.error, "body_too_large");
    }
  }
});

test("generation declared oversize rejects before pulling and stream failures fail closed", async () => {
  let bodyAccessed = false;
  const oversizedRequest = {
    headers: new Headers({ "content-length": "8" }),
    get body(): ReadableStream<Uint8Array> {
      bodyAccessed = true;
      return new ReadableStream<Uint8Array>();
    },
  };
  const oversized = await readGenerationRequestBody(
    oversizedRequest,
    7,
  );
  assert.deepEqual(oversized, { ok: false, error: "body_too_large" });
  assert.equal(bodyAccessed, false);

  const failed = await readGenerationRequestBody(
    {
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("broken transport"));
        },
      }),
    },
    7,
  );
  assert.deepEqual(failed, { ok: false, error: "invalid_body" });
});

test("generation multipart parser preserves fields and rejects malformed media", async () => {
  const source = new FormData();
  source.set(
    "image",
    new File([new Uint8Array([1, 2, 3])], "face.png", {
      type: "image/png",
    }),
  );
  source.set("role", "boss");
  const request = new Request("http://internal.invalid/api/fal", {
    method: "POST",
    body: source,
  });
  const parsed = await readGenerationFormData(request);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const image = parsed.form.get("image");
    assert.equal(image instanceof File, true);
    assert.equal(image instanceof File ? image.size : -1, 3);
    assert.equal(parsed.form.get("role"), "boss");
  }

  assert.deepEqual(
    await readGenerationFormData({
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
    }),
    { ok: false, error: "invalid_body" },
  );
  assert.deepEqual(
    await readGenerationFormData({
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=missing",
      }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not multipart"));
          controller.close();
        },
      }),
    }),
    { ok: false, error: "invalid_body" },
  );
});

test("request allowance always exceeds the independently enforced image cap", () => {
  assert.equal(
    GENERATION_FORM_MAX_BODY_BYTES > GENERATION_IMAGE_MAX_BYTES,
    true,
  );
});
