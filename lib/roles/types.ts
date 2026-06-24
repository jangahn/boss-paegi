/**
 * 캐릭터 롤별 콘텐츠 타입. 롤이 추가될수록 캐릭터 보이스(멘트/의견/인사기록 등)가
 * ×n 으로 늘어난다. 점수 10단계(scoreTier)를 공유하므로 tier 배열은 **정확히 10개**여야
 * 하며, TieredLines 튜플 타입이 이를 컴파일 타임에 강제한다(누락 방지).
 */

/** 점수 10단계 × 각 단계 문구들. 길이가 정확히 10이 아니면 타입 에러. */
export type TieredLines = readonly [
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
  readonly string[],
];

export type RoleContent = {
  /** 피격자 의견 (게임오버/공유 보고서). 10단계 × 여러 줄, seed 결정적 선택. */
  reactions: TieredLines;
  /** 시비 멘트 (플레이 중 말풍선). 10단계 × 여러 줄. */
  taunts: TieredLines;
  /** 공유 OG 후킹 문구. 10단계 × 보통 1줄. **조사 포함 완성형**. */
  ogLines: TieredLines;
  /** 인사기록 특이사항. */
  traits: readonly string[];
  /** 인사기록 직급. */
  ranks: readonly string[];
  /** 인사기록 소속. */
  departments: readonly string[];
};
