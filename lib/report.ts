import { resolveWeapon } from "@/lib/weapons";

/**
 * 게임 결과 → "스트레스 해소 결과 보고서" 데이터.
 * GameOverModal (클라) 과 /share/[scoreId] (서버) 가 공용.
 */

export type ReportGrade = {
  /** 등급 라벨 (직급 패러디) */
  label: string;
  /** 등급 한 줄 평 */
  comment: string;
};

const GRADES: { min: number; label: string; comment: string }[] = [
  { min: 8000, label: "전설의 퇴사자", comment: "사직서가 결재를 기다립니다" },
  { min: 5000, label: "해탈한 부장", comment: "이미 부장을 초월하셨습니다" },
  { min: 3000, label: "스트레스 차장", comment: "승진 대신 해소를 택했습니다" },
  { min: 1500, label: "분노의 과장", comment: "과장님, 손목 조심하세요" },
  { min: 600, label: "성실한 대리", comment: "꾸준함이 무기입니다" },
  { min: 1, label: "패기의 신입", comment: "첫 정산치고 나쁘지 않네요" },
  { min: 0, label: "무급 인턴", comment: "아직 결재할 내용이 없습니다" },
];

export function gradeFor(score: number): ReportGrade {
  const g = GRADES.find((g) => score >= g.min) ?? GRADES[GRADES.length - 1];
  return { label: g.label, comment: g.comment };
}

/** 점수대별 부장님 반응 한마디 (보고서 하단 "피드백" 란) */
const BOSS_REACTIONS: { min: number; lines: string[] }[] = [
  {
    min: 5000,
    lines: [
      "자, 자네... 잠깐 휴가 좀 다녀오게",
      "내가 뭘 그렇게 잘못했나...",
      "인사팀에는 비밀로 하지",
    ],
  },
  {
    min: 1500,
    lines: [
      "이게 최선입니까? 더 칠 수 있잖아",
      "아야, 야무지게도 때리네",
      "스트레스가 많이 쌓였었구만...",
    ],
  },
  {
    min: 1,
    lines: [
      "겨우 이 정도야? 라떼는 말이야...",
      "벌써 끝? 패기가 부족하군",
      "내일 또 보자고",
    ],
  },
  { min: 0, lines: ["...때리긴 한 건가?"] },
];

/** scoreId 기반 결정적 선택 — 같은 공유 링크는 항상 같은 멘트 (SSR/CSR 일치) */
export function bossReaction(score: number, seed: string): string {
  const bucket =
    BOSS_REACTIONS.find((b) => score >= b.min) ??
    BOSS_REACTIONS[BOSS_REACTIONS.length - 1];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return bucket.lines[Math.abs(h) % bucket.lines.length];
}

export function weaponLabel(key: string): string {
  const w = resolveWeapon(key);
  return `${w.emoji} ${w.label}`;
}

export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

/** 보고서 문서번호 — 공유 링크마다 고정 (scoreId 앞 8자) */
export function reportNo(scoreId: string, createdAt: string | Date): string {
  const d = new Date(createdAt);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
  return `제${ymd}-${scoreId.slice(0, 4).toUpperCase()}호`;
}
