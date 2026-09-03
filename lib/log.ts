/**
 * 구조화 로깅 — 트러블슈팅을 로그만 보고 할 수 있게.
 *
 * 한 줄 = 하나의 JSON 이벤트. `event` 는 `domain.action` 규칙 (gen.fal_success 등).
 * 같은 흐름(예: 한 번의 생성)은 `genId`/`scoreId` 같은 correlation id 로 묶어
 * 시간순 로그를 따라가면 전 과정을 재구성할 수 있다.
 *
 * ── Sentry 브릿지 ─────────────────────────────────────────────────
 * console (Vercel 로그 / 브라우저 콘솔) 출력 + Sentry 전송(sentry-bridge).
 *   - level "error" → captureMessage(level:error), event 명으로 그룹핑
 *   - level "warn"  → captureMessage(level:warning)
 *   - level "info"  → addBreadcrumb (에러 발생 시 맥락)
 *   ctx 는 contexts.log + tags.event 로, userId 는 setUser 로 매핑.
 * DSN 미설정이면 브릿지가 no-op (앱 정상). 자세한 매핑은 lib/sentry-bridge.ts.
 */

import { emitToSentry } from "./sentry-bridge";
import { safeStringify } from "./err-info.ts";

export { errInfo, urlHost } from "./err-info.ts";

export type LogLevel = "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

function emit(level: LogLevel, event: string, ctx: LogContext) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  };
  // 한 줄 JSON — 로그 드레인/Sentry 파싱 + grep 용이
  const line = safeStringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  // Sentry 전송 (DSN 없으면 no-op). 로거가 Sentry 때문에 안 깨지게 격리.
  try {
    emitToSentry(level, event, ctx);
  } catch {
    /* Sentry 실패는 무시 — 로깅이 우선 */
  }
}

export const log = {
  info: (event: string, ctx: LogContext = {}) => emit("info", event, ctx),
  warn: (event: string, ctx: LogContext = {}) => emit("warn", event, ctx),
  error: (event: string, ctx: LogContext = {}) => emit("error", event, ctx),
};
