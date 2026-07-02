import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { signedHighlightUrl } from "@/lib/storage";
import type { GameplayStats } from "@/lib/stats";
import { isVisibleReviewStatus, type ReviewStatus } from "@/lib/score-visibility";

/**
 * 한 게임 결과 상세 — `/share/[scoreId]` 와 `/history/[userId]/[scoreId]` 공용.
 *
 * scores + 1:1 score_highlights/score_stats + profiles/dolls join 을 flatten 해
 * 기존 report helper 들이 바로 쓰도록 한다. createAdminClient(서비스 롤) 사용 →
 * **이 모듈은 server-only** (클라 컴포넌트에서 import 금지).
 *
 * `owner_id` 를 항상 포함한다 — 기록 상세에서 URL(userId) 정합 검증(변조 방지)용.
 */
export type Score = {
  id: string;
  owner_id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  max_combo: number | null;
  created_at: string;
  /** 공개 가시성 — 어뷰징 판정(0050). registered|cleared 만 공개면 노출. */
  review_status: ReviewStatus;
  profiles: { display_name: string } | null;
  dolls: { id: string; image_url: string | null; role: string | null } | null;
  highlight_clip_path: string | null;
  highlight_status: string | null;
  highlight_delta: number | null;
  highlight_window_ms: number | null;
  highlight_deleted_at: string | null;
  highlight_expires_at: string | null;
  /** 플레이 해석 스탯 (score_stats 1:1) — 페르소나/총타격 렌더용 */
  gameplay_stats: GameplayStats | null;
  /** 이번 판 획득 뱃지 스냅샷 */
  badge_ids: string[] | null;
  /** 플레이 당시 전체 상위 N% */
  percentile: number | null;
};

const HL_COLS =
  "highlight_clip_path, highlight_status, highlight_delta, highlight_window_ms, highlight_deleted_at, highlight_expires_at";

/** 삭제/만료 안 됐는지 (clip·card 공통). */
export function highlightLive(s: Score): boolean {
  if (s.highlight_deleted_at) return false;
  if (s.highlight_expires_at && new Date(s.highlight_expires_at) <= new Date())
    return false;
  return true;
}

/** attach 됐고 삭제/만료 안 된 클립이면 **signed URL**(private 버킷), 아니면 null. (async) */
export async function clipSignedUrl(s: Score): Promise<string | null> {
  if (s.highlight_status !== "attached" || !s.highlight_clip_path) return null;
  if (!highlightLive(s)) return null;
  return signedHighlightUrl(s.highlight_clip_path);
}

/** 급상승 stat — clip(attached) 또는 card 둘 다, 삭제/만료 X. */
export function highlightDelta(s: Score): number | null {
  if (s.highlight_status !== "attached" && s.highlight_status !== "card") return null;
  if (!highlightLive(s)) return null;
  return s.highlight_delta;
}

/** clip·card 무관하게 '살아있는 하이라이트가 있나' — 기록상세의 /share 링크 노출 판정. */
export function hasLiveHighlight(s: Score): boolean {
  if (s.highlight_status !== "attached" && s.highlight_status !== "card") return false;
  return highlightLive(s);
}

/**
 * highlight(score_highlights)·stats(score_stats) 1:1 → score 객체로 flatten.
 * nested select 결과는 객체/배열이 섞여 올 수 있어 방어적으로 1행만 추출한다.
 */
function flattenScore(row: Record<string, unknown>): Score {
  const rawHl = row.score_highlights;
  const hl = Array.isArray(rawHl) ? rawHl[0] ?? null : rawHl ?? null;
  const rawStats = row.score_stats;
  const stats = Array.isArray(rawStats) ? rawStats[0] ?? null : rawStats ?? null;
  const st = stats as
    | { gameplay_stats?: GameplayStats; badge_ids?: string[]; percentile?: number }
    | null;
  const { score_highlights: _h, score_stats: _s, ...rest } = row;
  void _h;
  void _s;
  // takedown(0034): doll 이 soft-delete(deleted_at) 면 얼굴 이미지만 숨기고(점수·role 카피는 유지)
  //   기본 보스로 fallback. 하이라이트는 highlightLive 가 highlight_deleted_at 으로 별도 차단.
  const rawDolls = rest.dolls as
    | { id: string; image_url: string | null; role: string | null; deleted_at?: string | null }
    | null;
  const dolls =
    rawDolls && rawDolls.deleted_at
      ? { id: rawDolls.id, image_url: null, role: rawDolls.role }
      : rawDolls;
  return {
    ...rest,
    dolls,
    ...((hl as Record<string, unknown>) ?? {}),
    gameplay_stats: st?.gameplay_stats ?? null,
    badge_ids: st?.badge_ids ?? null,
    percentile: st?.percentile ?? null,
  } as unknown as Score;
}

/**
 * scoreId → 상세 Score (join + 구 스키마 fallback). null = 없음/비공개.
 *
 * 기본은 **공개면 안전**: review_status 가 registered|cleared 가 아니면(pending/voided)
 * null 을 반환한다(공유·OG·히스토리 등 공개 경로에서 조작/검토중 점수 노출 차단, 0050).
 * 어드민/소유자 컨텍스트는 `opts.includeHidden` 로 숨김 행까지 조회한다.
 */
export async function fetchScoreDetail(
  scoreId: string,
  opts?: { includeHidden?: boolean }
): Promise<Score | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("scores")
    .select(
      `id, owner_id, score, weapon, duration_ms, max_combo, created_at, review_status, profiles(display_name), dolls(id, image_url, role, deleted_at), score_highlights(${HL_COLS}), score_stats(gameplay_stats, badge_ids, percentile)`
    )
    .eq("id", scoreId)
    .single();
  if (data) {
    const s = flattenScore(data as Record<string, unknown>);
    if (!opts?.includeHidden && !isVisibleReviewStatus(s.review_status)) return null;
    return s;
  }
  // 구 스키마(migration 미적용) fallback — highlight/stats/review_status 없이(기존 행=registered).
  const { data: legacy } = await admin
    .from("scores")
    .select(
      "id, owner_id, score, weapon, duration_ms, created_at, profiles(display_name), dolls(id, image_url, role)"
    )
    .eq("id", scoreId)
    .single();
  return legacy
    ? ({
        ...legacy,
        max_combo: null,
        review_status: "registered",
        gameplay_stats: null,
        badge_ids: null,
        percentile: null,
      } as unknown as Score)
    : null;
}
