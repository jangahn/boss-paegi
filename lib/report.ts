import { resolveWeapon } from "@/lib/weapons";
import type { RoleId } from "@/lib/roles";
import { roleFrom, type RoleConfig } from "@/lib/config/domains/roles";

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
export const PLAYER_GRADES: ReportGrade[] = [
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

/** 등급 — grades 미지정 시 코드 기본값(score_config 미시드 폴백). tier 매핑(scoreTier)은 코드 고정. */
export function gradeFor(score: number, grades: ReportGrade[] = PLAYER_GRADES): ReportGrade {
  return grades[scoreTier(score)];
}

/**
 * 피격자 의견 (보고서) — 맞는 캐릭터(롤) 입장. 롤별 콘텐츠는 lib/roles 레지스트리.
 * index 0→9, 점수가 오를수록 굴복/항복 톤. scoreId 시드 결정적(SSR/CSR 일치).
 */
export function bossReaction(
  score: number,
  seed: string,
  role: RoleId = "boss",
  cfg?: RoleConfig
): string {
  const lines = roleFrom(role, cfg).reactions[scoreTier(score)];
  return lines[hashSeed(seed) % lines.length];
}

/** OG 설명 — 단계별 후킹 강도 상승. 롤별 완성형(조사 포함)은 role_content 설정. */
export function ogDescription(
  score: number,
  seed: string,
  role: RoleId = "boss",
  cfg?: RoleConfig
): string {
  const lines = roleFrom(role, cfg).ogLines[scoreTier(score)];
  return lines[hashSeed(seed) % lines.length];
}

/**
 * 인사기록카드 (공유된 캐릭터 페이지) 특이사항/직급/소속 — id 시드 결정적.
 * 롤별 콘텐츠는 role_content 설정(cfg 미지정 시 코드 기본값).
 */
export function dollTrait(seed: string, role: RoleId = "boss", cfg?: RoleConfig): string {
  const a = roleFrom(role, cfg).traits;
  return a[hashSeed(seed) % a.length];
}

export function dollRank(seed: string, role: RoleId = "boss", cfg?: RoleConfig): string {
  const a = roleFrom(role, cfg).ranks;
  return a[hashSeed(seed + "rank") % a.length];
}

export function dollDepartment(seed: string, role: RoleId = "boss", cfg?: RoleConfig): string {
  const a = roleFrom(role, cfg).departments;
  return a[hashSeed(seed + "dept") % a.length];
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

/** ISO 시각 → "방금/N분 전/N시간 전/N일 전" 상대 표기 (목록·랭킹 공용). */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

/** 보고서 문서번호 — 공유 링크마다 고정 (scoreId 앞 8자) */
export function reportNo(scoreId: string, createdAt: string | Date): string {
  const d = new Date(createdAt);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
  return `제${ymd}-${scoreId.slice(0, 4).toUpperCase()}호`;
}
