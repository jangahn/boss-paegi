import {
  assembleGenerationPrompts,
  type GenerationConfig,
} from "@/lib/config/domains/generation";
import type { RoleId } from "@/lib/roles";

// 고정(비-config) fal 파라미터 — 노출하지 않되 provider default drift 제거 위해 명시 제출·기록.
export const FIXED_FLUX = {
  provider: "flux-pulid",
  model: "fal-ai/flux-pulid",
  idWeight: 1,
  candidateCount: 3,
  enableSafetyChecker: true,
  maxSequenceLength: 128,
} as const;

export type GenCandidatePlan = { index: number; suitColor: string; positivePrompt: string };

export type GenRequestParams = {
  imageSize: string;
  numInferenceSteps: number;
  guidanceScale: number;
  trueCfg: number;
  idWeight: number;
  candidateCount: number;
  enableSafetyChecker: boolean;
  maxSequenceLength: number;
};

export type GenSnapshot = {
  headTemplate: string;
  tail: string;
  identity: string;
  negative: string;
  glassesPrompt: string;
  glassesIdentityPrompt: string;
  subject: string;
  attireTemplate: string;
  expression: string;
};

export type GenerationPlan = {
  request: GenRequestParams;
  snapshot: GenSnapshot;
  negative: string;
  candidates: GenCandidatePlan[];
};

/**
 * 순수 계획 — config + role + 안경 + 후보수 → 후보별 최종 positive prompt·정장색 + 고정/config 수치 스냅샷.
 * 외부 호출(fal) 없음. route 가 제출 **전에** 이 계획을 provenance 로 선저장한 뒤 submit 한다(부분실패 손실 방지).
 * 색 셔플만 랜덤(후보 베리에이션) — 그 외 결정적.
 */
export function buildGenerationPlan(
  config: GenerationConfig,
  opts: { role: RoleId; wearsGlasses: boolean; numImages: number }
): GenerationPlan {
  const { role, wearsGlasses, numImages } = opts;
  const rv = config.prompt.roles[role];
  const colors = [...config.prompt.suitColors].sort(() => Math.random() - 0.5).slice(0, numImages);
  const candidates: GenCandidatePlan[] = colors.map((suitColor, index) => {
    const { positive } = assembleGenerationPrompts(config.prompt, role, { wearsGlasses, suitColor });
    return { index, suitColor, positivePrompt: positive };
  });
  return {
    request: {
      imageSize: config.numbers.imageSize,
      numInferenceSteps: config.numbers.numInferenceSteps,
      guidanceScale: config.numbers.guidanceScale,
      trueCfg: config.numbers.trueCfg,
      idWeight: FIXED_FLUX.idWeight,
      candidateCount: FIXED_FLUX.candidateCount,
      enableSafetyChecker: FIXED_FLUX.enableSafetyChecker,
      maxSequenceLength: FIXED_FLUX.maxSequenceLength,
    },
    snapshot: {
      headTemplate: config.prompt.headTemplate,
      tail: config.prompt.tail,
      identity: config.prompt.identity,
      negative: config.prompt.negative,
      glassesPrompt: config.prompt.glassesPrompt,
      glassesIdentityPrompt: config.prompt.glassesIdentityPrompt,
      subject: rv.subject,
      attireTemplate: rv.attireTemplate,
      expression: rv.expression,
    },
    negative: config.prompt.negative,
    candidates,
  };
}
