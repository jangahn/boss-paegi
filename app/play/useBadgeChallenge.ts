"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "@/store/gameStore";
import { buildGameplayStats } from "@/lib/stats";
import { BADGE_DEFS, badgeById, badgeValue } from "@/lib/badges";
import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";

/**
 * 인게임 뱃지 도전 — 단일 소스(lib/badges)로 구동되는 라이브 체크리스트 + 획득 토스트.
 * MissionHud/useGameMilestones 대체. "획득 임박 3개" 노출, 실제 획득 순간 토스트+✅, 1.2s 후 리필.
 * store.subscribe 기반(별도 interval 없음). 성능: setState 는 슬롯 id·진행률(floor%)·✅ 변동 시에만.
 */

export type ChallengeSlot = {
  id: string;
  emoji: string;
  label: string;
  cur: number;
  goal: number;
  justEarned: boolean;
};
export type EarnToast = { id: number; text: string };

const SLOT_COUNT = 3;
const EARNED_HOLD_MS = 1200; // 획득 ✅ 표시 유지 후 리필

export function useBadgeChallenge({
  recording,
  getBgVisits,
}: {
  recording: boolean;
  getBgVisits: () => string[];
}): { slots: ChallengeSlot[]; toasts: EarnToast[] } {
  const [slots, setSlots] = useState<ChallengeSlot[]>([]);
  const [toasts, setToasts] = useState<EarnToast[]>([]);

  useEffect(() => {
    if (!recording) return;
    let cancelled = false;
    let loaded = false; // owned 로드 전엔 earn 감지 안 함(오탐 방지)

    const owned = new Set<string>(); // 보유(시작 로드 + 세션 획득)
    const earnedAt = new Map<string, number>(); // 방금 획득 ✅ 핀 만료용
    const timers: ReturnType<typeof setTimeout>[] = [];
    let toastSeq = 0;
    let sig = "";

    const liveStats = () => {
      const s = useGameStore.getState();
      return {
        stats: buildGameplayStats({
          hitCount: s.hitCount,
          maxCombo: s.maxCombo,
          durationMs: s.startedAt ? performance.now() - s.startedAt : 0,
          weaponCounts: s.weaponCounts,
          weaponScores: s.weaponScores,
          ultScore: s.ultScore,
          ultimateCount: s.ultimateCount,
          firstHitMs: s.firstHitMs,
          bgVisits: getBgVisits(),
        }),
        score: s.score,
      };
    };

    const pushToast = (text: string) => {
      const id = ++toastSeq;
      setToasts((t) => [...t.slice(-2), { id, text }]);
      timers.push(
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200)
      );
    };

    const recompute = () => {
      if (cancelled || !loaded) return;
      const { stats, score } = liveStats();
      const now = performance.now();

      // 1) 신규 획득 감지 → 보유 추가 + "「라벨」 획득!" 토스트 + ✅ 핀(1.2s)
      for (const d of BADGE_DEFS) {
        if (!owned.has(d.id) && badgeValue(d, stats, score) >= d.threshold) {
          owned.add(d.id);
          pushToast(`「${d.label}」 획득!`);
          earnedAt.set(d.id, now);
          timers.push(setTimeout(recompute, EARNED_HOLD_MS + 50)); // 히트 없어도 핀 제거
        }
      }

      // 2) 핀: 방금 획득(1.2s 이내) ✅ — 먼저 획득한 순서로 위에
      const pinned = [...earnedAt.entries()]
        .filter(([, t]) => now - t < EARNED_HOLD_MS)
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id);
      // 3) 나머지 = 패밀리별 "다음 미획득 티어"(최고 진행도) 1개씩 → 그 중 top by ratio.
      //    패밀리당 1칩으로 다양성 확보(맵 티어 3개로 도배되는 것 방지). 핀된 패밀리는 제외.
      const pinnedFamilies = new Set(
        pinned.map((id) => badgeById(id)?.familyKey)
      );
      const bestPerFamily = new Map<
        string,
        { id: string; r: number; t: number }
      >();
      for (const d of BADGE_DEFS) {
        if (owned.has(d.id) || pinnedFamilies.has(d.familyKey)) continue;
        const r = badgeValue(d, stats, score) / d.threshold;
        const cur = bestPerFamily.get(d.familyKey);
        if (!cur || r > cur.r) bestPerFamily.set(d.familyKey, { id: d.id, r, t: d.threshold });
      }
      const top = [...bestPerFamily.values()]
        .sort((a, b) => b.r - a.r || a.t - b.t)
        .slice(0, Math.max(0, SLOT_COUNT - pinned.length))
        .map((x) => x.id);
      const ids = [...pinned, ...top];

      // 4) 표시 데이터 — 시그니처(슬롯 id·floor%·✅) 변동 시에만 setState
      const data: ChallengeSlot[] = ids.map((id) => {
        const d = badgeById(id)!;
        const cur = badgeValue(d, stats, score);
        return {
          id,
          emoji: d.emoji,
          label: d.label,
          cur: Math.min(cur, d.threshold),
          goal: d.threshold,
          justEarned: owned.has(id),
        };
      });
      const nextSig = data
        .map(
          (s) =>
            `${s.id}:${Math.floor((s.cur / s.goal) * 100)}:${s.justEarned ? 1 : 0}`
        )
        .join("|");
      if (nextSig !== sig) {
        sig = nextSig;
        setSlots(data);
      }
    };

    (async () => {
      try {
        await ensureAuth();
        const sb = createClient();
        const { data } = await sb.from("user_badges").select("badge_id");
        if (cancelled) return;
        for (const r of data ?? []) owned.add(r.badge_id as string);
      } catch {
        /* 로드 실패 — 빈 owned 로 진행 */
      }
      loaded = true;
      recompute();
    })();

    const unsub = useGameStore.subscribe(() => recompute());
    return () => {
      cancelled = true;
      unsub();
      timers.forEach(clearTimeout);
    };
  }, [recording, getBgVisits]);

  return { slots, toasts };
}
