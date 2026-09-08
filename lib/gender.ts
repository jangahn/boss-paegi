/**
 * 캐릭터 성별 축 — **순수 모듈**(import 0). 롤(id)과 직교하는 캐릭터(doll)의 두 번째 속성.
 *
 * 판정은 얼굴검사(moondream 5번째 단일질문)에서 1회, 저장은 ai_generations.gender → dolls.gender(pick 시 복사),
 * 소비는 생성 프롬프트(롤×성별 subject/body)와 보이스(롤×성별 반응/멘트) 두 곳뿐. 호칭·인사기록·마케팅 카피·
 * 등급·분석은 성별 무관. 판정 불가(unknown)·레거시·기본 부장님은 male 로 수렴(DB 컬럼 NOT NULL DEFAULT 'male').
 * 어드민은 캐릭터 상세에서 후처리로 바꿀 수 있다(보이스만 바뀜, 이미지 불변).
 */
export const GENDERS = ["male", "female"] as const;
export type Gender = (typeof GENDERS)[number];
export const DEFAULT_GENDER: Gender = "male";

/** 판정 원문 단계 값 — unknown 은 저장 전에 male 로 수렴하고 원문은 provenance 에만 남는다. */
export type DetectedGender = Gender | "unknown";

const GENDER_SET: ReadonlySet<string> = new Set(GENDERS);

export function isGender(v: unknown): v is Gender {
  return typeof v === "string" && GENDER_SET.has(v);
}

/** 외부 입력(DB/응답/판정) → Gender. 미지값·unknown·null 은 male. */
export function asGender(v: unknown): Gender {
  return isGender(v) ? v : DEFAULT_GENDER;
}

/** 어드민 표기(짧은 칩). */
export const GENDER_LABEL: Record<Gender, string> = { male: "남", female: "여" };
export const GENDER_SYMBOL: Record<Gender, string> = { male: "♂", female: "♀" };
