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

export type LogLevel = "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

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

/**
 * 알 수 없는 에러를 로그용 컨텍스트로 안전 변환.
 * Error 의 name/message/stack(앞 4줄) + fal SDK 에러의 status/body 까지 추출.
 */
export function errInfo(e: unknown): LogContext {
  if (e instanceof Error) {
    const ctx: LogContext = { errName: e.name, errMessage: e.message };
    if (e.stack) ctx.errStack = e.stack.split("\n").slice(0, 4).join(" | ");
    const any = e as unknown as Record<string, unknown>;
    if (any.status !== undefined) ctx.errStatus = any.status;
    if (any.body !== undefined) {
      ctx.errBody = scrubSecrets(safeStringify(any.body)).slice(0, 500);
    }
    ctx.errMessage = scrubSecrets(e.message);
    return ctx;
  }
  return { errMessage: scrubSecrets(String(e)) };
}

/**
 * 로그 문자열에서 토큰/시크릿 제거.
 * fal 에러 바디 등에 서명 URL(?token=...)이 echo 될 수 있어, URL 의 쿼리스트링과
 * 알려진 시크릿 파라미터를 마스킹한다 (urlHost() 와 같은 의도를 임의 JSON 에 적용).
 */
function scrubSecrets(s: string): string {
  return (
    s
      // URL 의 쿼리스트링 통째로 제거 (token/Signature/X-Amz-* 등)
      .replace(/(https?:\/\/[^\s"'\\]+?)\?[^\s"'\\]*/g, "$1?[redacted]")
      // 혹시 URL 밖에 노출된 시크릿 키=값 패턴
      .replace(/(token|signature|apikey|api_key|secret)=[^\s&"'\\]+/gi, "$1=[redacted]")
  );
}

/** URL 에서 호스트만 (전체 URL·쿼리에 토큰 섞일 수 있어 host 만 로깅) */
export function urlHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "invalid_url";
  }
}
