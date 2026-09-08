import { z } from "zod";
import type { DomainEntry } from "../registry";
// 롤 어휘(순수 모듈)·공용 own-property guard는 상대 경로로 import해
// node --test golden에서도 Next 별칭 해석 없이 실행 가능하게 유지한다.
import { LEGACY_ROLE_ALIASES, ROLE_IDS, type RoleId } from "../../roles/ids.ts";
import { GENDERS, type Gender } from "../../gender.ts";
import { ownRecordValue } from "../../own-record.ts";

// 캐릭터 생성(fal-ai/flux-pulid) 파라미터·프롬프트 도메인 — **v2 (2026-08-01 제품 결정)** + **v4 성별 축(v1.28)**.
// v4 = 롤당 subject 는 하나(성별 공용), body(복장+표정)만 성별별: prompt.roles[role] = {subject, body: {male, female}}.
// (v3(v1.26)는 subject 까지 성별별이었으나 과하다는 결정으로 v4 에서 subject 를 공용으로 되돌림 — 성별 신호는 body 의
// 복장 어휘와 참조 얼굴이 담당.) 구 v3·v2 발행행은 normalizeGenerationConfigInput 이 읽기 시 v4 로 승격한다
// (v3: subject=male.subject, female.subject 폐기 / v2: body.male=body, body.female=코드 기본값). 재발행 시 v4 저장.
// 조립 입력의 gender 는 얼굴검사 판정(unknown→male).
// 수치는 스키마 하드경계 대신 **앱 안전 서브레인지**(identity 붕괴·원가·지연 방지).
// 프롬프트는 **100% config 소유** — 코드에 영어 프롬프트 리터럴 없음.
// v2 구조 = 고정 **통짜 template**({subject}{role}{glasses}{idGlasses} 각 1회) + 롤당 subject/body
// (body = 복장+표정 통합 1필드, {suitColor} 1회). v1(positiveTemplate/headTemplate/tail/identity/
// attireTemplate/expression 분할)은 convertGenerationConfigV1toV2 로만 이관 — **v1 파싱 재도입 금지**
// (구버전 발행값 롤백 복원 시 invalid→codeDefault fallback 이 의도된 동작).
// 강제 캐릭터화 키워드는 코드로 강제하지 않음(사용자 결정) — 안전은 버전 이력·롤백·어드민 검토.

export const GENERATION_IMAGE_SIZES = [
  "square_hd",
  "square",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
] as const;

const FIELD_MAX = 4000;
const ASSEMBLED_MAX = 8000;
const TEMPLATE_PLACEHOLDERS = [
  "subject",
  "role",
  "glasses",
  "idGlasses",
] as const;

function placeholderCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const match of s.matchAll(/\{(\w+)\}/g)) {
    const k = match[1];
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

// 정확히 {name} 하나만(1회) 존재 — 다른/추가 placeholder 는 거부.
function onlyPlaceholder(s: string, name: string): boolean {
  const c = placeholderCounts(s);
  return c.size === 1 && c.get(name) === 1;
}

// template 은 허용 placeholder 4종을 각각 정확히 1회, 그 외 없음.
function validTemplate(s: string): boolean {
  const c = placeholderCounts(s);
  if (c.size !== TEMPLATE_PLACEHOLDERS.length) return false;
  return TEMPLATE_PLACEHOLDERS.every((p) => c.get(p) === 1);
}

// 복장+표정 통합 1필드 — template {role} 위치에 삽입. 성별별로 한 벌씩.
const roleBodySchema = z
  .string()
  .min(1)
  .max(FIELD_MAX)
  .refine((s) => onlyPlaceholder(s, "suitColor"), {
    message: "body 는 {suitColor} 를 정확히 1회 포함해야 하며 다른 placeholder 는 금지",
  });

// 롤 1개 = 공용 subject + 성별별 body(정확히 male/female) — 추가 키는 strict 거절.
const rolePromptSchema = z
  .object({
    // 호칭(짧은 명사구) — template {subject} 위치에 삽입. 성별 공용.
    subject: z.string().min(1).max(FIELD_MAX),
    body: z
      .object(
        Object.fromEntries(GENDERS.map((g) => [g, roleBodySchema])) as Record<
          Gender,
          typeof roleBodySchema
        >,
      )
      .strict(),
  })
  .strict();

export type GenerationRolePrompt = z.infer<typeof rolePromptSchema>;

const promptSchema = z.object({
  template: z
    .string()
    .min(1)
    .max(FIELD_MAX)
    .refine(validTemplate, {
      message:
        "template 은 {subject}{role}{glasses}{idGlasses} 를 각각 정확히 1회 포함(그 외 placeholder 금지)",
    }),
  negative: z.string().min(1).max(FIELD_MAX),
  // 안경 절 — 안경 시 {glasses}/{idGlasses} 위치에 삽입. 빈 문자열 허용(비활성).
  // 스페이싱 보존 위해 trim 하지 않음.
  glasses: z.string().max(FIELD_MAX),
  glassesIdentity: z.string().max(FIELD_MAX),
  suitColors: z
    .array(z.string().trim().min(1).max(100))
    .min(3)
    .max(20)
    .refine(
      (arr) => {
        const lower = arr.map((s) => s.trim().toLowerCase());
        return new Set(lower).size === lower.length;
      },
      { message: "suitColors 는 대소문자 무시 중복 금지" }
    ),
  // 7롤 고정(키 = ROLE_IDS 정확히). 구 alias(coworker)·누락 롤은 normalizeGenerationConfigInput 이 정리.
  roles: z
    .object(
      Object.fromEntries(ROLE_IDS.map((r) => [r, rolePromptSchema])) as Record<
        RoleId,
        typeof rolePromptSchema
      >,
    )
    .strict(),
});

export type GenerationPromptConfig = z.infer<typeof promptSchema>;

// 단일 pass 치환 — 치환된 값 안의 "{...}" 는 재치환하지 않음(String.replace 특성).
function fill(template: string, map: Record<string, string>): string {
  return template.replace(
    /\{(\w+)\}/g,
    (match, key: string) => ownRecordValue(map, key) ?? match,
  );
}

/**
 * 최종 positive/negative 조립 — provider(제출)·에디터 미리보기·golden 테스트 공용 단일 소스.
 * 순수 함수(클라 안전). {suitColor}→롤 body 선치환 후 template 에
 * subject/role/glasses/idGlasses 치환({glasses}/{idGlasses}는 안경 여부에 따라 삽입/제거).
 */
export function assembleGenerationPrompts(
  prompt: GenerationPromptConfig,
  role: RoleId,
  opts: { gender: Gender; wearsGlasses: boolean; suitColor: string }
): { positive: string; negative: string } {
  const rv = prompt.roles[role];
  const positive = fill(prompt.template, {
    subject: rv.subject,
    role: fill(rv.body[opts.gender], { suitColor: opts.suitColor }),
    glasses: opts.wearsGlasses ? prompt.glasses : "",
    idGlasses: opts.wearsGlasses ? prompt.glassesIdentity : "",
  });
  return { positive, negative: prompt.negative };
}

const numbersSchema = z.object({
  numInferenceSteps: z.number().int().min(20).max(40),
  guidanceScale: z.number().finite().min(3).max(6),
  trueCfg: z.number().finite().min(1).max(4),
  imageSize: z.enum(GENERATION_IMAGE_SIZES),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** v2 롤 값 — 롤당 {subject, body(string)}. */
function isRoleV2(value: unknown): value is { subject: unknown; body: string } {
  return isRecord(value) && "subject" in value && typeof value.body === "string";
}

/** v3 롤 값 — {male: {subject, body}, female: {subject, body}} (subject 까지 성별별). */
function isRoleV3(value: unknown): value is { male: Record<string, unknown>; female: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.male) && isRecord(value.female) && !("subject" in value);
}

/**
 * 읽기/쓰기 공통 정규화(v1.25·v1.26·v1.28) — 발행행에 ① 흡수된 구 롤 키(coworker) 제거 ② 없는 롤은 코드 기본값으로
 * 충전 ③ 구 롤 모양을 v4 로 승격: v2 {subject, body} → body.male=body·body.female=코드 기본값, v3 {male, female} →
 * subject=male.subject(female.subject 는 감사 이력에만 잔존)·body 는 각각. 그 외 미지 키는 건드리지 않아 strict 가
 * 거절한다(API 경계 방어). 튜닝된 template/numbers 는 무접촉.
 */
export function normalizeGenerationConfigInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const cfg = input as { prompt?: unknown };
  if (!cfg.prompt || typeof cfg.prompt !== "object" || Array.isArray(cfg.prompt)) return input;
  const prompt = cfg.prompt as { roles?: unknown };
  if (!prompt.roles || typeof prompt.roles !== "object" || Array.isArray(prompt.roles)) return input;
  const roles: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prompt.roles as Record<string, unknown>)) {
    if (Object.hasOwn(LEGACY_ROLE_ALIASES, key)) continue;
    const fallback = ownRecordValue(GENERATION_CONFIG_DEFAULT.prompt.roles, key);
    if (isRoleV3(value)) {
      roles[key] = { subject: value.male.subject, body: { male: value.male.body, female: value.female.body } };
    } else if (isRoleV2(value) && fallback) {
      roles[key] = { subject: value.subject, body: { male: value.body, female: fallback.body.female } };
    } else {
      roles[key] = value;
    }
  }
  for (const r of ROLE_IDS) {
    if (!(r in roles)) roles[r] = GENERATION_CONFIG_DEFAULT.prompt.roles[r];
  }
  return { ...cfg, prompt: { ...prompt, roles } };
}

const generationConfigBaseSchema = z
  .object({
    numbers: numbersSchema,
    prompt: promptSchema,
  })
  .superRefine((cfg, ctx) => {
    // 조립 총 길이 상한 — 모든 role × 성별 × 안경 T/F, 가장 긴 suitColor 로 실조립 후 검사(절단 방지).
    // strict roles 라 keys = 정확히 7롤(ROLE_IDS) × 2성별.
    const longest = cfg.prompt.suitColors.reduce((a, b) => (b.length > a.length ? b : a), "");
    for (const role of Object.keys(cfg.prompt.roles) as RoleId[]) {
      for (const gender of GENDERS) {
        for (const wearsGlasses of [true, false]) {
          const { positive } = assembleGenerationPrompts(cfg.prompt, role, {
            gender,
            wearsGlasses,
            suitColor: longest,
          });
          if (positive.length > ASSEMBLED_MAX) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `조립 positive prompt 가 ${ASSEMBLED_MAX}자 초과 (role=${role}, gender=${gender}, glasses=${wearsGlasses})`,
            });
          }
        }
      }
    }
  });

export const generationConfigSchema = z.preprocess(
  normalizeGenerationConfigInput,
  generationConfigBaseSchema,
);

export type GenerationConfig = z.infer<typeof generationConfigBaseSchema>;

// ── v1 → v2 변환 (일회성 이관 유틸 — 런타임 v1 파싱 아님) ─────────────────────────────
// v1 스캐폴드는 이 문자열 하나로 고정 발행돼 왔다(DEFAULT·운영 v17 동일). 변환은 이 순서
// 전제에서만 정의되므로 다른 positiveTemplate 은 명시적으로 거부한다(무언 오변환 방지).
const V1_POSITIVE_TEMPLATE_SCAFFOLD =
  "{head} wearing {attire},{glasses} {expression} {tail} {identity}{idGlasses}";

export type GenerationRolePromptV1 = {
  subject: string;
  attireTemplate: string;
  expression: string;
};

/** v1 발행 시절의 롤 5종(coworker 포함) — 변환 입력 전용. */
export type LegacyRoleIdV1 = "boss" | "exec" | "teamlead" | "client" | "coworker";

export type GenerationPromptConfigV1 = {
  positiveTemplate: string;
  headTemplate: string;
  tail: string;
  identity: string;
  negative: string;
  glassesPrompt: string;
  glassesIdentityPrompt: string;
  suitColors: string[];
  roles: Record<LegacyRoleIdV1, GenerationRolePromptV1>;
};

export type GenerationConfigV1 = {
  numbers: GenerationConfig["numbers"];
  prompt: GenerationPromptConfigV1;
};

/**
 * v1 스캐폴드 전개 순서대로 통짜 template 구성 — headTemplate/tail/identity 원문을 그대로 잇는다.
 * 안경 절 위치는 v1(복장과 표정 사이)과 달리 **롤 body(복장+표정) 뒤** — 확정 결정.
 * 안경=false 조립은 v1 과 byte-identical, 안경=true 는 절 순서만 이동(golden 이 강제).
 */
export function convertGenerationTemplateV1toV2(
  headTemplate: string,
  tail: string,
  identity: string,
): string {
  return `${headTemplate} wearing {role}{glasses} ${tail} ${identity}{idGlasses}`;
}

/** v1 스캐폴드의 "{attire},{glasses} {expression}" 구두점·공백 재현 — 안경=false byte-identity 소스. */
export function convertGenerationRoleBodyV1toV2(
  attireTemplate: string,
  expression: string,
): string {
  return `${attireTemplate}, ${expression}`;
}

export function convertGenerationConfigV1toV2(
  v1: GenerationConfigV1,
): GenerationConfig {
  if (v1.prompt.positiveTemplate !== V1_POSITIVE_TEMPLATE_SCAFFOLD) {
    throw new Error("generation_config_v1_scaffold_unsupported");
  }
  const p = v1.prompt;
  // v1 롤 값은 subject 그대로 + 남성 body 로 승격(byte-identity 는 male·안경=false 조립에서 유지), 여성 body 는
  // 코드 기본값(v1.28 v4).
  const convertRole = (
    role: RoleId,
    r: GenerationRolePromptV1,
  ) => ({
    subject: r.subject,
    body: {
      male: convertGenerationRoleBodyV1toV2(r.attireTemplate, r.expression),
      female: GENERATION_CONFIG_DEFAULT.prompt.roles[role].body.female,
    },
  });
  return {
    numbers: { ...v1.numbers },
    prompt: {
      template: convertGenerationTemplateV1toV2(p.headTemplate, p.tail, p.identity),
      negative: p.negative,
      glasses: p.glassesPrompt,
      glassesIdentity: p.glassesIdentityPrompt,
      suitColors: [...p.suitColors],
      // v1 의 4롤은 변환, coworker 는 friend 로 흡수(프롬프트는 신규 기본값), ceo/junior/friend 는 코드 기본값(v1.25).
      roles: {
        boss: convertRole("boss", p.roles.boss),
        ceo: GENERATION_CONFIG_DEFAULT.prompt.roles.ceo,
        exec: convertRole("exec", p.roles.exec),
        teamlead: convertRole("teamlead", p.roles.teamlead),
        client: convertRole("client", p.roles.client),
        junior: GENERATION_CONFIG_DEFAULT.prompt.roles.junior,
        friend: GENERATION_CONFIG_DEFAULT.prompt.roles.friend,
      },
    },
  };
}

// 기본값 = convertGenerationConfigV1toV2(v1 DEFAULT) 결과와 **동일**(golden 테스트가 강제).
// 안경=false 조립은 v1 DEFAULT 와 byte-identical.
export const GENERATION_CONFIG_DEFAULT: GenerationConfig = {
  numbers: {
    numInferenceSteps: 28,
    // 4→5: 프롬프트(비율 앵커) 준수 강화로 등신 편차 축소. 과하면 아티팩트 — 콘솔에서 미세조정.
    guidanceScale: 5,
    trueCfg: 2,
    imageSize: "square_hd",
  },
  prompt: {
    // 비율 앵커 강화(부장님 기본 ~2.5등신으로 수렴) + 정수리~발끝 온전 + 양손 내림(얼굴 옆 손 아티팩트 완화)
    // + 스타일·배경·포커스 + identity 보존 지시 통짜.
    template:
      "A full body chibi figurine of a {subject}, standing straight in a front-facing pose, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2.5 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides, wearing {role}{glasses} soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, no motion blur, no depth of field, no bokeh, no shallow focus, no blur effect, professional product photography of a toy character, 1:1 square aspect ratio, centered composition. Use the reference face with HIGH identity fidelity: preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle, nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence, face roundness, skin tone, ethnicity, age appearance. The character face must be strongly and clearly recognizable as the SAME specific reference person, keeping their distinctive unique facial features and proportions intact, reinterpreted in the plush chibi office character style described above.{idGlasses}",
    // 화질 저하 + 비율 이탈(현실적/큰키/긴다리) + 입력 아티팩트(손 얼굴근처·브이·잘린머리) 배제.
    negative:
      "blurry, out of focus, soft focus, depth of field, bokeh, motion blur, lens blur, shallow focus, defocused background, hazy, foggy, low quality, jpeg artifacts, noise, grain, pixelated, oversharpened, oversaturated, photorealistic photograph of the reference person, identical clothing as the reference, identical background as the reference, multiple characters, group, crowd, two people, scene, environment, props, furniture, plants, text, watermark, signature, logo, frame, border, realistic human body proportions, tall figure, long legs, lanky, slim adult body proportions, hand near face, fingers over face, hand covering face, peace sign, v sign gesture, raised hand, extra fingers, deformed hands, extra limb, blob on face, cropped head, head cut off, flat top of head, incomplete head, multiple heads",
    glasses: " wearing eyeglasses,",
    glassesIdentity: " Preserve the eyeglasses of the reference person.",
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
    // 롤당 subject 는 성별 공용(v2 발행 튜닝 방향 유지), body(복장+표정)만 성별별. 여성 body 는 표정·톤 동일, 복장·액세서리만 변주.
    roles: {
      boss: {
        subject: "Korean office boss",
        body: {
          male:
            "a {suitColor} business suit jacket, dress shirt, necktie, dress trousers with belt, dress shoes, slightly grumpy stern facial expression, rosy cheeks,",
          female:
            "a {suitColor} business suit jacket over a blouse, pencil skirt, low heels, slightly grumpy stern facial expression with a raised eyebrow, rosy cheeks,",
        },
      },
      exec: {
        subject: "senior Korean corporate executive",
        body: {
          male:
            "a premium tailored {suitColor} suit jacket with a pocket square, crisp dress shirt, silk necktie, dress trousers, polished dress shoes, composed smug confident facial expression, dignified air, rosy cheeks,",
          female:
            "a premium tailored {suitColor} suit jacket with a brooch, silk blouse, slim dress trousers, polished heels, composed smug confident facial expression, dignified air, rosy cheeks,",
        },
      },
      teamlead: {
        subject: "Korean team manager",
        body: {
          male:
            "a {suitColor} business-casual blazer with no necktie, dress shirt with rolled-up sleeves, chinos, loafers, earnest slightly weary facial expression, faint nervous smile, rosy cheeks,",
          female:
            "a {suitColor} business-casual blazer over a knit top, slim slacks, flat loafers, earnest slightly weary facial expression, faint nervous smile, rosy cheeks,",
        },
      },
      client: {
        subject: "visiting Korean business client",
        body: {
          male:
            "a formal {suitColor} business suit, dress shirt, necktie, a visitor lanyard badge around the neck, dress shoes, cordial but demanding facial expression, polite yet pushy look, rosy cheeks,",
          female:
            "a formal {suitColor} business suit with a blouse, a visitor lanyard badge around the neck, low heels, cordial but demanding facial expression, polite yet pushy look, rosy cheeks,",
        },
      },
      // v1.25 신규 3롤 — 발행 튜닝(subject 에 국적 미표기) 방향을 따른다.
      ceo: {
        subject: "company president and owner",
        body: {
          male:
            "a luxurious {suitColor} double-breasted suit with a gold tie pin and a wristwatch, crisp dress shirt, silk necktie, polished leather shoes, arrogant self-satisfied grin with chin raised, rosy cheeks,",
          female:
            "a luxurious {suitColor} tailored suit with a pearl necklace and a wristwatch, silk blouse, polished heels, arrogant self-satisfied grin with chin raised, rosy cheeks,",
        },
      },
      junior: {
        subject: "Gen-Z junior office employee",
        body: {
          male:
            "a {suitColor} knit vest over a white shirt with rolled-up sleeves, slim slacks, white sneakers, wireless earbuds in the ears, bored deadpan facial expression with a slight eye-roll, rosy cheeks,",
          female:
            "a {suitColor} knit vest over a white shirt, pleated skirt, white sneakers, wireless earbuds in the ears, bored deadpan facial expression with a slight eye-roll, rosy cheeks,",
        },
      },
      friend: {
        subject: "annoying smug best friend",
        body: {
          male:
            "a trendy {suitColor} oversized hoodie, baggy jeans, chunky sneakers, a small crossbody bag, smug teasing grin with one eyebrow raised, rosy cheeks,",
          female:
            "a trendy {suitColor} oversized hoodie, wide-leg jeans, chunky sneakers, a small crossbody bag, smug teasing grin with one eyebrow raised, rosy cheeks,",
        },
      },
    },
  },
};

// 게임플레이 노출 없음(서버 전용, /api/fal 만 소비). 공개 projection 미지정.
// 구 v1 발행값(또는 v1 롤백 복원)은 이 스키마에서 invalid → codeDefault fallback (기존 계약 유지).
export const generationEntry: DomainEntry<GenerationConfig> = {
  schema: generationConfigSchema,
  codeDefault: GENERATION_CONFIG_DEFAULT,
};
