import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  GENERATION_COST_FROZEN_BODY,
  GENERATION_COST_ROLLOUT_HEADER,
  generationCostPathEnabled,
} = await import("../../lib/generation-cost-rollout.ts");

test("paid generation paths require the exact opt-in value", () => {
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
    assert.equal(generationCostPathEnabled(value), false);
  }
  assert.equal(generationCostPathEnabled("1"), true);
  assert.deepEqual(GENERATION_COST_FROZEN_BODY, {
    error: "generation_unavailable",
  });
  assert.equal(
    GENERATION_COST_ROLLOUT_HEADER,
    "x-boss-paegi-generation-cost-rollout",
  );
});

test("the fal freeze is before body, auth, storage, and provider work", async () => {
  const source = await readFile("app/api/fal/route.ts", "utf8");
  const handler = source.slice(source.indexOf("export async function POST"));
  const gate = handler.indexOf("if (!generationCostPathEnabled())");
  assert.ok(gate >= 0);
  for (const later of [
    "requireMember()",
    "req.formData()",
    "uploadFaceTmp(",
    "analyzeInputFace(",
  ]) {
    assert.ok(gate < handler.indexOf(later), `${later} must follow freeze`);
  }
});

test("only doll POST is frozen and its gate precedes paid work", async () => {
  const source = await readFile("app/api/doll/route.ts", "utf8");
  const postStart = source.indexOf("export async function POST");
  const getStart = source.indexOf("export async function GET");
  const post = source.slice(postStart, getStart);
  const gate = post.indexOf("if (!generationCostPathEnabled())");
  assert.ok(gate >= 0);
  for (const later of [
    "requireMember()",
    "req.json()",
    "createSignedUrl(",
    "removeBackground(",
  ]) {
    assert.ok(gate < post.indexOf(later), `${later} must follow freeze`);
  }
  assert.doesNotMatch(source.slice(getStart), /generationCostPathEnabled/);
});
