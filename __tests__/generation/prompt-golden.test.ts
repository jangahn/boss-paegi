// prompt-golden.test.ts — generation_config 조립 로직 + config 계약 회귀 가드.
//   실행: node --test __tests__/generation/prompt-golden.test.ts   (Node 24 기본 strip-types)
//   generation.ts 는 zod 외 런타임 의존 없음(RoleId/DomainEntry 는 type-only) → alias 로더 불필요.
//
// (마이그 시점의 byte-identical 잠금은 Deploy A 에서 역할 종료 — 이후 프롬프트는 의도적 개선 대상.
//  여기선 assembleGenerationPrompts 의 치환·안경 조건 로직과 DEFAULT 의 스키마·placeholder 정합을 가드.)

import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATION_CONFIG_DEFAULT,
  assembleGenerationPrompts,
  generationConfigSchema,
  type GenerationPromptConfig,
} from "../../lib/config/domains/generation.ts";

const ROLES = ["boss", "exec", "teamlead", "client", "coworker"] as const;

// 합성 prompt(내용 무관) — 조립 로직만 검증. DEFAULT 문구 변경과 디커플.
function synthPrompt(): GenerationPromptConfig {
  const role = {
    subject: "SUBJ",
    attireTemplate: "a {suitColor} suit",
    expression: "EXPR,",
  };
  return {
    positiveTemplate: "{head} wearing {attire},{glasses} {expression} {tail} {identity}{idGlasses}",
    headTemplate: "HEAD subject={subject} END",
    tail: "TAIL",
    identity: "IDENTITY",
    negative: "NEG",
    glassesPrompt: " GLASSES,",
    glassesIdentityPrompt: " IDGLASSES.",
    suitColors: ["red", "blue", "green"],
    roles: { boss: role, exec: role, teamlead: role, client: role, coworker: role },
  };
}

test("assembleGenerationPrompts — 치환·안경 조건·간격 정확", () => {
  const p = synthPrompt();
  const noGlasses = assembleGenerationPrompts(p, "boss", { wearsGlasses: false, suitColor: "red" });
  assert.equal(
    noGlasses.positive,
    "HEAD subject=SUBJ END wearing a red suit, EXPR, TAIL IDENTITY"
  );
  assert.equal(noGlasses.negative, "NEG");

  const glasses = assembleGenerationPrompts(p, "boss", { wearsGlasses: true, suitColor: "red" });
  assert.equal(
    glasses.positive,
    "HEAD subject=SUBJ END wearing a red suit, GLASSES, EXPR, TAIL IDENTITY IDGLASSES."
  );
});

test("DEFAULT 조립 — 모든 롤×안경에 미치환 placeholder 없음", () => {
  const suit = GENERATION_CONFIG_DEFAULT.prompt.suitColors[0];
  for (const role of ROLES) {
    for (const wearsGlasses of [true, false]) {
      const { positive } = assembleGenerationPrompts(GENERATION_CONFIG_DEFAULT.prompt, role, {
        wearsGlasses,
        suitColor: suit,
      });
      assert.ok(
        !/\{[a-zA-Z]+\}/.test(positive),
        `미치환 placeholder 잔존 role=${role} glasses=${wearsGlasses}: ${positive}`
      );
      assert.ok(positive.length > 50, `조립 positive 가 비정상적으로 짧음 role=${role}`);
    }
  }
});

test("DEFAULT 는 스키마 검증 통과 (수치 서브레인지 포함)", () => {
  assert.equal(generationConfigSchema.safeParse(GENERATION_CONFIG_DEFAULT).success, true);
});

test("placeholder 계약: headTemplate {subject} 누락 거부", () => {
  const bad = structuredClone(GENERATION_CONFIG_DEFAULT);
  bad.prompt.headTemplate = "A chibi character,";
  assert.equal(generationConfigSchema.safeParse(bad).success, false);
});

test("placeholder 계약: positiveTemplate 미지원/중복 placeholder 거부", () => {
  const extra = structuredClone(GENERATION_CONFIG_DEFAULT);
  extra.prompt.positiveTemplate = GENERATION_CONFIG_DEFAULT.prompt.positiveTemplate + " {bogus}";
  assert.equal(generationConfigSchema.safeParse(extra).success, false);
  const dup = structuredClone(GENERATION_CONFIG_DEFAULT);
  dup.prompt.positiveTemplate = GENERATION_CONFIG_DEFAULT.prompt.positiveTemplate + " {head}";
  assert.equal(generationConfigSchema.safeParse(dup).success, false);
});

test("placeholder 계약: attireTemplate {suitColor} 누락 거부", () => {
  const bad = structuredClone(GENERATION_CONFIG_DEFAULT);
  bad.prompt.roles.boss.attireTemplate = "a plain business suit";
  assert.equal(generationConfigSchema.safeParse(bad).success, false);
});

test("suitColors: <3개 거부 + 대소문자 무시 중복 거부", () => {
  const few = structuredClone(GENERATION_CONFIG_DEFAULT);
  few.prompt.suitColors = ["navy", "black"];
  assert.equal(generationConfigSchema.safeParse(few).success, false);
  const dup = structuredClone(GENERATION_CONFIG_DEFAULT);
  dup.prompt.suitColors = ["Black", "black", "navy"];
  assert.equal(generationConfigSchema.safeParse(dup).success, false);
});

test("수치 서브레인지: guidance 7(>6)·steps 10(<20)·trueCfg 5(>4) 거부", () => {
  for (const patch of [
    (c: typeof GENERATION_CONFIG_DEFAULT) => (c.numbers.guidanceScale = 7),
    (c: typeof GENERATION_CONFIG_DEFAULT) => (c.numbers.numInferenceSteps = 10),
    (c: typeof GENERATION_CONFIG_DEFAULT) => (c.numbers.trueCfg = 5),
  ]) {
    const bad = structuredClone(GENERATION_CONFIG_DEFAULT);
    patch(bad);
    assert.equal(generationConfigSchema.safeParse(bad).success, false);
  }
});

test("roles: strict 5키 — 추가 키 거부", () => {
  const bad = structuredClone(GENERATION_CONFIG_DEFAULT);
  (bad.prompt.roles as Record<string, unknown>).intern = bad.prompt.roles.boss;
  assert.equal(generationConfigSchema.safeParse(bad).success, false);
});
