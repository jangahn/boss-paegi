import { resolveWeapon } from "@/lib/weapons";
import type { RoleId } from "@/lib/roles";
import { roleFrom, roleVoice, type RoleConfig } from "@/lib/config/domains/roles";
import { DEFAULT_GENDER, type Gender } from "@/lib/gender";
import {
  scoreTier,
  SCORE_THRESHOLDS_DEFAULT,
  type ReportGrade,
  type ScoreTierConfig,
} from "@/lib/score-tiers";

export {
  scoreTier,
  tierBandLabel,
  TIER_COUNT,
  SCORE_THRESHOLDS_DEFAULT,
} from "@/lib/score-tiers";
export type { ReportGrade, ScoreTierConfig, ScoreThresholds } from "@/lib/score-tiers";

/**
 * 게임 결과 → "스트레스 해소 결과 보고서" 데이터.
 * GameOverModal (클라) 과 /share/[scoreId] (서버) 가 공용.
 *
 * ── 단일 5단계 소스 ──────────────────────────────────────────────
 * 점수 구간은 lib/score-tiers.ts `scoreTier(score, thresholds)` 한 곳에서만 결정한다.
 * 경계(thresholds)는 score_config(어드민)가 소유 — 판정 등급, 피격자 의견, play 시비 멘트
 * (lib/taunts.ts), 어드민 「점수 구간 분포」가 모두 같은 5단계·같은 경계를 공유한다.
 */

/** 문자열 → 안정적 양수 해시 (seed 기반 결정적 선택용) */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 판정 등급 — 패는 사람의 경지 5단계 (직장 탈출 서사). index 0(최하 구간) → 4(최상위).
 * 코드 기본값 = 발행 v10 에서 확정한 마케터 라벨과 동일(폴백이 제품 진실과 어긋나지 않게) — v1.24.
 */
export const PLAYER_GRADES: ReportGrade[] = [
  { label: "눈치보는 신입", comment: "화면보다 눈치를 더 봅니다" }, // 0
  { label: "마음만 퇴사자", comment: "출근은 했지만 마음은 이미 퇴근했습니다" }, // 1
  { label: "키보드 워리어", comment: "엔터키에 오늘의 감정이 실렸습니다" }, // 2
  { label: "빌런 심판관", comment: "빌런들을 향한 참교육이 시작됐습니다" }, // 3
  { label: "전설의 퇴사자", comment: "사직서와 함께 전설로 남았습니다" }, // 4
];

/** 코드 기본 단계 config — score_config 미주입 소비자(테스트·폴백)용. */
export const SCORE_TIER_CONFIG_DEFAULT: ScoreTierConfig = {
  thresholds: SCORE_THRESHOLDS_DEFAULT,
  grades: PLAYER_GRADES,
};

/** 등급 — cfg 미지정 시 코드 기본값(경계·라벨 모두). */
export function gradeFor(score: number, cfg: ScoreTierConfig = SCORE_TIER_CONFIG_DEFAULT): ReportGrade {
  return cfg.grades[scoreTier(score, cfg.thresholds)];
}

/**
 * 피격자 의견 (보고서) — 맞는 캐릭터(롤×성별) 입장. 롤별 콘텐츠는 role_content(cfg 미지정 시 코드 기본값).
 * 단계는 scoreCfg.thresholds 로 결정, 줄 선택은 seed 결정적(SSR/CSR 일치). gender 미지정=male(기본 부장님·레거시).
 */
export function bossReaction(opts: {
  score: number;
  seed: string;
  role?: RoleId;
  gender?: Gender;
  roleCfg?: RoleConfig;
  scoreCfg?: ScoreTierConfig;
}): string {
  const { score, seed, role = "boss", gender = DEFAULT_GENDER, roleCfg, scoreCfg = SCORE_TIER_CONFIG_DEFAULT } = opts;
  const lines = roleVoice(roleFrom(role, roleCfg), gender).reactions[scoreTier(score, scoreCfg.thresholds)];
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
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

/** ISO 시각 → "방금/N분 전/N시간 전/N일 전" 상대 표기 (목록·랭킹 공용). */
export function timeAgo(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "—";
  const diff = Date.now() - at;
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
  if (!Number.isFinite(d.getTime())) return "문서번호 확인 불가";
  // 서버(Vercel UTC)·한국 사용자 브라우저가 자정 경계에서도 같은 번호를 만들도록
  // 서비스 기준 시각인 KST(+09:00, DST 없음)를 명시적으로 사용한다.
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const ymd = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}${String(
    kst.getUTCDate()
  ).padStart(2, "0")}`;
  return `제${ymd}-${scoreId.slice(0, 4).toUpperCase()}호`;
}
