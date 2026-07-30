import { z } from "zod";
import type { DomainEntry } from "../registry";
// roles는 type-only(런타임 erase), 공용 own-property guard는 상대 경로로 import해
// node --test golden에서도 Next 별칭 해석 없이 실행 가능하게 유지한다.
import type { RoleId } from "@/lib/roles";
import { ownRecordValue } from "../../own-record.ts";

// 캐릭터 생성(fal-ai/flux-pulid) 파라미터·프롬프트 도메인.
// 수치는 스키마 하드경계 대신 **앱 안전 서브레인지**(identity 붕괴·원가·지연 방지).
// 프롬프트는 **100% config 소유** — 코드에 영어 프롬프트 리터럴 없음. 최종 positive 는 아래
// positiveTemplate 에 head/attire/glasses/expression/tail/identity/idGlasses 를 치환해 조립.
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
const POSITIVE_PLACEHOLDERS = [
  "head",
  "attire",
  "glasses",
  "expression",
  "tail",
  "identity",
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

// positiveTemplate 은 허용 placeholder 7종을 각각 정확히 1회, 그 외 없음.
function validPositiveTemplate(s: string): boolean {
  const c = placeholderCounts(s);
  if (c.size !== POSITIVE_PLACEHOLDERS.length) return false;
  return POSITIVE_PLACEHOLDERS.every((p) => c.get(p) === 1);
}

const rolePromptSchema = z.object({
  subject: z.string().min(1).max(FIELD_MAX),
  attireTemplate: z
    .string()
    .min(1)
    .max(FIELD_MAX)
    .refine((s) => onlyPlaceholder(s, "suitColor"), {
      message: "attireTemplate 은 {suitColor} 를 정확히 1회 포함해야 하며 다른 placeholder 는 금지",
    }),
  expression: z.string().min(1).max(FIELD_MAX),
});

const promptSchema = z.object({
  positiveTemplate: z
    .string()
    .min(1)
    .max(FIELD_MAX)
    .refine(validPositiveTemplate, {
      message:
        "positiveTemplate 은 {head}{attire}{glasses}{expression}{tail}{identity}{idGlasses} 를 각각 정확히 1회 포함(그 외 placeholder 금지)",
    }),
  headTemplate: z
    .string()
    .min(1)
    .max(FIELD_MAX)
    .refine((s) => onlyPlaceholder(s, "subject"), {
      message: "headTemplate 은 {subject} 를 정확히 1회 포함해야 하며 다른 placeholder 는 금지",
    }),
  tail: z.string().min(1).max(FIELD_MAX),
  identity: z.string().min(1).max(FIELD_MAX),
  negative: z.string().min(1).max(FIELD_MAX),
  // 안경 절 — 빈 문자열 허용(안경 처리 비활성). 스페이싱 보존 위해 trim 하지 않음.
  glassesPrompt: z.string().max(FIELD_MAX),
  glassesIdentityPrompt: z.string().max(FIELD_MAX),
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
  roles: z
    .object({
      boss: rolePromptSchema,
      exec: rolePromptSchema,
      teamlead: rolePromptSchema,
      client: rolePromptSchema,
      coworker: rolePromptSchema,
    })
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
 * 순수 함수(클라 안전). {subject}→headTemplate, {suitColor}→attireTemplate 선치환 후
 * positiveTemplate 에 head/attire/glasses/expression/tail/identity/idGlasses 치환.
 */
export function assembleGenerationPrompts(
  prompt: GenerationPromptConfig,
  role: RoleId,
  opts: { wearsGlasses: boolean; suitColor: string }
): { positive: string; negative: string } {
  const rv = prompt.roles[role];
  const head = fill(prompt.headTemplate, { subject: rv.subject });
  const attire = fill(rv.attireTemplate, { suitColor: opts.suitColor });
  const glasses = opts.wearsGlasses ? prompt.glassesPrompt : "";
  const idGlasses = opts.wearsGlasses ? prompt.glassesIdentityPrompt : "";
  const positive = fill(prompt.positiveTemplate, {
    head,
    attire,
    glasses,
    expression: rv.expression,
    tail: prompt.tail,
    identity: prompt.identity,
    idGlasses,
  });
  return { positive, negative: prompt.negative };
}

const numbersSchema = z.object({
  numInferenceSteps: z.number().int().min(20).max(40),
  guidanceScale: z.number().finite().min(3).max(6),
  trueCfg: z.number().finite().min(1).max(4),
  imageSize: z.enum(GENERATION_IMAGE_SIZES),
});

export const generationConfigSchema = z
  .object({
    numbers: numbersSchema,
    prompt: promptSchema,
  })
  .superRefine((cfg, ctx) => {
    // 조립 총 길이 상한 — 모든 role × 안경 T/F, 가장 긴 suitColor 로 실조립 후 검사(절단 방지).
    // strict roles 라 keys = 정확히 5롤. ROLE_IDS 런타임 import 회피(node --test).
    const longest = cfg.prompt.suitColors.reduce((a, b) => (b.length > a.length ? b : a), "");
    for (const role of Object.keys(cfg.prompt.roles) as RoleId[]) {
      for (const wearsGlasses of [true, false]) {
        const { positive } = assembleGenerationPrompts(cfg.prompt, role, {
          wearsGlasses,
          suitColor: longest,
        });
        if (positive.length > ASSEMBLED_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `조립 positive prompt 가 ${ASSEMBLED_MAX}자 초과 (role=${role}, glasses=${wearsGlasses})`,
          });
        }
      }
    }
  });

export type GenerationConfig = z.infer<typeof generationConfigSchema>;

// 기본값 = 현재 main(lib/character-gen/providers/flux-pulid.ts) 의 프롬프트·수치 **바이트 동일** 이관.
// (golden 테스트가 조립 positive/negative·수치 byte-equality 를 강제.)
export const GENERATION_CONFIG_DEFAULT: GenerationConfig = {
  numbers: {
    numInferenceSteps: 28,
    // 4→5: 프롬프트(비율 앵커) 준수 강화로 등신 편차 축소. 과하면 아티팩트 — 콘솔에서 미세조정.
    guidanceScale: 5,
    trueCfg: 2,
    imageSize: "square_hd",
  },
  prompt: {
    positiveTemplate:
      "{head} wearing {attire},{glasses} {expression} {tail} {identity}{idGlasses}",
    // 비율 앵커 강화(부장님 기본 ~2.5등신으로 수렴) + 정수리~발끝 온전 + 양손 내림(얼굴 옆 손 아티팩트 완화).
    headTemplate:
      "A full body chibi figurine of a {subject}, standing straight in a front-facing pose, the entire body from the very top of the head down to the feet fully visible and centered in frame, consistent super-deformed toy proportions about 2.5 heads tall, one single oversized round head, short stubby torso and limbs, both hands relaxed hanging down at the sides,",
    tail:
      "soft plush fabric doll material texture, felt-like surface, plain pure white background, no scene, no objects, no shadows on background, sharp focus, all-in-focus, even soft studio lighting from front, high detail, crisp clean lines, no motion blur, no depth of field, no bokeh, no shallow focus, no blur effect, professional product photography of a toy character, 1:1 square aspect ratio, centered composition.",
    identity:
      "Use the reference face with HIGH identity fidelity: preserve exact eye shape, eyelid type, eye spacing, eyebrow thickness and angle, nose bridge height, nose tip shape, lip shape, jaw width, cheekbone prominence, face roundness, skin tone, ethnicity, age appearance. The character face must be strongly and clearly recognizable as the SAME specific reference person, keeping their distinctive unique facial features and proportions intact, reinterpreted in the plush chibi office character style described above.",
    // 화질 저하 + 비율 이탈(현실적/큰키/긴다리) + 입력 아티팩트(손 얼굴근처·브이·잘린머리) 배제.
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

// 게임플레이 노출 없음(서버 전용, /api/fal 만 소비). 공개 projection 미지정.
export const generationEntry: DomainEntry<GenerationConfig> = {
  schema: generationConfigSchema,
  codeDefault: GENERATION_CONFIG_DEFAULT,
};
