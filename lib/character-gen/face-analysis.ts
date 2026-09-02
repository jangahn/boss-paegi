// 입력 얼굴 분석 — 순수 파싱·계약(서버 전용 아님 → node --test 가능).
// 실제 moondream 호출은 서명 큐+webhook saga 인 face-check-submit.ts 가 한다.
//
// ⚠️ moondream3-preview/query 는 **compound(복수 질문) 프롬프트를 첫 질문만 답하고 나머지를 무시**한다
// (실측: "face=.. single=.. complete=.. clear=.." 요청에 `face:yes` 만 반환 → 나머지 parse 전부 fail-open
// → 모든 사진 통과 = 검증 무력화). JSON 요청도 single/clear 필드에서 true 편향. 따라서 **체크별 단일질문을
// 1콜씩 병렬** 호출한다(실측상 단일질문은 신뢰성 있게 판별). 정수리 잘림은 moondream 으로 정상 사진까지
// 오반려해 신뢰성 있게 못 잡으므로 **입력 반려 대상에서 제외**(생성 프롬프트로 완결성 유도 — 사용자 결정).

export const MOONDREAM_MODEL = "fal-ai/moondream3-preview/query";
export const MOONDREAM_RAW_MAX = 200; // 답변은 yes/no/숫자로 짧음 — provenance 절단 상한.

// 체크별 단일질문. 값은 provenance 에 스냅샷된다(코드 변경 시 이력 자기완결).
export const FACE_CHECK_PROMPTS = {
  face: "Is there a clearly visible human face in this photo? Answer only yes or no.",
  count: "How many people are in this photo? Answer with a single number only.",
  covered:
    "Is any part of the person's face covered or blocked by a hand, fingers, or an object? Answer only yes or no.",
  glasses: "Is the person wearing eyeglasses or sunglasses? Answer only yes or no.",
} as const;

export type FaceCheckKey = keyof typeof FACE_CHECK_PROMPTS;
export const FACE_CHECK_KEYS = ["face", "count", "covered", "glasses"] as const;

// 입력 게이트 반려 사유(유료 이미지 생성 제출 전 400). 일반 회원은 DB 선차감 영수증을
// 같은 실패 전이에서 원자 환급한다. route 게이트가 세팅하는 fail_reason 과, 어드민이 '거부'로
// 분류하는 fail_reason 집합이 **일치**해야 하므로 단일 정본으로 둔다. fal 제출 후 no-face(recovery)도
// 같은 no_face 라 '거부'로 함께 분류됨. 그 외 실패(fal_error/timeout/…)는 '기타실패'.
export const INPUT_REJECT_REASONS = ["no_face", "multiple_people", "face_obstructed"] as const;
export type InputRejectReason = (typeof INPUT_REJECT_REASONS)[number];

export type FaceCheck = { key: string; prompt: string; rawOutput: string | null };

export type FaceAnalysis = {
  /** 또렷한 얼굴 존재. false = 유료 생성 제출 전 반려·환급(no_face). */
  faceVisible: boolean;
  /** 사진에 사람이 1명 이하. false(2명+) = 반려(multiple_people). */
  singlePerson: boolean;
  /** 감지된 인원 수(미검출 시 null). */
  peopleCount: number | null;
  /** 손·물건이 얼굴을 가리지 않음. false = 반려(face_obstructed). */
  faceClear: boolean;
  /** 안경 착용 — PuLID 안경 유지 프롬프트 조건부 반영(반려 아님). */
  wearsGlasses: boolean;
  model: string;
  /** 각 체크의 프롬프트·원문(진단·감사). 실패 체크는 rawOutput=null. */
  checks: FaceCheck[];
  /**
   * 신규 생성은 필수 체크가 모두 명확할 때만 진행하므로 항상 ok다.
   * 과거 `fail_open` provenance 파싱 호환은 provenance schema에만 남긴다.
   */
  status: "ok";
};

export class FaceAnalysisUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FaceAnalysisUnavailableError";
  }
}

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Face-preflight replay reads a DB-persisted analysis instead of paying for a
 * second Moondream request. Treat that JSON as untrusted: corruption or a
 * partially-written legacy shape must fail closed rather than silently
 * bypassing the input gate.
 */
export function parsePersistedFaceAnalysis(value: unknown): FaceAnalysis | null {
  const row = exactObject(value);
  if (
    !row ||
    row.model !== MOONDREAM_MODEL ||
    row.status !== "ok" ||
    typeof row.faceVisible !== "boolean" ||
    typeof row.singlePerson !== "boolean" ||
    typeof row.faceClear !== "boolean" ||
    typeof row.wearsGlasses !== "boolean" ||
    !(
      row.peopleCount === null ||
      (Number.isSafeInteger(row.peopleCount) &&
        (row.peopleCount as number) >= 0 &&
        (row.peopleCount as number) <= 1000)
    ) ||
    !Array.isArray(row.checks) ||
    row.checks.length !== FACE_CHECK_KEYS.length
  ) {
    return null;
  }
  const checks: FaceCheck[] = [];
  for (let index = 0; index < FACE_CHECK_KEYS.length; index += 1) {
    const key = FACE_CHECK_KEYS[index];
    const check = exactObject(row.checks[index]);
    if (
      !check ||
      check.key !== key ||
      check.prompt !== FACE_CHECK_PROMPTS[key] ||
      !(
        check.rawOutput === null ||
        (typeof check.rawOutput === "string" &&
          check.rawOutput.length <= MOONDREAM_RAW_MAX)
      )
    ) {
      return null;
    }
    checks.push({
      key,
      prompt: FACE_CHECK_PROMPTS[key],
      rawOutput: check.rawOutput as string | null,
    });
  }
  if (
    row.singlePerson !== ((row.peopleCount as number) <= 1) ||
    (row.faceVisible && row.peopleCount === 0) ||
    (!row.faceVisible && (row.peopleCount as number) > 0)
  ) {
    return null;
  }
  return {
    faceVisible: row.faceVisible,
    singlePerson: row.singlePerson,
    peopleCount: row.peopleCount as number | null,
    faceClear: row.faceClear,
    wearsGlasses: row.wearsGlasses,
    model: MOONDREAM_MODEL,
    checks,
    status: "ok",
  };
}

function parseUnambiguousYesNo(value: string | null): boolean | null {
  const answers = (value ?? "").toLowerCase().match(/\b(?:yes|no)\b/g);
  if (!answers || answers.length !== 1) return null;
  return answers[0] === "yes";
}

function parseUnambiguousPeopleCount(value: string | null): number | null {
  // 문장 마침표("1.")는 수용하고 소수("1.5")만 거부한다 — 프롬프트가
  // "Answer with a single number only."라 마침표 부착이 개연적 스타일이다.
  const matches = Array.from(
    (value ?? "").matchAll(/(?:^|[^\d.+-])(\d+)(?!\d)(?!\.\d)/g),
    (match) => match[1],
  );
  if (matches.length !== 1) return null;
  const parsed = Number(matches[0]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * moondream 각 체크의 raw 답변 → 정규화 판정.
 *
 * 생성 비용·얼굴 입력 정책을 결정하는 권위 게이트이므로 파싱 실패나
 * 일부 dependency 실패를 정상 사진으로 추정하지 않는다. 모호하면 호출자가 503으로
 * 재시도시키며, 생성 row/크레딧/FAL 생성 제출은 시작하지 않는다.
 */
export function interpretFaceChecks(raw: Record<FaceCheckKey, string | null>): {
  faceVisible: boolean;
  peopleCount: number | null;
  singlePerson: boolean;
  faceClear: boolean;
  wearsGlasses: boolean;
} {
  const faceVisible = parseUnambiguousYesNo(raw.face);
  const peopleCount = parseUnambiguousPeopleCount(raw.count);
  const faceCovered = parseUnambiguousYesNo(raw.covered);
  const wearsGlasses = parseUnambiguousYesNo(raw.glasses);
  if (
    faceVisible === null ||
    peopleCount === null ||
    faceCovered === null ||
    wearsGlasses === null
  ) {
    throw new FaceAnalysisUnavailableError("ambiguous_face_analysis");
  }
  // face("clearly visible face")와 count("How many people")는 서로 다른
  // 술어다 — face=no+count=1(사람은 있으나 얼굴이 안 보임)은 모순이 아니라
  // no_face 재촬영 안내로 합류해야 하는 정상 조합이다(기준선 동작).
  return {
    faceVisible,
    peopleCount,
    singlePerson: peopleCount <= 1,
    faceClear: !faceCovered,
    wearsGlasses,
  };
}

/** Build the one canonical persisted analysis from four durable webhook rows. */
export function buildFaceAnalysis(
  raw: Record<FaceCheckKey, string | null>,
): FaceAnalysis {
  const interpreted = interpretFaceChecks(raw);
  return {
    ...interpreted,
    model: MOONDREAM_MODEL,
    checks: FACE_CHECK_KEYS.map((key) => ({
      key,
      prompt: FACE_CHECK_PROMPTS[key],
      rawOutput: raw[key],
    })),
    status: "ok",
  };
}
