// prompt-golden.test.ts — generation_config v2 조립 로직 + v1→v2 변환 golden + config 계약 회귀 가드.
//   실행: node --test __tests__/generation/prompt-golden.test.ts   (Node 24 기본 strip-types)
//   generation.ts 는 zod 외 런타임 의존 없음(RoleId/DomainEntry 는 type-only) → alias 로더 불필요.
//
// v2(2026-08-01 제품 결정): 통짜 template + 롤당 subject/body. 이 파일이 강제하는 계약:
//   ① v2 DEFAULT == convertGenerationConfigV1toV2(v1 DEFAULT)
//   ② 안경=false 조립은 v1 DEFAULT 조립과 **byte-identical**(전 롤 × 전 정장색)
//   ③ 안경=true 는 절 순서 이동(롤 body 뒤) — 신질서 정확 문자열 golden
//   ④ 운영 v17 실값 convert 후 조립 결과 golden(사시 negative·양안 앵커 포함)

import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATION_CONFIG_DEFAULT,
  assembleGenerationPrompts,
  convertGenerationConfigV1toV2,
  generationConfigSchema,
  type GenerationConfigV1,
  type GenerationPromptConfig,
  type GenerationPromptConfigV1,
} from "../../lib/config/domains/generation.ts";

const ROLES = ["boss", "exec", "teamlead", "client", "coworker"] as const;

// ── v1 golden 입력(변환 전 원문) ─────────────────────────────────────────────────
// v1 DEFAULT — v2 이관 직전 lib/config/domains/generation.ts 의 GENERATION_CONFIG_DEFAULT 원문.
const V1_DEFAULT: GenerationConfigV1 = {
  numbers: {
    numInferenceSteps: 28,
    guidanceScale: 5,
    trueCfg: 2,
    imageSize: "square_hd",
  },
  prompt: {
    positiveTemplate:
      "{head} wearing {attire},{glasses} {expression} {tail} {identity}{idGlasses}",
    headTemplate:
      "A full body chibi figurine of a {subject}, standing straight in a front-facing pose, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2.5 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides,",
    tail:
      "soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, no motion blur, no depth of field, no bokeh, no shallow focus, no blur effect, professional product photography of a toy character, 1:1 square aspect ratio, centered composition.",
    identity:
      "Use the reference face with HIGH identity fidelity: preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle, nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence, face roundness, skin tone, ethnicity, age appearance. The character face must be strongly and clearly recognizable as the SAME specific reference person, keeping their distinctive unique facial features and proportions intact, reinterpreted in the plush chibi office character style described above.",
    negative:
      "blurry, out of focus, soft focus, depth of field, bokeh, motion blur, lens blur, shallow focus, defocused background, hazy, foggy, low quality, jpeg artifacts, noise, grain, pixelated, oversharpened, oversaturated, photorealistic photograph of the reference person, identical clothing as the reference, identical background as the reference, multiple characters, group, crowd, two people, scene, environment, props, furniture, plants, text, watermark, signature, logo, frame, border, realistic human body proportions, tall figure, long legs, lanky, slim adult body proportions, hand near face, fingers over face, hand covering face, peace sign, v sign gesture, raised hand, extra fingers, deformed hands, extra limb, blob on face, cropped head, head cut off, flat top of head, incomplete head, multiple heads",
    glassesPrompt: " wearing eyeglasses,",
    glassesIdentityPrompt: " Preserve the eyeglasses of the reference person.",
    suitColors: [
      "charcoal grey",
      "navy blue",
      "dark brown",
      "slate blue",
      "burgundy",
      "forest green",
      "tan beige",
      "light grey",
      "black",
    ],
    roles: {
      boss: {
        subject: "Korean office boss",
        attireTemplate:
          "a {suitColor} business suit jacket, dress shirt, necktie, dress trousers with belt, dress shoes",
        expression: "slightly grumpy stern facial expression, rosy cheeks,",
      },
      exec: {
        subject: "senior Korean corporate executive",
        attireTemplate:
          "a premium tailored {suitColor} suit jacket with a pocket square, crisp dress shirt, silk necktie, dress trousers, polished dress shoes",
        expression: "composed smug confident facial expression, dignified air, rosy cheeks,",
      },
      teamlead: {
        subject: "Korean team manager",
        attireTemplate:
          "a {suitColor} business-casual blazer with no necktie, dress shirt with rolled-up sleeves, chinos, loafers",
        expression: "earnest slightly weary facial expression, faint nervous smile, rosy cheeks,",
      },
      client: {
        subject: "visiting Korean business client",
        attireTemplate:
          "a formal {suitColor} business suit, dress shirt, necktie, a visitor lanyard badge around the neck, dress shoes",
        expression: "cordial but demanding facial expression, polite yet pushy look, rosy cheeks,",
      },
      coworker: {
        subject: "Korean office coworker",
        attireTemplate:
          "a casual {suitColor} knit cardigan over a collared shirt, no suit jacket, chinos, clean sneakers",
        expression: "friendly easygoing cheeky facial expression, casual grin, rosy cheeks,",
      },
    },
  },
};

// 운영 v17 실값(DB 발행값과 동일) — identity/glasses/roles/suitColors/positiveTemplate 는 v1 DEFAULT 동일.
const V1_PROD_V17: GenerationConfigV1 = {
  numbers: {
    numInferenceSteps: 25,
    guidanceScale: 4,
    trueCfg: 2,
    imageSize: "square_hd",
  },
  prompt: {
    ...structuredClone(V1_DEFAULT.prompt),
    headTemplate:
      "A full body chibi character of a {subject}, standing straight in a front-facing pose, both eyes aligned and looking straight ahead, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides,",
    tail:
      "soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, professional product photography of a toy character, 1:1 square aspect ratio, centered composition.",
    negative:
      "blurry, out of focus, soft focus, depth of field, bokeh, motion blur, hazy, low quality, jpeg artifacts, noise, grain, pixelated, oversharpened, oversaturated, photorealistic photograph of the reference person, identical clothing as the reference, identical background as the reference, multiple characters, group, crowd, two people, scene, environment, props, furniture, plants, text, watermark, signature, logo, frame, border, realistic human body proportions, tall figure, long legs, lanky, slim adult body proportions, hand near face, fingers over face, hand covering face, peace sign, v sign gesture, raised hand, extra fingers, deformed hands, extra limb, blob on face, cropped head, head cut off, flat top of head, incomplete head, multiple heads, cross-eyed, crossed eyes, strabismus, misaligned eyes, lazy eye, asymmetric eye direction",
  },
};

// v1 조립 참조 구현 — byte-identity 비교 기준(이관 전 assembleGenerationPrompts 와 동일 로직).
function fillRef(template: string, map: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(map, key) ? map[key] : match,
  );
}
function assembleV1(
  prompt: GenerationPromptConfigV1,
  role: (typeof ROLES)[number],
  opts: { wearsGlasses: boolean; suitColor: string },
): string {
  const rv = prompt.roles[role];
  return fillRef(prompt.positiveTemplate, {
    head: fillRef(prompt.headTemplate, { subject: rv.subject }),
    attire: fillRef(rv.attireTemplate, { suitColor: opts.suitColor }),
    glasses: opts.wearsGlasses ? prompt.glassesPrompt : "",
    expression: rv.expression,
    tail: prompt.tail,
    identity: prompt.identity,
    idGlasses: opts.wearsGlasses ? prompt.glassesIdentityPrompt : "",
  });
}

// 합성 prompt(내용 무관) — v2 조립 로직만 검증. DEFAULT 문구 변경과 디커플.
function synthPrompt(): GenerationPromptConfig {
  const role = { subject: "SUBJ", body: "a {suitColor} suit, EXPR," };
  return {
    template: "HEAD subject={subject} END wearing {role}{glasses} TAIL IDENTITY{idGlasses}",
    negative: "NEG",
    glasses: " GLASSES,",
    glassesIdentity: " IDGLASSES.",
    suitColors: ["red", "blue", "green"],
    roles: { boss: role, exec: role, teamlead: role, client: role, coworker: role },
  };
}

test("assembleGenerationPrompts — 치환·안경 조건·간격 정확 (v2)", () => {
  const p = synthPrompt();
  const noGlasses = assembleGenerationPrompts(p, "boss", { wearsGlasses: false, suitColor: "red" });
  assert.equal(
    noGlasses.positive,
    "HEAD subject=SUBJ END wearing a red suit, EXPR, TAIL IDENTITY"
  );
  assert.equal(noGlasses.negative, "NEG");

  // v2 신질서 — 안경 절은 롤 body(복장+표정) 뒤.
  const glasses = assembleGenerationPrompts(p, "boss", { wearsGlasses: true, suitColor: "red" });
  assert.equal(
    glasses.positive,
    "HEAD subject=SUBJ END wearing a red suit, EXPR, GLASSES, TAIL IDENTITY IDGLASSES."
  );
});

test("① v2 DEFAULT == convertGenerationConfigV1toV2(v1 DEFAULT)", () => {
  assert.deepEqual(convertGenerationConfigV1toV2(V1_DEFAULT), GENERATION_CONFIG_DEFAULT);
});

test("변환기 — v1 스캐폴드가 아닌 positiveTemplate 은 거부(무언 오변환 방지)", () => {
  const unknown = structuredClone(V1_DEFAULT);
  unknown.prompt.positiveTemplate =
    "{head} {attire}{glasses} {expression} {tail} {identity}{idGlasses}";
  assert.throws(
    () => convertGenerationConfigV1toV2(unknown),
    /generation_config_v1_scaffold_unsupported/,
  );
});

test("② 안경=false 조립 — v1 DEFAULT 조립과 byte-identical (전 롤 × 전 정장색)", () => {
  for (const role of ROLES) {
    for (const suitColor of V1_DEFAULT.prompt.suitColors) {
      const v1 = assembleV1(V1_DEFAULT.prompt, role, { wearsGlasses: false, suitColor });
      const v2 = assembleGenerationPrompts(GENERATION_CONFIG_DEFAULT.prompt, role, {
        wearsGlasses: false,
        suitColor,
      });
      assert.equal(v2.positive, v1, `byte mismatch role=${role} suitColor=${suitColor}`);
    }
  }
  assert.equal(GENERATION_CONFIG_DEFAULT.prompt.negative, V1_DEFAULT.prompt.negative);
});

test("③ 안경=true 신질서 — 절 이동(롤 body 뒤) 정확 문자열 golden (DEFAULT boss)", () => {
  const { positive } = assembleGenerationPrompts(GENERATION_CONFIG_DEFAULT.prompt, "boss", {
    wearsGlasses: true,
    suitColor: "charcoal grey",
  });
  assert.equal(
    positive,
    "A full body chibi figurine of a Korean office boss, standing straight in a front-facing pose, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2.5 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides, wearing a charcoal grey business suit jacket, dress shirt, necktie, dress trousers with belt, dress shoes, slightly grumpy stern facial expression, rosy cheeks, wearing eyeglasses, soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, no motion blur, no depth of field, no bokeh, no shallow focus, no blur effect, professional product photography of a toy character, 1:1 square aspect ratio, centered composition. Use the reference face with HIGH identity fidelity: preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle, nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence, face roundness, skin tone, ethnicity, age appearance. The character face must be strongly and clearly recognizable as the SAME specific reference person, keeping their distinctive unique facial features and proportions intact, reinterpreted in the plush chibi office character style described above. Preserve the eyeglasses of the reference person."
  );
  // 신질서 구조 확인(전 롤): 안경 절이 롤 body(표정 꼬리) 뒤·tail 앞.
  for (const role of ROLES) {
    const assembled = assembleGenerationPrompts(GENERATION_CONFIG_DEFAULT.prompt, role, {
      wearsGlasses: true,
      suitColor: "black",
    });
    assert.match(assembled.positive, /rosy cheeks, wearing eyeglasses, soft plush fabric/);
  }
});

test("④ 운영 v17 convert 조립 golden — 양안 앵커·사시 negative 보존 (boss, 안경 T/F)", () => {
  const v17 = convertGenerationConfigV1toV2(V1_PROD_V17);
  assert.equal(generationConfigSchema.safeParse(v17).success, true);

  const noGlasses = assembleGenerationPrompts(v17.prompt, "boss", {
    wearsGlasses: false,
    suitColor: "charcoal grey",
  });
  assert.equal(
    noGlasses.positive,
    "A full body chibi character of a Korean office boss, standing straight in a front-facing pose, both eyes aligned and looking straight ahead, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides, wearing a charcoal grey business suit jacket, dress shirt, necktie, dress trousers with belt, dress shoes, slightly grumpy stern facial expression, rosy cheeks, soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, professional product photography of a toy character, 1:1 square aspect ratio, centered composition. Use the reference face with HIGH identity fidelity: preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle, nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence, face roundness, skin tone, ethnicity, age appearance. The character face must be strongly and clearly recognizable as the SAME specific reference person, keeping their distinctive unique facial features and proportions intact, reinterpreted in the plush chibi office character style described above."
  );
  // 안경=false 는 v1 v17 조립과도 byte-identical.
  for (const role of ROLES) {
    assert.equal(
      assembleGenerationPrompts(v17.prompt, role, {
        wearsGlasses: false,
        suitColor: "navy blue",
      }).positive,
      assembleV1(V1_PROD_V17.prompt, role, { wearsGlasses: false, suitColor: "navy blue" }),
    );
  }

  const glasses = assembleGenerationPrompts(v17.prompt, "boss", {
    wearsGlasses: true,
    suitColor: "charcoal grey",
  });
  assert.equal(
    glasses.positive,
    "A full body chibi character of a Korean office boss, standing straight in a front-facing pose, both eyes aligned and looking straight ahead, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides, wearing a charcoal grey business suit jacket, dress shirt, necktie, dress trousers with belt, dress shoes, slightly grumpy stern facial expression, rosy cheeks, wearing eyeglasses, soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, professional product photography of a toy character, 1:1 square aspect ratio, centered composition. Use the reference face with HIGH identity fidelity: preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle, nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence, face roundness, skin tone, ethnicity, age appearance. The character face must be strongly and clearly recognizable as the SAME specific reference person, keeping their distinctive unique facial features and proportions intact, reinterpreted in the plush chibi office character style described above. Preserve the eyeglasses of the reference person."
  );
  assert.equal(
    glasses.negative,
    "blurry, out of focus, soft focus, depth of field, bokeh, motion blur, hazy, low quality, jpeg artifacts, noise, grain, pixelated, oversharpened, oversaturated, photorealistic photograph of the reference person, identical clothing as the reference, identical background as the reference, multiple characters, group, crowd, two people, scene, environment, props, furniture, plants, text, watermark, signature, logo, frame, border, realistic human body proportions, tall figure, long legs, lanky, slim adult body proportions, hand near face, fingers over face, hand covering face, peace sign, v sign gesture, raised hand, extra fingers, deformed hands, extra limb, blob on face, cropped head, head cut off, flat top of head, incomplete head, multiple heads, cross-eyed, crossed eyes, strabismus, misaligned eyes, lazy eye, asymmetric eye direction"
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

test("placeholder 계약: template 토큰 누락/중복/미지원 거부", () => {
  const missing = structuredClone(GENERATION_CONFIG_DEFAULT);
  missing.prompt.template = missing.prompt.template.replace("{subject}", "someone");
  assert.equal(generationConfigSchema.safeParse(missing).success, false);
  const extra = structuredClone(GENERATION_CONFIG_DEFAULT);
  extra.prompt.template = GENERATION_CONFIG_DEFAULT.prompt.template + " {bogus}";
  assert.equal(generationConfigSchema.safeParse(extra).success, false);
  const dup = structuredClone(GENERATION_CONFIG_DEFAULT);
  dup.prompt.template = GENERATION_CONFIG_DEFAULT.prompt.template + " {role}";
  assert.equal(generationConfigSchema.safeParse(dup).success, false);
});

test("placeholder 계약: 롤 body {suitColor} 누락 거부", () => {
  const bad = structuredClone(GENERATION_CONFIG_DEFAULT);
  bad.prompt.roles.boss.body = "a plain business suit, stern expression,";
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
