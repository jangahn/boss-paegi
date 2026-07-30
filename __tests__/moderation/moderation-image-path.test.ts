import assert from "node:assert/strict";
import test from "node:test";
import { resolveModerationImagePath } from "../../lib/moderation-image-path.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DOLL = "22222222-2222-4222-8222-222222222222";
const PATH = `${OWNER}/${DOLL}.png`;

test("moderation image state accepts only canonical signable paths", () => {
  assert.deepEqual(resolveModerationImagePath(PATH, null), {
    kind: "signable",
    path: PATH,
  });
  assert.deepEqual(
    resolveModerationImagePath(
      `https://demo.supabase.co/storage/v1/object/public/dolls/${PATH}`,
      null,
    ),
    { kind: "signable", path: PATH },
  );
  assert.deepEqual(resolveModerationImagePath("quota-race.png", null), {
    kind: "invalid",
  });
  assert.deepEqual(
    resolveModerationImagePath(
      "https://attacker.invalid/storage/v1/object/public/dolls/" + PATH,
      null,
    ),
    { kind: "invalid" },
  );
});

test("purge state wins while an active missing image stays distinguishable", () => {
  assert.deepEqual(resolveModerationImagePath(null, "2026-07-30T00:00:00Z"), {
    kind: "purged",
  });
  assert.deepEqual(resolveModerationImagePath(null, null), {
    kind: "missing",
  });
});
