// prompt-golden.test.ts — generation_config 이관의 byte-equality 잠금 + config 계약 검증.
//   실행: node --test __tests__/generation/prompt-golden.test.ts   (Node 24 기본 strip-types)
//   generation.ts 는 zod 외 런타임 의존 없음(RoleId/DomainEntry 는 type-only) → alias 로더 불필요.
//
// 목적: GENERATION_CONFIG_DEFAULT 로 조립한 최종 positive/negative + 수치가 리팩터 전 main
//   (lib/character-gen/providers/flux-pulid.ts) 과 **byte-for-byte 동일**함을 동결한다.
//   아래 golden 참조는 그 시점 flux-pulid.ts 의 프롬프트 로직/상수를 그대로 복제한 것이다.

import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATION_CONFIG_DEFAULT,
  assembleGenerationPrompts,
  generationConfigSchema,
} from "../../lib/config/domains/generation.ts";

// ── 동결 golden 참조(리팩터 전 flux-pulid.ts 로직 복제) ──
const ROLE_VISUALS = {
  boss: {
    subject: "Korean office boss",
    attire: (c: string) =>
      `a ${c} business suit jacket, dress shirt, necktie, dress trousers with belt, dress shoes`,
    expression: "slightly grumpy stern facial expression, rosy cheeks,",
  },
  exec: {
    subject: "senior Korean corporate executive",
    attire: (c: string) =>
      `a premium tailored ${c} suit jacket with a pocket square, crisp dress shirt, silk necktie, dress trousers, polished dress shoes`,
    expression: "composed smug confident facial expression, dignified air, rosy cheeks,",
  },
  teamlead: {
    subject: "Korean team manager",
    attire: (c: string) =>
      `a ${c} business-casual blazer with no necktie, dress shirt with rolled-up sleeves, chinos, loafers`,
    expression: "earnest slightly weary facial expression, faint nervous smile, rosy cheeks,",
  },
  client: {
    subject: "visiting Korean business client",
    attire: (c: string) =>
      `a formal ${c} business suit, dress shirt, necktie, a visitor lanyard badge around the neck, dress shoes`,
    expression: "cordial but demanding facial expression, polite yet pushy look, rosy cheeks,",
  },
  coworker: {
    subject: "Korean office coworker",
    attire: (c: string) =>
      `a casual ${c} knit cardigan over a collared shirt, no suit jacket, chinos, clean sneakers`,
    expression: "friendly easygoing cheeky facial expression, casual grin, rosy cheeks,",
  },
};
const headFor = (subject: string) =>
  [
    `A full body chibi character of a ${subject},`,
    "standing front-facing pose, full body visible from head to feet,",
    "round large head with chibi super-deformed proportions, short body and limbs,",
  ].join(" ");
const CHARACTER_PROMPT_TAIL = [
  "soft plush fabric doll material texture, felt-like surface,",
  "plain pure white background, no scene, no objects, no shadows on background,",
  "sharp focus, all-in-focus, even soft studio lighting from front,",
  "high detail, crisp clean lines, no motion blur,",
  "no depth of field, no bokeh, no shallow focus, no blur effect,",
  "professional product photography of a toy character,",
  "1:1 square aspect ratio, centered composition.",
].join(" ");
const IDENTITY_INSTRUCTION = [
  "Use the reference face with HIGH identity fidelity:",
  "preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle,",
  "nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence,",
  "face roundness, skin tone, ethnicity, age appearance.",
  "The character face must be strongly and clearly recognizable as the SAME specific reference person,",
  "keeping their distinctive unique facial features and proportions intact,",
  "reinterpreted in the plush chibi office character style described above.",
].join(" ");
const NEGATIVE_PROMPT = [
  "blurry, out of focus, soft focus, depth of field, bokeh, motion blur, lens blur,",
  "shallow focus, defocused background, hazy, foggy,",
  "low quality, jpeg artifacts, noise, grain, pixelated, oversharpened, oversaturated,",
  "photorealistic photograph of the reference person,",
  "identical clothing as the reference, identical background as the reference,",
  "multiple characters, group, crowd, two people,",
  "scene, environment, props, furniture, plants,",
  "text, watermark, signature, logo, frame, border",
].join(", ");

function goldenPositive(
  role: keyof typeof ROLE_VISUALS,
  wearsGlasses: boolean,
  suitColor: string
) {
  const v = ROLE_VISUALS[role];
  const head = headFor(v.subject);
  const eyewear = wearsGlasses ? " wearing eyeglasses," : "";
  const idEyewear = wearsGlasses ? " Preserve the eyeglasses of the reference person." : "";
  return (
    `${head} wearing ${v.attire(suitColor)},${eyewear} ` +
    `${v.expression} ${CHARACTER_PROMPT_TAIL} ${IDENTITY_INSTRUCTION}${idEyewear}`
  );
}

const ROLES: (keyof typeof ROLE_VISUALS)[] = [
  "boss",
  "exec",
  "teamlead",
  "client",
  "coworker",
];
const SUIT = "charcoal grey";

test("golden: DEFAULT 조립 positive/negative 가 현재 main 과 byte-identical (롤5 × 안경 T/F)", () => {
  for (const role of ROLES) {
    for (const wearsGlasses of [true, false]) {
      const { positive, negative } = assembleGenerationPrompts(
        GENERATION_CONFIG_DEFAULT.prompt,
        role,
        { wearsGlasses, suitColor: SUIT }
      );
      assert.equal(
        positive,
        goldenPositive(role, wearsGlasses, SUIT),
        `positive mismatch role=${role} glasses=${wearsGlasses}`
      );
      assert.equal(negative, NEGATIVE_PROMPT, `negative mismatch role=${role}`);
    }
  }
});

test("golden: DEFAULT 수치 == 현재 main", () => {
  assert.deepEqual(GENERATION_CONFIG_DEFAULT.numbers, {
    numInferenceSteps: 28,
    guidanceScale: 4,
    trueCfg: 2,
    imageSize: "square_hd",
  });
});

test("DEFAULT 는 스키마 검증 통과", () => {
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
