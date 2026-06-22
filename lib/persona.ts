import { weaponLabel } from "@/lib/report";
import { deriveStats, type GameplayStats } from "@/lib/stats";

/**
 * 플레이 스타일 페르소나 — "부장님 패기 인사평가" 패러디.
 * 룰베이스 결정적: 같은 플레이 = 같은 페르소나(즉시 계산, 종료화면 대기 0).
 * 각 매칭은 자기를 트리거한 stat(evidence)을 동봉 → "이 분석은 이 데이터에서" 신뢰감.
 * GameOverModal(클라)·/api/score(서버 저장)·/share(렌더) 공용.
 */

type PersonaDef = {
  id: string;
  /** 유형 라벨 (직책/분노유형 패러디) */
  label: string;
  emoji: string;
  /** 한 줄 해석 */
  blurb: string;
};

const DEFS = {
  ult_dependent: {
    id: "ult_dependent",
    label: "궁극기 의존형",
    emoji: "💥",
    blurb: "필살기 없으면 손이 안 나가는, 한 방의 승부사.",
  },
  graffiti: {
    id: "graffiti",
    label: "낙서 테러범",
    emoji: "🖊️",
    blurb: "때리기보다 펜으로 상대의 체면을 박살낸 예술가.",
  },
  sniper: {
    id: "sniper",
    label: "냉정한 저격수",
    emoji: "🔫",
    blurb: "거리 두고 비비탄으로 갈긴 원거리 처리반.",
  },
  thrower: {
    id: "thrower",
    label: "사무용품 투척왕",
    emoji: "📚",
    blurb: "잡히는 건 다 던진 투척 챔피언.",
  },
  grabber: {
    id: "grabber",
    label: "들었다 놨다형",
    emoji: "🤏",
    blurb: "상대를 통째로 집어던진 물리력의 화신.",
  },
  combo: {
    id: "combo",
    label: "콤보 마스터",
    emoji: "🔥",
    blurb: "끊김 없는 연타로 리듬을 탄 콤보의 지배자.",
  },
  carpet: {
    id: "carpet",
    label: "융단폭격형",
    emoji: "🌪️",
    blurb: "무기고를 통째로 비운, 닥치는 대로 융단폭격.",
  },
  barehand: {
    id: "barehand",
    label: "정통 맨손격투가",
    emoji: "👊",
    blurb: "도구는 사치, 주먹이 진리인 정통파.",
  },
  blitz: {
    id: "blitz",
    label: "속전속결형",
    emoji: "⚡",
    blurb: "짧고 굵게 몰아친 속전속결 해소러.",
  },
  precision: {
    id: "precision",
    label: "묵직한 정밀타격형",
    emoji: "🥷",
    blurb: "한 방 한 방 묵직하게 꽂은 정밀 타격형.",
  },
} satisfies Record<string, PersonaDef>;

/** 전체 페르소나 카탈로그 (수집 카운트 등 후속 기능용) */
export const PERSONA_DEFS: PersonaDef[] = Object.values(DEFS);

export type Persona = PersonaDef & { evidence: string };

const pct = (x: number) => Math.round(x * 100);

/**
 * stats → 페르소나. 위에서부터 첫 매칭(결정적 우선순위). fallback = 정밀타격형.
 */
export function matchPersona(stats: GameplayStats): Persona {
  const d = deriveStats(stats);
  const share = (c: string) => d.categoryShare[c] ?? 0;

  if (stats.ultimateCount >= 3)
    return { ...DEFS.ult_dependent, evidence: `궁극기 ${stats.ultimateCount}회 발동` };
  if (share("draw") > 0.3)
    return { ...DEFS.graffiti, evidence: `낙서 비중 ${pct(share("draw"))}%` };
  if (share("shoot") > 0.5)
    return { ...DEFS.sniper, evidence: `사격 비중 ${pct(share("shoot"))}%` };
  if (share("throw") > 0.6)
    return { ...DEFS.thrower, evidence: `투척 비중 ${pct(share("throw"))}%` };
  if (share("grab") > 0.4)
    return { ...DEFS.grabber, evidence: `잡아던지기 ${pct(share("grab"))}%` };
  if (stats.maxCombo >= 30)
    return { ...DEFS.combo, evidence: `최대 콤보 x${stats.maxCombo}` };
  if (d.distinctWeapons >= 7)
    return { ...DEFS.carpet, evidence: `${d.distinctWeapons}종 무기 동원` };
  if (share("tap") > 0.7)
    return { ...DEFS.barehand, evidence: `맨손 비중 ${pct(share("tap"))}%` };
  if (stats.durationMs < 30000 && d.apm >= 120)
    return {
      ...DEFS.blitz,
      evidence: `${Math.round(stats.durationMs / 1000)}초 · 분당 ${d.apm}타`,
    };

  return {
    ...DEFS.precision,
    evidence: d.topWeaponByScore
      ? `주력 ${weaponLabel(d.topWeaponByScore)}`
      : `총 ${stats.hitCount.toLocaleString()}타`,
  };
}
