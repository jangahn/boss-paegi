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
  // 256: 본문 T5 토큰이 128을 넘어 뒤쪽(identity 블록)이 절단될 개연성 —
  // fal 과금은 장당 고정이라 상향 비용 0 (2026-08-01 제품 결정).
  maxSequenceLength: 256,
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

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Strictly validate the immutable plan snapshot read on continuation. */
export function parsePersistedGenerationPlan(
  value: unknown,
): GenerationPlan | null {
  const row = exactObject(value);
  const request = exactObject(row?.request);
  const snapshot = exactObject(row?.snapshot);
  if (
    !row ||
    Object.keys(row).sort().join(",") !==
      "candidates,negative,request,snapshot" ||
    !request ||
    !snapshot ||
    typeof row.negative !== "string" ||
    row.negative.length < 1 ||
    row.negative.length > 4000 ||
    !Array.isArray(row.candidates) ||
    row.candidates.length !== FIXED_FLUX.candidateCount ||
    request.idWeight !== FIXED_FLUX.idWeight ||
    request.candidateCount !== FIXED_FLUX.candidateCount ||
    request.enableSafetyChecker !== FIXED_FLUX.enableSafetyChecker ||
    request.maxSequenceLength !== FIXED_FLUX.maxSequenceLength ||
    typeof request.imageSize !== "string" ||
    !Number.isSafeInteger(request.numInferenceSteps) ||
    typeof request.guidanceScale !== "number" ||
    !Number.isFinite(request.guidanceScale) ||
    typeof request.trueCfg !== "number" ||
    !Number.isFinite(request.trueCfg)
  ) {
    return null;
  }
  const snapshotKeys = [
    "attireTemplate",
    "expression",
    "glassesIdentityPrompt",
    "glassesPrompt",
    "headTemplate",
    "identity",
    "negative",
    "subject",
    "tail",
  ];
  if (
    Object.keys(snapshot).sort().join(",") !== snapshotKeys.join(",") ||
    snapshotKeys.some(
      (key) =>
        typeof snapshot[key] !== "string" ||
        (snapshot[key] as string).length > 4000,
    )
  ) {
    return null;
  }
  const candidates: GenCandidatePlan[] = [];
  for (let index = 0; index < row.candidates.length; index += 1) {
    const candidate = exactObject(row.candidates[index]);
    if (
      !candidate ||
      Object.keys(candidate).sort().join(",") !==
        "index,positivePrompt,suitColor" ||
      candidate.index !== index ||
      typeof candidate.suitColor !== "string" ||
      candidate.suitColor.length < 1 ||
      candidate.suitColor.length > 100 ||
      typeof candidate.positivePrompt !== "string" ||
      candidate.positivePrompt.length < 1 ||
      candidate.positivePrompt.length > 8000
    ) {
      return null;
    }
    candidates.push({
      index,
      suitColor: candidate.suitColor,
      positivePrompt: candidate.positivePrompt,
    });
  }
  return {
    request: request as GenerationPlan["request"],
    snapshot: snapshot as GenerationPlan["snapshot"],
    negative: row.negative,
    candidates,
  };
}

/**
 * 순수 계획 — config + role + 안경 + 후보수 → 후보별 최종 positive prompt·정장색 + 고정/config 수치 스냅샷.
 * 외부 호출(fal) 없음. route 가 제출 **전에** 이 계획을 provenance 로 선저장한 뒤 submit 한다(부분실패 손실 방지).
 * 색 셔플은 요청 identity로 seed된 Fisher-Yates다. 같은 durable request가
 * commit 전 충돌·재시작·배포를 거쳐도 정확히 같은 계획을 다시 계산한다.
 */
function seededRandom(seed: string): () => number {
  if (seed.length < 1 || seed.length > 512) {
    throw new Error("generation_plan_seed_invalid");
  }
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function fisherYatesShuffle<T>(
  values: readonly T[],
  random: () => number,
): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error("generation_plan_rng_invalid");
    }
    const swapIndex = Math.floor(sample * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

export function buildGenerationPlan(
  config: GenerationConfig,
  opts: {
    role: RoleId;
    wearsGlasses: boolean;
    numImages: number;
    seed: string;
  },
): GenerationPlan {
  const { role, wearsGlasses, numImages, seed } = opts;
  const rv = config.prompt.roles[role];
  const colors = fisherYatesShuffle(
    config.prompt.suitColors,
    seededRandom(seed),
  ).slice(0, numImages);
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
