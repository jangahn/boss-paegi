"use client";

import * as Sentry from "@sentry/nextjs";

/**
 * 익명 userKey + 닉네임을 Sentry user 로 설정 — 이후 모든 event/replay/log 에 자동 부착.
 * (게임 닉네임은 실명 아님 = 비민감. IP 는 sendDefaultPii:false 로 미수집.)
 */
export function setSentryIdentity(userId?: string, nickname?: string | null): void {
  if (!userId) return;
  Sentry.setUser({ id: userId, username: nickname ?? undefined });
}

/**
 * 게임 컨텍스트(비민감) 부착 — 태그(검색/필터/그룹 가능) + 구조화 컨텍스트.
 * Explore/Discover 에서 weapon·bg·doll_type 별로 에러/replay/trace 를 끊어 볼 수 있게.
 */
export function setSentryGameContext(ctx: {
  dollId?: string | null;
  weapon?: string;
  bg?: string;
  gamePhase?: string;
}): void {
  if (ctx.weapon) Sentry.setTag("weapon", ctx.weapon);
  if (ctx.bg) Sentry.setTag("bg", ctx.bg);
  if (ctx.dollId !== undefined)
    Sentry.setTag("doll_type", ctx.dollId ? "custom" : "default");
  if (ctx.gamePhase) Sentry.setTag("game_phase", ctx.gamePhase);
  Sentry.setContext("game_session", {
    dollId: ctx.dollId ?? "default",
    weapon: ctx.weapon,
    bg: ctx.bg,
    gamePhase: ctx.gamePhase,
  });
}
