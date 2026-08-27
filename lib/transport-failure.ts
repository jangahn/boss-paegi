/**
 * 전송(transport) 계층 실패 판별 — HTTP 응답 자체가 없는 실패(네트워크 단절·크롤러
 * 렌더러의 외부 요청 차단·페이지 이탈 중 abort·타임아웃). client-mutation.ts 의
 * "transport" phase 와 같은 개념. 서버가 응답으로 거절한 실패(status 존재)와 구분해,
 * 호출부가 로그 레벨(관찰용 warn vs 조사용 error)을 고르는 데 쓴다.
 * 실측 근거: 2026-08 Sentry 트리아지 — auth.anon_sign_in_fail 30/30 이 errStatus 0
 * (Googlebot InspectionTool·모바일 이탈), 서버 거절 0건.
 *
 * (log.ts 가 아닌 독립 모듈인 이유: sentry-bridge 무의존 순수 판별이라 node 단위
 * 테스트가 직접 import 한다 — play-doll-init.ts 와 같은 관례.)
 */
export function isTransportFailure(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const o = e as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    operationError?: unknown;
  };
  // SupabaseOperationError 등 래퍼는 원인(operationError)으로 판별.
  if (o.operationError !== undefined && isTransportFailure(o.operationError)) {
    return true;
  }
  // supabase auth-js 는 fetch 무응답을 AuthRetryableFetchError(status 0) 로 감싼다.
  if (o.status === 0) return true;
  // status 가 있으면 서버가 응답한 것(retryable 502/503 포함) — transport 아님.
  if (o.status !== undefined && o.status !== null) return false;
  const name = typeof o.name === "string" ? o.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = typeof o.message === "string" ? o.message : "";
  // Chromium "Failed to fetch" / WebKit "Load failed" / Firefox "NetworkError when
  // attempting to fetch resource" — PostgREST 가 "TypeError: ..." 프리픽스로 감싼 문자열 포함.
  return /(Failed to fetch|Load failed|NetworkError when attempting to fetch)/.test(
    msg,
  );
}
