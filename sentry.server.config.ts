import * as Sentry from "@sentry/nextjs";

// DSN 미설정이면 init 안 함 → getClient() undefined → 로그 브릿지/전송 전부 no-op (앱 정상).
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    // 구조화 로그 → Explore→Logs (lib/sentry-bridge 가 Sentry.logger 로 전송).
    enableLogs: true,
    // 라우트별 차등 샘플링(무료 5M spans 제어). /api/generations 는 4초 폴링이라 강 다운샘플.
    // 트레이싱은 production 한정 — dev/preview 가 prod 대시보드를 environment:development 로 오염시키지 않게.
    tracesSampler: (ctx) => {
      if (process.env.VERCEL_ENV !== "production") return 0;
      const a = (ctx?.attributes ?? {}) as Record<string, unknown>;
      const hay = `${ctx?.name ?? ""} ${a["http.route"] ?? ""} ${a["url"] ?? a["http.target"] ?? ""}`;
      if (hay.includes("/monitoring")) return 0; // Sentry 터널
      if (hay.includes("/api/generations")) return 0.05;
      if (hay.includes("/api/fal") || hay.includes("/api/doll")) return 1.0;
      if (hay.includes("/api/score")) return 0.5;
      return 0.1;
    },
    // fal/Supabase(서드파티)엔 trace 헤더 안 붙임 — 자기 도메인만.
    tracePropagationTargets: ["localhost", /^https:\/\/boss-paegi\.vercel\.app/],
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
