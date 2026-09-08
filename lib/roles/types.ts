/**
 * 캐릭터 롤별 콘텐츠 타입. 롤이 추가될수록 캐릭터 보이스(멘트/의견/인사기록 등)가
 * ×n 으로 늘어난다. 점수 5단계(lib/score-tiers.ts `TIER_COUNT`)를 공유하므로 tier 배열은
 * **정확히 5개**여야 하며, TieredLines 튜플 타입이 이를 컴파일 타임에 강제한다(누락 방지).
 * 단계 경계는 score_config.thresholds(어드민)가 결정 — 콘텐츠는 순서(아크)만 안다.
 */

/** 점수 5단계 × 각 단계 문구들. 길이가 정확히 5가 아니면 타입 에러. */
export type TieredLines = readonly [
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
];

/** 성별 보이스 — 피격 반응·시비 멘트 한 벌(5단계 × 줄). 루트의 reactions/taunts 가 남성(기본) 보이스다. */
export type GenderVoice = {
  reactions: TieredLines;
  taunts: TieredLines;
};

export type RoleContent = {
  /** 피격자 의견 (게임오버/공유 보고서) — 남성(기본) 보이스. 5단계 × 여러 줄(시드 6줄), seed 결정적 선택. */
  reactions: TieredLines;
  /** 시비 멘트 (플레이 중 말풍선) — 남성(기본) 보이스. 5단계 × 여러 줄(시드 8줄). */
  taunts: TieredLines;
  /** 여성 보이스(v1.26) — 같은 5단계 아크, 롤 성격의 여성 변주(예: 여자 부장님 = 히스테리 중심). */
  female: GenderVoice;
  /** 인사기록 특이사항. */
  traits: readonly string[];
  /** 인사기록 직급. */
  ranks: readonly string[];
  /** 인사기록 소속. */
  departments: readonly string[];
};
