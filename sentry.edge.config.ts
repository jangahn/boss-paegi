import * as Sentry from "@sentry/nextjs";

// edge 런타임(proxy/edge route)용. DSN 미설정이면 no-op.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    enableLogs: true,
    // proxy 는 모든 요청에 돌아 스팬 폭주 위험 → 트레이싱 off(에러/로그만).
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      const req = event.request;
      if (req?.url) req.url = req.url.split("?")[0];
      if (req && "query_string" in req) req.query_string = undefined;
      return event;
    },
  });
}
