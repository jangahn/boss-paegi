import * as Sentry from "@sentry/nextjs";

// 런타임별 Sentry 서버/엣지 init 로드. (클라는 instrumentation-client.ts)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// 서버/RSC/Route 의 미처리 에러를 Sentry 로 (handled 로그는 sentry-bridge 가 별도 surface).
export const onRequestError = Sentry.captureRequestError;
