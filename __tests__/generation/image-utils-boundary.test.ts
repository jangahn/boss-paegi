import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  IMAGE_INPUT_MAX_PIXELS,
  assertGeneratedJpegEvidence,
  normalizeDollImage,
  prepareInputImage,
} = await import("../../lib/image-utils.ts");
const sharp = (await import("sharp")).default;

function exactArrayBuffer(value: Buffer): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

test("input preparation produces the canonical image dimensions", async () => {
  const input = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40">' +
      '<rect width="30" height="40" fill="red"/></svg>',
  );
  const output = await prepareInputImage(exactArrayBuffer(input));
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 768);
  assert.equal(metadata.height, 1024);
  assert.equal(metadata.format, "jpeg");
  await assertGeneratedJpegEvidence(output, {
    width: 768,
    height: 1024,
  });
  await assert.rejects(
    () =>
      assertGeneratedJpegEvidence(output, {
        width: 767,
        height: 1024,
      }),
    /evidence_mismatch/,
  );
});

test("tiny compressed images cannot expand beyond the server pixel budget", async () => {
  assert.equal(IMAGE_INPUT_MAX_PIXELS, 40_000_000);
  const bomb = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000">' +
      '<rect width="100%" height="100%" fill="red"/></svg>',
  );
  assert.equal(bomb.byteLength < 1024, true);
  await assert.rejects(
    () => prepareInputImage(exactArrayBuffer(bomb)),
    /pixel limit/i,
  );
  await assert.rejects(
    () => normalizeDollImage(bomb),
    /pixel limit/i,
  );
});
