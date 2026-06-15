import * as Sentry from "@sentry/nextjs";

// 브라우저(클라이언트)용 Sentry init — 클라 미처리 런타임 에러 자동 포착.
// DSN 미설정이면 no-op. (VERCEL_ENV 는 클라에 노출 안 되므로 NEXT_PUBLIC_* 또는 NODE_ENV)
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "development",
    // 구조화 로그 → Explore→Logs.
    enableLogs: true,
    // 성능 트레이싱 10% (browserTracing 자동 = pageload/navigation/Web Vitals 수집).
    // 세션 리플레이는 OFF — 얼굴(개인정보)+PixiJS 캔버스라 가치 낮음/리스크(replayIntegration 미추가).
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend(event) {
      const req = event.request;
      if (req?.url) req.url = req.url.split("?")[0];
      if (req && "query_string" in req) req.query_string = undefined;
      return event;
    },
  });
}

// 네비게이션 계측 hook — tracesSampleRate>0 이므로 라우트 전환 트레이스 생성.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

