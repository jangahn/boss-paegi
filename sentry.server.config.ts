import * as Sentry from "@sentry/nextjs";

// DSN 미설정이면 init 안 함 → getClient() undefined → 로그 브릿지/전송 전부 no-op (앱 정상).
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    // 성능 트레이싱 OFF — 알림/이슈 목적엔 불필요 (무료티어 절약).
    tracesSampleRate: 0,
    // 쿠키/IP/요청바디/인증헤더 미전송.
    sendDefaultPii: false,
    beforeSend(event) {
      // 서명 URL(?token=...) 등 쿼리스트링 제거 (sendDefaultPii=false 가 쿠키/헤더는 이미 차단).
      const req = event.request;
      if (req?.url) req.url = req.url.split("?")[0];
      if (req && "query_string" in req) req.query_string = undefined;
      return event;
    },
  });
}
