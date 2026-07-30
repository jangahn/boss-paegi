import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleGenerationPrompts,
  GENERATION_CONFIG_DEFAULT,
  generationConfigSchema,
} from "../../lib/config/domains/generation.ts";
import { copyVarValue } from "../../lib/config/copy-var.ts";

test("generation prompt substitution never reads Object.prototype keys", () => {
  const prompt = structuredClone(GENERATION_CONFIG_DEFAULT.prompt);
  prompt.headTemplate += " {toString} {constructor} {__proto__}";

  const result = assembleGenerationPrompts(prompt, "boss", {
    wearsGlasses: false,
    suitColor: "navy",
  });

  assert.match(result.positive, /\{toString\} \{constructor\} \{__proto__\}/);
  assert.equal(result.positive.includes("function toString()"), false);
  assert.equal(
    generationConfigSchema.safeParse({
      ...GENERATION_CONFIG_DEFAULT,
      prompt,
    }).success,
    false,
  );
});

test("marketing copy substitution accepts only own runtime values", () => {
  const inherited = Object.create({ 제작자: "inherited secret" }) as {
    제작자?: string;
  };

  assert.equal(copyVarValue(inherited, "제작자"), undefined);
  assert.equal(copyVarValue({ 제작자: "own value" }, "제작자"), "own value");
});
