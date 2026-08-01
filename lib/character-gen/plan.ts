// generation 도메인은 상대 .ts 경로 — node --test(테스트벤치 등)에서 별칭 로더 없이 로드 가능 유지.
import {
  assembleGenerationPrompts,
  convertGenerationRoleBodyV1toV2,
  convertGenerationTemplateV1toV2,
  type GenerationConfig,
} from "../config/domains/generation.ts";
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

// generation_config v2 감사 스냅샷(표시 전용) — 최종 프롬프트는 candidates.positivePrompt 가 소유.
export type GenSnapshot = {
  template: string;
  roleSubject: string;
  roleBody: string;
  glasses: string;
  glassesIdentity: string;
  negative: string;
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
  const parsedSnapshot = parsePersistedGenSnapshot(snapshot);
  if (!parsedSnapshot) {
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
    snapshot: parsedSnapshot,
    negative: row.negative,
    candidates,
  };
}

const SNAPSHOT_KEYS: readonly (keyof GenSnapshot)[] = [
  "glasses",
  "glassesIdentity",
  "negative",
  "roleBody",
  "roleSubject",
  "template",
];
// 배포 경계 창 back-compat — v2 배포 전에 커밋된 plan 의 v1 스냅샷 키.
const LEGACY_SNAPSHOT_KEYS = [
  "attireTemplate",
  "expression",
  "glassesIdentityPrompt",
  "glassesPrompt",
  "headTemplate",
  "identity",
  "negative",
  "subject",
  "tail",
] as const;

function allBoundedStrings(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every(
    (key) =>
      typeof record[key] === "string" && (record[key] as string).length <= 4000,
  );
}

/**
 * 스냅샷은 표시 전용 감사 데이터(최종 프롬프트는 candidates 가 소유) — v2 키를 정확히 요구하되,
 * v2 배포 전 커밋된 v1 스냅샷은 v1 고정 스캐폴드 전개(converter 와 동일 규칙)로 매핑해 수용한다.
 */
function parsePersistedGenSnapshot(
  snapshot: Record<string, unknown>,
): GenSnapshot | null {
  const joined = Object.keys(snapshot).sort().join(",");
  if (joined === SNAPSHOT_KEYS.join(",")) {
    if (!allBoundedStrings(snapshot, SNAPSHOT_KEYS)) return null;
    return {
      template: snapshot.template as string,
      roleSubject: snapshot.roleSubject as string,
      roleBody: snapshot.roleBody as string,
      glasses: snapshot.glasses as string,
      glassesIdentity: snapshot.glassesIdentity as string,
      negative: snapshot.negative as string,
    };
  }
  if (joined === LEGACY_SNAPSHOT_KEYS.join(",")) {
    if (!allBoundedStrings(snapshot, LEGACY_SNAPSHOT_KEYS)) return null;
    return {
      template: convertGenerationTemplateV1toV2(
        snapshot.headTemplate as string,
        snapshot.tail as string,
        snapshot.identity as string,
      ),
      roleSubject: snapshot.subject as string,
      roleBody: convertGenerationRoleBodyV1toV2(
        snapshot.attireTemplate as string,
        snapshot.expression as string,
      ),
      glasses: snapshot.glassesPrompt as string,
      glassesIdentity: snapshot.glassesIdentityPrompt as string,
      negative: snapshot.negative as string,
    };
  }
  return null;
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
      template: config.prompt.template,
      roleSubject: rv.subject,
      roleBody: rv.body,
      glasses: config.prompt.glasses,
      glassesIdentity: config.prompt.glassesIdentity,
      negative: config.prompt.negative,
    },
    negative: config.prompt.negative,
    candidates,
  };
}
