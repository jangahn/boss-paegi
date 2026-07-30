import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MIN_CROP_SHORT_PX,
  MIN_SHARPNESS,
  assessFaceCrop,
  laplacianVariance,
} from "../../lib/image-quality.ts";

type Pixel = readonly [number, number, number, number];

function imageData(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Pixel,
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { data, width, height } as ImageData;
}

test("Laplacian variance closes every dimension without an interior pixel", () => {
  for (let width = 0; width <= 2; width += 1) {
    for (let height = 0; height <= 2; height += 1) {
      assert.equal(
        laplacianVariance(
          imageData(width, height, () => [255, 255, 255, 255]),
        ),
        0,
        `${width}x${height}`,
      );
    }
  }
});

test("uniform crops are zero-sharpness and checkerboards are above the gate", () => {
  for (const level of [0, 1, 127, 254, 255]) {
    assert.equal(
      laplacianVariance(
        imageData(8, 8, () => [level, level, level, 255]),
      ),
      0,
      `level=${level}`,
    );
  }
  const checker = imageData(16, 16, (x, y) =>
    (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
  );
  assert.ok(laplacianVariance(checker) > MIN_SHARPNESS);
});

test("crop assessment rejects every malformed geometry before touching the DOM", () => {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        throw new Error("DOM must not be reached");
      },
    },
  });
  try {
    for (const area of [
      { x: Number.NaN, y: 0, width: 400, height: 400 },
      { x: 0, y: Infinity, width: 400, height: 400 },
      { x: -1, y: 0, width: 400, height: 400 },
      { x: 0, y: -1, width: 400, height: 400 },
      { x: 0, y: 0, width: 0, height: 400 },
      { x: 0, y: 0, width: 400, height: -1 },
      { x: 0, y: 0, width: Number.NaN, height: 400 },
    ]) {
      assert.deepEqual(assessFaceCrop({} as HTMLImageElement, area), {
        ok: false,
        reason: "low_res",
        nativePx: 0,
        sharpness: 0,
      });
    }
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

test("crop short-edge threshold and unavailable-canvas behavior are exact", () => {
  const originalDocument = globalThis.document;
  let createCalls = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        createCalls += 1;
        return {
          width: 0,
          height: 0,
          getContext: () => null,
        };
      },
    },
  });
  try {
    assert.deepEqual(
      assessFaceCrop({} as HTMLImageElement, {
        x: 0,
        y: 0,
        width: MIN_CROP_SHORT_PX - 1,
        height: 1_000,
      }),
      {
        ok: false,
        reason: "low_res",
        nativePx: MIN_CROP_SHORT_PX - 1,
        sharpness: 0,
      },
    );
    assert.equal(createCalls, 0);
    assert.deepEqual(
      assessFaceCrop({} as HTMLImageElement, {
        x: 0,
        y: 0,
        width: MIN_CROP_SHORT_PX,
        height: MIN_CROP_SHORT_PX,
      }),
      {
        ok: true,
        nativePx: MIN_CROP_SHORT_PX,
        sharpness: MIN_SHARPNESS,
      },
    );
    assert.equal(createCalls, 1);
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});

test("photo cropper exposes processing failures instead of an unhandled rejection", () => {
  const source = readFileSync(
    new URL("../../components/PhotoCropper.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /try \{[\s\S]*await loadImage\(imageUrl\)/);
  assert.match(source, /catch \{[\s\S]*setProcessError\(true\)/);
  assert.match(source, /role="alert"/);
  assert.match(source, /다른 사진을 선택하거나 다시 시도/);
});
