import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseDollPickHttpResponse,
  parseGenerationSubmitHttpResponse,
} from "../../lib/character-gen/http-contract.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const DOLL = "22222222-2222-4222-8222-222222222222";

test("generation submit accepts only an exact UUID-bound generating response", () => {
  const valid = { generationId: GENERATION, status: "generating" } as const;
  assert.deepEqual(parseGenerationSubmitHttpResponse(valid), valid);
  for (const malformed of [
    null,
    {},
    { ...valid, generationId: "not-a-uuid" },
    { ...valid, status: "done" },
    { ...valid, error: "late_failure" },
  ]) {
    assert.equal(parseGenerationSubmitHttpResponse(malformed), null);
  }
});

test("doll pick binds a valid doll UUID to the requested generation", () => {
  const valid = {
    generationId: GENERATION,
    doll: { id: DOLL, role: "boss" },
  };
  assert.deepEqual(parseDollPickHttpResponse(valid, GENERATION), valid);
  for (const malformed of [
    null,
    { ...valid, generationId: DOLL },
    { ...valid, doll: null },
    { ...valid, doll: {} },
    { ...valid, doll: { id: "not-a-uuid" } },
    { ...valid, extra: true },
  ]) {
    assert.equal(
      parseDollPickHttpResponse(malformed, GENERATION),
      null,
    );
  }
  assert.equal(parseDollPickHttpResponse(valid, "not-a-uuid"), null);
});

test("generation APIs and client share the same strict response contracts", () => {
  const page = readFileSync(
    new URL("../../app/generate/page.tsx", import.meta.url),
    "utf8",
  );
  const falRoute = readFileSync(
    new URL("../../app/api/fal/route.ts", import.meta.url),
    "utf8",
  );
  const dollRoute = readFileSync(
    new URL("../../app/api/doll/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(page, /parseGenerationSubmitHttpResponse\(/);
  assert.match(page, /parseDollPickHttpResponse\(/);
  assert.doesNotMatch(page, /as \{ generationId\?: string \}/);
  assert.doesNotMatch(page, /as \{ doll: \{ id: string \} \}/);
  assert.match(falRoute, /parseGenerationSubmitHttpResponse\(\{/);
  assert.match(dollRoute, /parseDollPickHttpResponse\(/);
  assert.doesNotMatch(dollRoute, /NextResponse\.json\(\{ doll: (?:existing|winner|doll) \}\)/);
});
