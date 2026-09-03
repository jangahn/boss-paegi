/**
 * 에러 → 로그 컨텍스트 변환·시크릿 스크럽 — Sentry 브릿지 무의존 순수 모듈.
 * (lib/log.ts 가 재수출한다. 노드 단위 테스트가 직접 import 하는 관례 — transport-failure.ts 와 동일.)
 */

export type LogContext = Record<string, unknown>;

export function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 알 수 없는 에러를 로그용 컨텍스트로 안전 변환.
 * - Error: name/message/stack(앞 4줄) + fal SDK 에러의 status/body + code 추출.
 * - 비-Error 객체: Supabase/PostgREST 는 throwOnError 미사용 시 에러를 Error 가 아닌
 *   평범한 객체({message, code, details, hint})로 반환한다. 이때 String(e) 하면
 *   "[object Object]" 가 되어 원인이 통째로 유실되므로, 알려진 에러 필드를 직접 추출한다.
 */
export function errInfo(e: unknown): LogContext {
  if (e instanceof Error) {
    const ctx: LogContext = { errName: e.name, errMessage: e.message };
    if (e.stack) ctx.errStack = e.stack.split("\n").slice(0, 4).join(" | ");
    const any = e as unknown as Record<string, unknown>;
    if (any.status !== undefined) ctx.errStatus = any.status;
    if (any.code !== undefined) ctx.errCode = any.code;
    if (any.body !== undefined) {
      ctx.errBody = scrubSecrets(safeStringify(any.body)).slice(0, 500);
    }
    // 래퍼 에러(client-mutation unconfirmedOutcomeError 등)가 실은 사유·원인 —
    // 고정 문자열 메시지 뒤에 실제 원인(Failed to fetch·TimeoutError·HTTP 상태)이 남는다.
    if (typeof any.reason === "string") ctx.errReason = any.reason;
    if (e.cause !== undefined && e.cause !== null) {
      Object.assign(ctx, causeInfo(e.cause));
    }
    ctx.errMessage = scrubSecrets(e.message);
    return ctx;
  }
  // 비-Error 객체(Supabase/PostgREST/OAuth 에러 등): 필드를 직접 꺼내 message 유실 방지.
  if (e !== null && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const ctx: LogContext = {};
    const msg = o.message ?? o.error_description ?? o.error ?? o.msg;
    ctx.errMessage = scrubSecrets(
      typeof msg === "string" ? msg : safeStringify(e).slice(0, 500),
    );
    if (typeof o.name === "string") ctx.errName = o.name;
    if (o.code !== undefined) ctx.errCode = o.code;
    if (o.status !== undefined) ctx.errStatus = o.status;
    if (typeof o.details === "string") ctx.errDetails = scrubSecrets(o.details).slice(0, 500);
    if (typeof o.hint === "string") ctx.errHint = o.hint;
    return ctx;
  }
  return { errMessage: scrubSecrets(String(e)) };
}

/** errInfo 의 cause 요약 — 한 단계만(중첩 cause 는 메시지에 이미 포함되기 마련). */
function causeInfo(cause: unknown): LogContext {
  if (cause instanceof Error) {
    const any = cause as unknown as Record<string, unknown>;
    const ctx: LogContext = {
      errCauseName: cause.name,
      errCauseMessage: scrubSecrets(cause.message).slice(0, 300),
    };
    if (any.status !== undefined) ctx.errCauseStatus = any.status;
    if (any.code !== undefined) ctx.errCauseCode = any.code;
    return ctx;
  }
  if (cause !== null && typeof cause === "object") {
    const o = cause as Record<string, unknown>;
    const msg = o.message ?? o.error_description ?? o.error ?? o.msg;
    const ctx: LogContext = {
      errCauseMessage: scrubSecrets(
        typeof msg === "string" ? msg : safeStringify(cause).slice(0, 300),
      ).slice(0, 300),
    };
    if (typeof o.name === "string") ctx.errCauseName = o.name;
    if (o.status !== undefined) ctx.errCauseStatus = o.status;
    if (o.code !== undefined) ctx.errCauseCode = o.code;
    return ctx;
  }
  return { errCauseMessage: scrubSecrets(String(cause)).slice(0, 300) };
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
