import { z } from "zod";

// ai_generations.gen_params 계약 — 생성 당시 파라미터·프롬프트·단계 감사 스냅샷(어드민 전용).
// **모델 weight 버전까지의 완전 재현 보장 아님.** 원본 사진·signed URL·storage token·이미지 bytes·
// FAL_KEY·에러 전문 등 비밀/PII 재노출 값은 절대 담지 않는다(문자열 스냅샷만).
// NULL gen_params = 기능 배포 전 또는 기록 없음(레거시). 미지원 schemaVersion 은 parse 시 null → 상세에서 '미지원' 표기.

export const PROVENANCE_SCHEMA_VERSION = 1;

const candidateSchema = z.object({
  index: z.number().int().min(0),
  suitColor: z.string(),
  positivePrompt: z.string(),
  requestId: z.string().nullable(),
  // seed 는 미회수 시 null(필드 생략 아님) — '미회수' 와 '스키마 부재' 구분.
  seed: z.number().nullable(),
  status: z.enum(["submitted", "completed", "failed"]),
  // fal 이 반환하면 진단용으로만(옵션).
  falPrompt: z.string().nullable().optional(),
  hasNsfw: z.boolean().nullable().optional(),
});

export type ProvenanceCandidate = z.infer<typeof candidateSchema>;

export const provenanceSchema = z.object({
  schemaVersion: z.literal(PROVENANCE_SCHEMA_VERSION),
  config: z.object({
    key: z.literal("generation_config"),
    source: z.enum(["db", "default"]),
    version: z.number().nullable(),
    invalid: z.boolean(),
  }),
  analyze: z.object({
    model: z.string(),
    status: z.enum(["ok", "fail_open"]),
    faceVisible: z.boolean(),
    wearsGlasses: z.boolean(),
    // 신규(2026-07: 체크별 병렬콜) — 구 레코드엔 없어 optional.
    singlePerson: z.boolean().optional(),
    peopleCount: z.number().nullable().optional(),
    faceClear: z.boolean().optional(),
    checks: z
      .array(
        z.object({
          key: z.string(),
          prompt: z.string(),
          rawOutput: z.string().nullable(),
        })
      )
      .optional(),
    // 레거시 단일콜 필드(구 레코드) — 신규는 checks 사용. 둘 다 optional.
    prompt: z.string().optional(),
    rawOutput: z.string().nullable().optional(),
  }),
  generation: z.object({
    provider: z.string(),
    model: z.string(),
    role: z.string(),
    request: z.object({
      imageSize: z.string(),
      numInferenceSteps: z.number(),
      guidanceScale: z.number(),
      trueCfg: z.number(),
      idWeight: z.number(),
      candidateCount: z.number().int(),
      enableSafetyChecker: z.boolean(),
      maxSequenceLength: z.number().int(),
    }),
    snapshot: z.object({
      headTemplate: z.string(),
      tail: z.string(),
      identity: z.string(),
      negative: z.string(),
      glassesPrompt: z.string(),
      glassesIdentityPrompt: z.string(),
      subject: z.string(),
      attireTemplate: z.string(),
      expression: z.string(),
    }),
    candidates: z.array(candidateSchema),
  }),
  postprocess: z
    .object({
      model: z.string(),
      candidateIndex: z.number().int(),
      completedAt: z.string(),
    })
    .nullable()
    .optional(),
  picked: z
    .object({
      candidateIndex: z.number().int(),
      dollId: z.string(),
      pickedAt: z.string(),
    })
    .nullable()
    .optional(),
});

export type GenProvenance = z.infer<typeof provenanceSchema>;

/** gen_params(unknown|null) → 검증된 provenance 또는 null(레거시/미지원/손상). 어드민 상세가 안전 표시. */
export function parseProvenance(value: unknown): GenProvenance | null {
  if (value == null) return null;
  const parsed = provenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 비밀/URL 유출 방지 가드 — 기록 직전 프롬프트·색 등 문자열 스냅샷만 있는지 라이트 체크(개발 안전망). */
export function assertNoSecrets(p: GenProvenance): void {
  const blob = JSON.stringify(p);
  // signed URL·supabase storage·fal.media·data URI·토큰 패턴이 스냅샷에 들어가면 계약 위반.
  if (/https?:\/\/|data:|token=|Bearer\s|\.supabase\.|fal\.media/i.test(blob)) {
    throw new Error("provenance_contains_forbidden_value");
  }
}
