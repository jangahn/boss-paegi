import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/quality.yml", import.meta.url),
  "utf8",
);

test("CI executes only the exact reviewed action commits", () => {
  const actions = [...workflow.matchAll(/^\s*-\s+uses:\s+(\S+)/gm)].map(
    (match) => match[1],
  );

  assert.deepEqual(actions, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "supabase/setup-cli@ab058987d8d6c725971f6cf9d0b5c98467e30bd1",
  ]);
  assert.ok(
    actions.every((action) => /@[0-9a-f]{40}$/.test(action)),
    "every action must be immutable SHA-pinned",
  );
});
