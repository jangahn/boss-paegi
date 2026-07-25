import type { GenerationPlan } from "./plan";

/** 후보 1건 제출 결과 — index 는 원 candidate index(재번호화 금지). requestId=null 이면 이 후보 제출 실패. */
export type SubmitResult = {
  index: number;
  requestId: string | null;
  status: "submitted" | "failed";
};

export type SubmitPlanInput = {
  /** 사용자 얼굴 이미지 URL (Supabase signed URL — 짧은 TTL). identity 참조. */
  faceImageUrl: string;
  /** route 가 config 로 만든 순수 계획(후보별 프롬프트·정장색 + 수치 스냅샷). */
  plan: GenerationPlan;
};

export type GeneratedImage = {
  url: string;
  width: number;
  height: number;
};

export interface CharacterProvider {
  /** 식별자. selectProvider 가 이 키로 매칭. */
  readonly name: string;
  /** template 분리 입력 지원 여부. */
  readonly supportsTemplate: boolean;
  /**
   * 계획의 후보들을 fal 큐에 **allSettled 제출**(부분 성공 허용) — 접수된 requestId 를 유실하지 않는다.
   * 후보별 {index, requestId, status} 반환. 결과 회수/저장은 generation-recovery 담당.
   */
  submitPlan(input: SubmitPlanInput): Promise<SubmitResult[]>;
}
