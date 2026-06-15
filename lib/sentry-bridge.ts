import * as Sentry from "@sentry/nextjs";
import type { LogLevel, LogContext } from "./log";

// 초고빈도 info 는 Sentry Logs 전송에서 제외(볼륨/비용) — /api/generations 폴링마다 찍히는 요약.
const LOG_SKIP = new Set<string>(["gen.recover_list"]);

/**
 * 구조화 로그(log.ts emit)를 Sentry 로 브릿지 — emit() 한 곳에서만 호출.
 *  - error/warn → captureMessage: event 명으로 fingerprint 그룹핑 → 이벤트당 1 이슈,
 *    이벤트별 알림 룰 설정 가능. ctx(errStack/errMessage 등)는 contexts.log + tags.event 로.
 *  - info       → addBreadcrumb: 에러 발생 시 직전 맥락만 동봉(단독 전송 X = 무료티어 절약).
 *
 * DSN 미설정/미초기화면 getClient() 가 undefined → 전부 no-op (앱 정상).
 * (우리 log.error 는 대부분 catch 후 graceful 반환 = handled 라 onRequestError 가
 *  못 잡음 → 이 브릿지가 surface. 진짜 크래시는 onRequestError/global-error 가 별도 포착.)
 */
export function emitToSentry(
  level: LogLevel,
  event: string,
  ctx: LogContext
): void {
  if (!Sentry.getClient()) return;

  const userId = typeof ctx.userId === "string" ? ctx.userId : undefined;
  if (userId) Sentry.setUser({ id: userId });

  // 구조화 로그 → Explore→Logs (모든 레벨; 초고빈도 info 제외). enableLogs 꺼져있으면 no-op.
  // ctx 는 이미 source 에서 scrubSecrets/urlHost 적용됨(얼굴/토큰/서명URL 미포함 — captureMessage 와 동일 posture).
  if (!(level === "info" && LOG_SKIP.has(event))) {
    Sentry.logger?.[level]?.(event, ctx);
  }

  if (level === "info") {
    Sentry.addBreadcrumb({ category: event, level: "info", data: ctx });
    return;
  }

  Sentry.captureMessage(event, {
    level: level === "error" ? "error" : "warning",
    fingerprint: [event],
    tags: { event },
    contexts: { log: { ...ctx } },
  });
}
