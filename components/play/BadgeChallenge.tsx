"use client";

import type { ChallengeSlot } from "@/app/play/useBadgeChallenge";

/**
 * 인게임 "도전 과제" HUD — 획득 임박 뱃지 3개(진행바) 라이브. 획득 순간 ✅→리필(useBadgeChallenge).
 * MissionHud 대체. 배치: SpeechBubble(top-18%) 아래(top-28%)로 — 소형 폰(iPhone SE) 말풍선 비가림.
 */
export function BadgeChallenge({ slots }: { slots: ChallengeSlot[] }) {
  if (!slots.length) return null;
  return (
    <div className="pointer-events-none absolute left-3 top-[28%] z-10 w-[8.5rem] sm:left-4">
      <div className="rounded-xl bg-black/45 px-2.5 py-2 backdrop-blur-sm">
        <p className="flex items-center gap-1 text-[10px] font-bold text-amber-300">
          🏅 도전 과제
        </p>
        <ul className="mt-1.5 space-y-1.5">
          {slots.map((s) => {
            const pct = Math.floor((s.cur / s.goal) * 100);
            return (
              <li
                key={s.id}
                className={`rounded px-1 py-0.5 ${
                  s.justEarned ? "bg-amber-400/20" : ""
                }`}
              >
                <div className="flex items-center gap-1 text-[10px]">
                  <span>{s.justEarned ? "✅" : s.emoji}</span>
                  <span
                    className={`truncate ${
                      s.justEarned
                        ? "font-bold text-amber-200"
                        : "text-white/85"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                {s.justEarned ? (
                  <p className="mt-0.5 text-[8px] font-bold text-amber-300">
                    획득!
                  </p>
                ) : (
                  <div className="mt-0.5">
                    <div className="h-1 w-full overflow-hidden rounded-full bg-white/15">
                      <div
                        className="h-full rounded-full bg-amber-400"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[8px] tabular-nums text-white/45">
                      {Math.floor(s.cur).toLocaleString()}/
                      {s.goal.toLocaleString()}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
