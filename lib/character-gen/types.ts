export type CharacterGenInput = {
  /** 사용자 얼굴 이미지 URL (Supabase signed URL — 짧은 TTL). identity 만 참고. */
  faceImageUrl: string;
  /** 우리 template 캐릭터 URL. 구도·비율·스타일·배경의 기준. */
  templateImageUrl: string;
  /** 추가 prompt hint (예: "더 화난 표정"). 기본 prompt 뒤에 붙음. */
  promptHints?: string;
  /** 생성 후보 수 (기본 3) */
  numImages?: number;
};

export type GeneratedImage = {
  url: string;
  width: number;
  height: number;
};

export type CharacterGenResult = {
  images: GeneratedImage[];
  provider: string;
  costCents: number;
  durationMs: number;
};

export interface CharacterProvider {
  /** 식별자. selectProvider 가 이 키로 매칭. */
  readonly name: string;
  /** template 분리 입력 지원 여부 (multi-ref 계열은 true, face-only 계열은 false). */
  readonly supportsTemplate: boolean;
  generate(input: CharacterGenInput): Promise<CharacterGenResult>;
}
