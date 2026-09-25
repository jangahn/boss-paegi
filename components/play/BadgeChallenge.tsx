"use client";

import type { ChallengeSlot } from "@/app/play/useBadgeChallenge";

/**
 * 인게임 "도전 과제" HUD — 획득 임박 뱃지 3개(진행바) 라이브. 획득 순간 ✅(useBadgeChallenge).
 * 컴팩트(소형 폰서 캐릭터 가림 최소화): 좁은 폭 + 숫자 없이 progress bar 만. SpeechBubble 아래(top-28%).
 */
export function BadgeChallenge({
  slots,
  error,
}: {
  slots: ChallengeSlot[];
  error?: string | null;
}) {
  if (error) {
    return (
      <div
        role="status"
        className="pointer-events-none absolute left-2 top-[28%] z-10 max-w-36 rounded-lg bg-black/70 px-2 py-1.5 text-[9px] text-amber-200 backdrop-blur-sm sm:left-3"
      >
        🏅 {error}
      </div>
    );
  }
  if (!slots.length) return null;
  return (
    <div className="pointer-events-none absolute left-2 top-[28%] z-10 w-[5.5rem] sm:left-3 sm:w-24">
      <div className="rounded-lg bg-black/45 px-1.5 py-1 backdrop-blur-sm">
        <p className="text-[8px] font-bold text-amber-300">🏅 도전</p>
        <ul className="mt-1 space-y-1">
          {slots.map((s) => {
            const pct = Math.floor((s.cur / s.goal) * 100);
            return (
              <li key={s.id}>
                <div className="flex items-center gap-0.5 text-[8px] leading-tight">
                  <span>{s.justEarned ? "✅" : s.emoji}</span>
                  <span
                    className={`truncate ${
                      s.justEarned ? "font-bold text-amber-200" : "text-white/85"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                <div className="mt-0.5 h-0.5 w-full overflow-hidden rounded-full bg-white/15">
                  {/* 진행은 폭이 아니라 scaleX 로 부드럽게 채운다(v1.65 — 배치 불변, 합성 레이어만). */}
                  <div
                    className={`h-full w-full origin-left rounded-full transition-transform duration-300 ${
                      s.justEarned ? "bg-emerald-400" : "bg-amber-400"
                    }`}
                    style={{ transform: `scaleX(${s.justEarned ? 1 : pct / 100})` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
