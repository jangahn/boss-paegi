// 입력 얼굴 분석 — 순수 파싱·계약(서버 전용 아님 → node --test 가능). fal 호출은 lib/fal.ts.
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

export type FaceCheck = { key: string; prompt: string; rawOutput: string | null };

export type FaceAnalysis = {
  /** 또렷한 얼굴 존재. false = 제출·차감 전 반려(no_face). */
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
  status: "ok" | "fail_open";
};

/**
 * moondream 각 체크의 raw 답변 → 정규화 판정. **명시적 위반일 때만 차단(fail-open)** — 파싱실패·모호·
 * 미검출(null)은 통과시켜 정상 사진 오반려를 방지한다. `\bno\b`/`\byes\b` 는 단어경계라 nose/cannot 등
 * 오매칭 없음. count 는 첫 정수(미검출 null → single 통과).
 */
export function interpretFaceChecks(raw: Record<FaceCheckKey, string | null>): {
  faceVisible: boolean;
  peopleCount: number | null;
  singlePerson: boolean;
  faceClear: boolean;
  wearsGlasses: boolean;
} {
  const norm = (v: string | null) => (v ?? "").toLowerCase();
  const m = norm(raw.count).match(/\d+/);
  const peopleCount = m ? Number(m[0]) : null;
  return {
    faceVisible: !/\bno\b/.test(norm(raw.face)), // "no" 명시 → 얼굴 없음
    peopleCount,
    singlePerson: peopleCount == null ? true : peopleCount <= 1, // 2명+ → 반려
    faceClear: !/\byes\b/.test(norm(raw.covered)), // "yes"(가림) 명시 → 반려
    wearsGlasses: /\byes\b/.test(norm(raw.glasses)),
  };
}
