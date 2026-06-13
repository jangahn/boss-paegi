import { scoreTier, TIER_COUNT } from "@/lib/report";

/**
 * 부장님 시비 멘트. 게임 진행 중 주기적으로 말풍선으로 노출 — 패고 싶게 만드는 게 목적.
 * 한국 직장인 밈/실제 갑질 사례 기반. 비방·욕설은 의도적으로 제외 (정책 준수).
 *
 * lib/report.ts 의 scoreTier() 와 동일한 10단계를 공유 — 점수가 오를수록
 * 갑질·무시(초반) → 발끈·짜증(중반) → 다급·굴복(후반) 으로 톤이 바뀐다.
 */
const TAUNT_TIERS: readonly (readonly string[])[] = [
  // 0 (0~9999) — 여유로운 갑질·무시
  ["이거 보고서 다시 써와", "왜 이거밖에 못 해?", "야 너 몇 살이야?", "라떼는 말이야..."],
  // 1 — 잔소리
  ["주말에 잠깐 출근해야지?", "회식 빠질 거야?", "맞춤법은 좀 보고 보내라", "퇴근하려고? 벌써?"],
  // 2 — 비교·훈계
  ["내가 너 나이 때는 더 했어", "넌 왜 이렇게 의욕이 없냐", "이메일 답장 왜 이리 늦어", "처음부터 다시"],
  // 3 — 발끈 시작
  ["어디서 그런 걸 배워와?", "이게 보고서야 일기야", "야 잠깐 이리 와봐", "어허, 이 친구가?"],
  // 4 — 짜증
  ["지금 나한테 대드는 거야?", "너 인사고과 각오해", "이런 식으로 일할 거면 그만둬", "표정이 그게 뭐야"],
  // 5 — 당황
  ["야, 야 잠깐...", "왜 이렇게 흥분해", "우리 대화로 풀자", "진정 좀 하지 그래"],
  // 6 — 회유
  ["미, 미안하다고", "내가 좀 심했나...?", "휴가 갈래? 휴가 줄게", "그만하면 안 될까"],
  // 7 — 매수
  ["법인카드 줄게!", "승진시켜줄게, 손 멈춰봐", "회식 다신 안 할게", "제발 좀..."],
  // 8 — 굴복
  ["사직서 받아줄게", "다 네 말이 맞아", "내가 졌다, 졌어", "사, 살려줘..."],
  // 9 — 항복
  ["회장님이라 부르겠습니다", "충성을 맹세합니다", "목숨만은...", "당신이 최고입니다"],
];

/** 피격 시 짧게 반응하는 멘트 (좀 더 짧고 격앙) */
export const HIT_REACTIONS: readonly string[] = [
  "윽!",
  "야!",
  "그만!",
  "이게 뭐 하는 짓이야!",
  "어디 감히!",
  "너 이리 와!",
  "아얏!",
  "커헉!",
] as const;

/** 하위호환 — 전체 풀 (점수 모름 호출용) */
export const TAUNTS: readonly string[] = TAUNT_TIERS.flat();

/**
 * 점수대(10단계)에 맞는 시비 멘트 랜덤 선택.
 * 해당 단계 풀 + 직전 멘트 제외. score 미지정 시 0단계.
 */
export function randomTaunt(exclude?: string, score = 0): string {
  const tier = Math.min(TIER_COUNT - 1, scoreTier(score));
  const pool = TAUNT_TIERS[tier];
  let candidate = pool[Math.floor(Math.random() * pool.length)];
  if (exclude && candidate === exclude && pool.length > 1) {
    candidate = pool[Math.floor(Math.random() * pool.length)];
  }
  return candidate;
}
