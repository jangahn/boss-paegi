import type { RoleId } from "@/lib/roles";

export type CharacterGenInput = {
  /** 사용자 얼굴 이미지 URL (Supabase signed URL — 짧은 TTL). identity 만 참고. */
  faceImageUrl: string;
  /** 우리 template 캐릭터 URL. 구도·비율·스타일·배경의 기준. */
  templateImageUrl: string;
  /** 추가 prompt hint (예: "더 화난 표정"). 기본 prompt 뒤에 붙음. */
  promptHints?: string;
  /** 생성 후보 수 (기본 3) */
  numImages?: number;
  /** 입력 얼굴이 안경을 썼는지 — true 면 프롬프트에 안경 절 주입(조건부 반영) */
  wearsGlasses?: boolean;
  /** 생성 시 선택한 롤 — 복장·표정·분위기 프롬프트 분기 (기본 boss) */
  role?: RoleId;
};

export type GeneratedImage = {
  url: string;
  width: number;
  height: number;
};

export interface CharacterProvider {
  /** 식별자. selectProvider 가 이 키로 매칭. */
  readonly name: string;
  /** template 분리 입력 지원 여부 (multi-ref 계열은 true, face-only 계열은 false). */
  readonly supportsTemplate: boolean;
  /**
   * 비동기 제출 — fal 큐에 num 건 등록만 하고 request_id 들을 반환(결과 대기 X).
   * 결과 회수/후보 저장은 복구 경로(generation-recovery)가 queue.status/result 로 담당.
   */
  submitGeneration(input: CharacterGenInput): Promise<string[]>;
}
