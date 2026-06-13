import { resolveWeapon } from "@/lib/weapons";

/**
 * 게임 결과 → "스트레스 해소 결과 보고서" 데이터.
 * GameOverModal (클라) 과 /share/[scoreId] (서버) 가 공용.
 *
 * ── 단일 10단계 소스 ──────────────────────────────────────────────
 * 점수 구간은 scoreTier() 한 곳에서만 결정한다 (갭 10000, 0~90000).
 * 판정 등급(=패는 사람의 경지), 부장님 피드백, OG 설명, play 시비 멘트
 * (lib/taunts.ts) 가 모두 동일한 10단계를 공유한다.
 */

export const TIER_STEP = 10000;
export const TIER_COUNT = 10;

/** 점수 → 0~9 단계 인덱스. 갭 10000, 90000+ 는 최상위(9). */
export function scoreTier(score: number): number {
  if (score <= 0) return 0;
  return Math.min(TIER_COUNT - 1, Math.floor(score / TIER_STEP));
}

/** 문자열 → 안정적 양수 해시 (seed 기반 결정적 선택용) */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type ReportGrade = {
  /** 등급 라벨 — "패는 사람"(직장인)의 스트레스 해소 경지 */
  label: string;
  /** 등급 한 줄 평 */
  comment: string;
};

/**
 * 판정 등급 — 패는 사람의 경지 10단계 (직장 탈출 서사).
 * index 0(0~9999) → 9(90000+). 최상위 = 전설의 퇴사자.
 */
const PLAYER_GRADES: ReportGrade[] = [
  { label: "무급 인턴", comment: "이제 막 손을 풀었습니다" }, // 0
  { label: "패기의 신입", comment: "스트레스를 알아갑니다" }, // 1
  { label: "열혈 사원", comment: "손맛이 제법입니다" }, // 2
  { label: "독기의 대리", comment: "응어리가 풀리기 시작합니다" }, // 3
  { label: "분노의 과장", comment: "이제 거침이 없습니다" }, // 4
  { label: "폭주 차장", comment: "이성을 살짝 놓았습니다" }, // 5
  { label: "광기의 부장", comment: "멈출 수가 없습니다" }, // 6
  { label: "해탈한 임원", comment: "경지에 올랐습니다" }, // 7
  { label: "사이다 마스터", comment: "막힌 속이 뻥 뚫립니다" }, // 8
  { label: "전설의 퇴사자", comment: "사직서와 함께 전설로 남았습니다" }, // 9
];

export function gradeFor(score: number): ReportGrade {
  return PLAYER_GRADES[scoreTier(score)];
}

/**
 * 부장님 피드백 (보고서 "피격자 의견" 란) — 맞는 부장님 입장.
 * index 0→9, 점수가 오를수록 굴복/항복 톤이 진해짐.
 */
const BOSS_LINES: string[][] = [
  ["...때리긴 한 건가?", "응? 뭐 했어?", "겨우 이 정도야?"], // 0
  ["라떼는 말이야...", "패기가 부족하군", "이래서 요즘 애들은..."], // 1
  ["오, 좀 하는데?", "어디서 배웠나?", "간지럽군, 더 해보게"], // 2
  ["어허, 이 친구가?", "야무지게도 때리네", "슬슬 아픈데, 이거..."], // 3
  ["이게 최선입니까? ...아니, 그만!", "손이 맵네 매워", "스트레스가 많이 쌓였구만"], // 4
  ["자, 자네 잠깐 진정 좀...", "이러다 큰일 나겠는데", "승진 한번 생각해볼까?"], // 5
  ["휴가 줄게! 휴가 갈래?", "내가 뭘 그렇게 잘못했나...", "인사팀엔 비밀로 하지"], // 6
  ["법인카드 줄 테니 좀 진정하게", "오늘 회식은 없던 걸로", "자네가 팀장 하게, 응?"], // 7
  ["사직서는... 제가 쓰겠습니다", "다음 생엔 부장 안 할게요", "자네가 완전히 이겼네"], // 8
  ["회장님이라 부르겠습니다...", "제발... 목숨만은...", "당신이 이 회사의 주인입니다"], // 9
];

/** scoreId 기반 결정적 선택 — 같은 공유 링크는 항상 같은 멘트 (SSR/CSR 일치) */
export function bossReaction(score: number, seed: string): string {
  const lines = BOSS_LINES[scoreTier(score)];
  return lines[hashSeed(seed) % lines.length];
}

/** OG 설명 — 단계별 후킹 강도 상승 (공유 미리보기가 점수마다 달라지게) */
const OG_LINES: string[][] = [
  ["스트레스 해소 결과 보고서가 도착했습니다."], // 0
  ["퇴근길 한 판. 당신도 부장님 패러 가기 →"], // 1
  ["오늘 스트레스, 슬슬 정산 중. 우리 부장님도 패러 가기 →"], // 2
  ["야무지게 한 판 했습니다. 당신의 부장님은 무사하십니까?"], // 3
  ["부장님이 슬슬 다급해집니다. 당신도 도전 →"], // 4
  ["이성을 놓은 정산. 우리 부장님도 패러 가기 →"], // 5
  ["부장님이 백기 직전입니다. 당신도 도전?"], // 6
  ["이 정도면 사표 수리각. 당신의 부장님은 무사하십니까?"], // 7
  ["속이 뻥 뚫리는 점수. 우리 부장님도 패러 가기 →"], // 8
  ["사내 전설이 강림했습니다. 당신의 부장님은 무사하십니까?"], // 9
];

export function ogDescription(score: number, seed: string): string {
  const lines = OG_LINES[scoreTier(score)];
  return lines[hashSeed(seed) % lines.length];
}

/** 인사기록카드 (공유된 인형 페이지) 특이사항 — id 시드 결정적 */
const DOLL_TRAITS = [
  "맞을수록 단단해지는 것으로 알려짐",
  "결재 서류만 보면 언성이 높아짐",
  "주말 출근을 즐기는 것으로 추정됨",
  "라떼 토크 무한 보유자",
  "회식 자리 마이크 독점 이력 다수",
  "퇴근 5분 전 업무 지시 전문",
  "본인 아재개그에 본인만 웃음",
  "엘리베이터에서 눈 마주치면 위험",
  "'요즘 애들은' 으로 모든 문장 시작",
  "카톡 답장 강요 상습범",
  "회의를 회의로 끝내지 않는 능력자",
  "본인 자리 비울 때만 평화로움",
];

export function dollTrait(seed: string): string {
  return DOLL_TRAITS[hashSeed(seed) % DOLL_TRAITS.length];
}

/** 인사기록카드 직급 — id 시드 결정적 (맞는 부장님 정보) */
const DOLL_RANKS = [
  "부장 (만년)",
  "자칭 임원",
  "낙하산 본부장",
  "악명 높은 팀장",
  "그림자 실세 차장",
  "전설의 꼰대 부장",
];

export function dollRank(seed: string): string {
  return DOLL_RANKS[hashSeed(seed + "rank") % DOLL_RANKS.length];
}

/** 인사기록카드 소속 — id 시드 결정적 */
const DOLL_DEPARTMENTS = [
  "스트레스 유발 1팀",
  "야근 강요 사업부",
  "꼰대 문화 본부",
  "회식 추진 위원회",
  "주말 출근 장려과",
  "라떼 전파 연구소",
];

export function dollDepartment(seed: string): string {
  return DOLL_DEPARTMENTS[hashSeed(seed + "dept") % DOLL_DEPARTMENTS.length];
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
