import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function occurrences(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

test("every direct PortOne request rejects redirects carrying payment authority", () => {
  const value = source("lib/portone.ts");
  assert.equal(occurrences(value, /\bfetch\(/g), 3);
  assert.equal(occurrences(value, /redirect:\s*"error"/g), 3);
});

test("Fal credential and key-discovery requests reject redirect pivots", () => {
  for (const file of [
    "lib/character-gen/fal-submit-once.ts",
    "lib/fal-balance.ts",
    "lib/fal-webhook-auth.ts",
  ]) {
    const value = source(file);
    assert.match(value, /redirect:\s*"error"/, file);
  }
});
