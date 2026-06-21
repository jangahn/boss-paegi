"use client";

import * as Sentry from "@sentry/nextjs";

/**
 * userKey + 닉네임 (+ 멤버면 email) 을 Sentry user 로 설정 — 이후 모든 event/replay/log·
 * 그리고 **유저 피드백(의견 위젯)** 에 자동 부착 → 누가 보낸 피드백인지 식별.
 * email 은 멤버만 전달(익명=undefined). 게임 닉네임은 실명 아님=비민감, IP 는 미수집(sendDefaultPii:false).
 */
export function setSentryIdentity(
  userId?: string,
  nickname?: string | null,
  email?: string | null
): void {
  if (!userId) return;
  Sentry.setUser({
    id: userId,
    username: nickname ?? undefined,
    email: email ?? undefined,
  });
}

/** 로그아웃/익명 전환 시 Sentry user 초기화 — 이전 멤버 email/닉네임이 다음 세션에 남지 않게. */
export function clearSentryIdentity(): void {
  Sentry.setUser(null);
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
