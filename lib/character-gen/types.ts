import type { GenerationPlan } from "./plan";

/** 후보 1건 제출 결과 — index 는 원 candidate index(재번호화 금지). requestId=null 이면 이 후보 제출 실패. */
export type SubmitResult = {
  index: number;
  requestId: string | null;
  status: "submitted" | "failed" | "uncertain";
  httpStatus: number | null;
};

export type SubmitPlanInput = {
  /** 사용자 얼굴 이미지 URL (Supabase signed URL — 짧은 TTL). identity 참조. */
  faceImageUrl: string;
  /** route 가 config 로 만든 순수 계획(후보별 프롬프트·정장색 + 수치 스냅샷). */
  plan: GenerationPlan;
  /** DB single-attempt claim을 확정한 후보와 그 후보 전용 callback URL. */
  submitCandidates: readonly {
    index: number;
    webhookUrl: string;
    input: Readonly<Record<string, unknown>>;
  }[];
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
   * DB claim이 확정된 후보만 fal 큐에 각 1회 제출한다. transport 결과가 불확실하면
   * 재시도하지 않고 uncertain을 반환하며 signed webhook이 requestId를 복구한다.
   */
  submitPlan(input: SubmitPlanInput): Promise<SubmitResult[]>;
}
