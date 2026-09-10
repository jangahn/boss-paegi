import { scoreTier, TIER_COUNT, type ScoreTierConfig } from "@/lib/score-tiers";
import { SCORE_TIER_CONFIG_DEFAULT } from "@/lib/report";
import type { RoleId } from "@/lib/roles";
import { roleFrom, roleVoice, type RoleConfig } from "@/lib/config/domains/roles";
import { DEFAULT_GENDER, type Gender } from "@/lib/gender";

/**
 * 캐릭터 시비 멘트. 게임 진행 중 주기적으로 말풍선으로 노출 — 패고 싶게 만드는 게 목적.
 * 롤별 멘트는 role_content(점수 5단계 = scoreTier 공유, 경계는 score_config). 비방·욕설 의도적 제외(정책).
 *
 * 선택은 셔플백(v1.32) — 순수 모듈(DOM 없음). 상태 영속(localStorage)·타이머는 app/play/useTaunts 가 맡는다.
 *  · tier 당 백 하나: 풀을 섞어 순서대로 소진, 다 쓰면 재셔플(새 사이클 첫 줄 ≠ 직전 줄). 한 사이클 안에선 반복 없음.
 *  · 인접 tier 혼합: T0↔T1·T2←T1 은 3회 묶음마다 1회(2:1) 인접 tier 백에서 뽑는다 — 무시·짜증 톤을 공유하는 구간만.
 *    애원(T3)·항복(T4)은 순수. 인접 몫도 그 tier 의 백 커서를 소모하므로 tier 가 바뀐 직후 같은 줄이 되돌아오지 않는다.
 *  · 백은 게임 사이에 이어진다(커서 영속) — 매 판 같은 첫 멘트로 시작하지 않게. 콘텐츠가 바뀌면 풀과 대조한다.
 */

// ── 타이밍(useTaunts 가 소비) ─────────────────────────────────────────────
export const TAUNT_INITIAL_DELAY_MS = 1500;
export const TAUNT_VISIBLE_MS = 3000;
/** 노출 간격 — 고정 5.5s 대신 4.5~7s 균등 지터(기계적인 루프 느낌 완화). 최소값이 노출 시간보다 커서 겹치지 않는다. */
export const TAUNT_INTERVAL_MIN_MS = 4500;
export const TAUNT_INTERVAL_MAX_MS = 7000;

export type Rng = () => number;

/** 다음 멘트까지의 지연 — [MIN, MAX] 정수 ms 균등. */
export function nextTauntDelayMs(rng: Rng = Math.random): number {
  const span = TAUNT_INTERVAL_MAX_MS - TAUNT_INTERVAL_MIN_MS;
  return TAUNT_INTERVAL_MIN_MS + Math.floor(rng() * (span + 1));
}

// ── 인접 tier 혼합 규칙 ──────────────────────────────────────────────────
/** tier → 섞을 인접 tier(없으면 순수). 길이 = TIER_COUNT(코드 고정 5단계). */
export const TAUNT_ADJACENT_TIER: readonly (number | null)[] = [1, 0, 1, null, null];
/** 묶음 크기 — 묶음마다 인접 몫 1회(= 본 tier 2 : 인접 1). */
export const TAUNT_MIX_BLOCK = 3;

// ── 백 상태 ───────────────────────────────────────────────────────────────
/** 현재 사이클에서 아직 안 나온 줄(앞에서부터 출력). 비면 사이클 끝. */
export type TauntBag = { remaining: string[] };
/** key = tauntBagKey(role, gender, tier). 영속 대상(localStorage) — 공개 콘텐츠 문구만, 식별자 없음. */
export type TauntBags = Record<string, TauntBag>;

export type TauntSelectorState = {
  bags: TauntBags;
  /** 진행 중 묶음 — tier 가 바뀌면 새로 시작. 세션 메모리(영속 안 함). */
  block: { tier: number; adjacentSlot: number; drawn: number } | null;
  /** 직전에 보여준 줄 — 재셔플 이음새 중복 방지용. */
  last: string | null;
};

export function tauntBagKey(role: RoleId, gender: Gender, tier: number): string {
  return `${role}:${gender}:${tier}`;
}

export function createTauntSelectorState(bags: TauntBags = {}): TauntSelectorState {
  return { bags, block: null, last: null };
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 저장된 백을 현재 풀과 대조 — 사라진 줄(콘솔에서 고쳐 발행)은 버린다(중복도 제거). 새로 추가된 줄은 다음 사이클부터.
 * 저장이 없으면 빈 백(=사이클 끝 → 첫 뽑기에서 셔플).
 */
function reconcileBag(bag: TauntBag | undefined, pool: readonly string[]): TauntBag {
  if (!bag) return { remaining: [] };
  const poolSet = new Set(pool);
  return { remaining: bag.remaining.filter((line, i, arr) => poolSet.has(line) && arr.indexOf(line) === i) };
}

/**
 * 백에서 한 줄 — remaining 이 비면 새 사이클(전체 풀 셔플). 뽑은 줄이 직전 줄과 같으면(사이클 이음새,
 * 또는 인접 tier 풀에 같은 문구) 다음 줄과 자리를 바꿔 연속 동일을 막는다(풀 ≥2). 풀이 비면 null.
 */
function drawFromBag(
  bags: TauntBags,
  key: string,
  pool: readonly string[],
  last: string | null,
  rng: Rng,
): string | null {
  if (pool.length === 0) return null;
  const bag = reconcileBag(bags[key], pool);
  if (bag.remaining.length === 0) bag.remaining = shuffle(pool, rng);
  let line = bag.remaining.shift()!;
  if (line === last && bag.remaining.length > 0) {
    const next = bag.remaining.shift()!;
    bag.remaining.unshift(line);
    line = next;
  }
  bags[key] = bag;
  return line;
}

/**
 * 다음 시비 멘트 — 점수대(5단계) + 롤×성별 풀에서 셔플백으로 뽑는다(state 는 제자리 갱신).
 * role 미지정 시 boss, gender 미지정 시 male, cfg 미지정 시 코드 기본값(경계·콘텐츠).
 */
export function nextTaunt(
  state: TauntSelectorState,
  opts: {
    score: number;
    role?: RoleId;
    gender?: Gender;
    roleCfg?: RoleConfig;
    scoreCfg?: ScoreTierConfig;
    rng?: Rng;
  },
): string {
  const {
    score,
    role = "boss",
    gender = DEFAULT_GENDER,
    roleCfg,
    scoreCfg = SCORE_TIER_CONFIG_DEFAULT,
    rng = Math.random,
  } = opts;
  const tier = Math.min(TIER_COUNT - 1, scoreTier(score, scoreCfg.thresholds));
  const taunts = roleVoice(roleFrom(role, roleCfg), gender).taunts;

  if (!state.block || state.block.tier !== tier || state.block.drawn >= TAUNT_MIX_BLOCK) {
    state.block = { tier, adjacentSlot: Math.floor(rng() * TAUNT_MIX_BLOCK), drawn: 0 };
  }
  const adjacent = TAUNT_ADJACENT_TIER[tier] ?? null;
  const useAdjacent = adjacent !== null && state.block.drawn === state.block.adjacentSlot;
  state.block.drawn += 1;

  let line: string | null = null;
  if (useAdjacent) {
    line = drawFromBag(state.bags, tauntBagKey(role, gender, adjacent), taunts[adjacent] ?? [], state.last, rng);
  }
  if (line === null) {
    line = drawFromBag(state.bags, tauntBagKey(role, gender, tier), taunts[tier] ?? [], state.last, rng);
  }
  const chosen = line ?? "";
  state.last = chosen;
  return chosen;
}

// ── 영속 포맷(localStorage) — 파싱/직렬화만 여기서, 실제 storage 접근은 useTaunts ──
export const TAUNT_BAGS_KEY = "bp_taunt_bags_v1";
const TAUNT_BAGS_VERSION = 1;
const MAX_BAG_KEYS = 128; // 정상 상한 = 롤 7 × 성별 2 × tier 5 = 70 — 그 너머는 비정상 팽창으로 보고 자른다

export function serializeTauntBags(bags: TauntBags): string {
  return JSON.stringify({ version: TAUNT_BAGS_VERSION, bags });
}

/** 불량·구버전·이형 값은 통째로 버린다(빈 백 = 첫 뽑기에서 새 셔플). */
export function parseTauntBags(raw: string | null | undefined): TauntBags {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const o = parsed as { version?: unknown; bags?: unknown };
    if (o.version !== TAUNT_BAGS_VERSION || !o.bags || typeof o.bags !== "object") return {};
    const out: TauntBags = {};
    for (const [key, value] of Object.entries(o.bags as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_BAG_KEYS) break;
      if (!value || typeof value !== "object") continue;
      const v = value as { remaining?: unknown };
      if (!Array.isArray(v.remaining) || !v.remaining.every((s) => typeof s === "string")) continue;
      out[key] = { remaining: v.remaining as string[] };
    }
    return out;
  } catch {
    return {};
  }
}
