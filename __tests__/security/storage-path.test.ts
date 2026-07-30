import assert from "node:assert/strict";
import test from "node:test";
import {
  dollPath,
  isCanonicalDollObjectPath,
} from "../../lib/storage-path.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DOLL = "22222222-2222-4222-8222-222222222222";
const GENERATION = "33333333-3333-4333-8333-333333333333";
const FINAL = `${OWNER}/${DOLL}.png`;
const CANDIDATE = `${OWNER}/candidates/${GENERATION}/2.jpg`;

test("canonical final and candidate object keys round-trip", () => {
  for (const path of [FINAL, CANDIDATE]) {
    assert.equal(isCanonicalDollObjectPath(path), true);
    assert.equal(dollPath(path), path);
    assert.equal(dollPath(`  ${path}  `), path);
  }
});

test("only legacy Supabase public/sign URL shapes are normalized", () => {
  assert.equal(
    dollPath(
      `https://project.supabase.co/storage/v1/object/public/dolls/${FINAL}`,
    ),
    FINAL,
  );
  assert.equal(
    dollPath(
      `https://project.supabase.co/storage/v1/object/sign/dolls/${CANDIDATE}?token=secret#ignored`,
    ),
    CANDIDATE,
  );
  assert.equal(
    dollPath(`/storage/v1/object/public/dolls/${FINAL}?download=1`),
    FINAL,
  );
  assert.equal(
    dollPath(
      `https://project.supabase.co/storage/v1/render/image/sign/dolls/${FINAL}?token=secret&width=384`,
    ),
    FINAL,
  );
  assert.equal(
    dollPath(
      `https://project.supabase.co/storage/v1/render/image/public/dolls/${CANDIDATE}?width=384`,
    ),
    CANDIDATE,
  );

  for (const value of [
    "https://evil.example/x",
    `https://evil.example/dolls/${FINAL}`,
    `https://evil.example/storage/v1/object/public/dolls/${FINAL}`,
    `https://project.supabase.co@evil.example/storage/v1/object/public/dolls/${FINAL}`,
    `https://project.supabase.co/storage/v1/object/public/not-dolls/${FINAL}`,
    `http://project.supabase.co/storage/v1/object/public/dolls/${FINAL}`,
    `javascript://project/storage/v1/object/public/dolls/${FINAL}`,
    `//evil.example/storage/v1/object/public/dolls/${FINAL}`,
  ]) {
    assert.equal(dollPath(value), null, value);
  }
});

test("traversal, encoded separators, controls, and non-service grammars fail closed", () => {
  const invalid = [
    `${OWNER}/../../${DOLL}.png`,
    `${OWNER}/%2e%2e/${DOLL}.png`,
    `${OWNER}%2f${DOLL}.png`,
    `${OWNER}%2F${DOLL}.png`,
    `${OWNER}\\${DOLL}.png`,
    `${OWNER}//${DOLL}.png`,
    `/${FINAL}`,
    `${FINAL}/extra`,
    `${OWNER}/${DOLL}.jpg`,
    `${OWNER}/candidates/${GENERATION}/3.jpg`,
    `${OWNER}/candidates/${GENERATION}/00.jpg`,
    `${OWNER}/candidates/${GENERATION}/2.png`,
    `${OWNER}/candidates/not-a-uuid/2.jpg`,
    `tmp/face/${GENERATION}.jpg`,
    `https://evil.example/x`,
  ];

  for (const value of invalid) {
    assert.equal(isCanonicalDollObjectPath(value), false, value);
    assert.equal(dollPath(value), null, value);
  }

  for (let code = 0; code <= 0x1f; code += 1) {
    assert.equal(
      dollPath(`${OWNER}/${String.fromCharCode(code)}${DOLL}.png`),
      null,
      `control U+${code.toString(16).padStart(4, "0")}`,
    );
  }
  assert.equal(dollPath(`${OWNER}/${String.fromCharCode(0x7f)}${DOLL}.png`), null);
});

test("UUID shape and lowercase storage canonicalization are exact", () => {
  assert.equal(dollPath(FINAL.toUpperCase()), null);
  assert.equal(
    dollPath(
      "11111111-1111-1111-1111-11111111111/" + `${DOLL}.png`,
    ),
    null,
  );
  assert.equal(
    dollPath(
      `${OWNER}/22222222-2222-2222-2222-22222222222g.png`,
    ),
    null,
  );
});
