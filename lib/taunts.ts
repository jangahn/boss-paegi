/**
 * 부장님 시비 멘트. 게임 진행 중 주기적으로 말풍선으로 노출 — 패고 싶게 만드는 게 목적.
 * 한국 직장인 밈/실제 갑질 사례 기반. 비방·욕설은 의도적으로 제외 (정책 준수).
 */
export const TAUNTS: readonly string[] = [
  "이거 보고서 다시 써와",
  "라떼는 말이야...",
  "왜 이거밖에 못 해?",
  "야 너 몇 살이야?",
  "내일 아침 6시까지 보고서",
  "주말에 잠깐 출근해야지?",
  "회식 빠질 거야?",
  "넌 왜 이렇게 의욕이 없냐",
  "맞춤법은 좀 보고 보내라",
  "내가 너 나이 때는 더 했어",
  "이게 보고서야 일기야",
  "처음부터 다시",
  "야근 좀 해야 사회생활이지",
  "오늘 회의 30분만 더 하자",
  "어디서 그런 걸 배워와?",
  "퇴근하려고? 벌써?",
  "이메일 답장 왜 이리 늦어",
  "내가 다 해줄까?",
  "요즘 애들은 헝그리 정신이 없어",
  "야 부장님이 이름이야?",
  "나 때는 새벽까지 했어",
  "이거 다시 처음부터 검토해",
  "이런 식으로 일할 거면 그만둬",
  "야 잠깐 이리 와봐",
] as const;

/** 피격 시 짧게 반응하는 멘트 (좀 더 짧고 격앙). 후속 기능에서 활용 가능. */
export const HIT_REACTIONS: readonly string[] = [
  "윽!",
  "야!",
  "그만!",
  "이게 뭐 하는 짓이야!",
  "어디 감히!",
  "너 이리 와!",
] as const;

export function randomTaunt(exclude?: string): string {
  let candidate = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
  // 같은 멘트 연달아 안 나오게 한 번 재시도
  if (exclude && candidate === exclude && TAUNTS.length > 1) {
    candidate = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
  }
  return candidate;
}
