import * as Sentry from "@sentry/nextjs";

// 브라우저(클라이언트)용 Sentry init — 클라 미처리 런타임 에러 자동 포착.
// DSN 미설정이면 no-op. (VERCEL_ENV 는 클라에 노출 안 되므로 NEXT_PUBLIC_* 또는 NODE_ENV)
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
// 트레이싱·세션 리플레이는 production 에서만. dev/preview 가 공용(프로젝트 단위) 무료 한도
// (리플레이 50/월·span 5M)를 태우거나 prod 데이터에 environment:development 를 섞지 않게.
const env =
  process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "development";
const isProd = env === "production";

if (dsn) {
  Sentry.init({
    dsn,
    environment: env,
    // 구조화 로그 → Explore→Logs. (로그/에러는 모든 환경에서 — environment 로 필터.)
    enableLogs: true,
    // 성능 트레이싱 10% (prod 한정). browserTracing 자동 = pageload/navigation/Web Vitals.
    tracesSampleRate: isProd ? 0.1 : 0,
    // IP·헤더·쿠키 미수집(PIPA). 게임데이터·userKey·닉네임은 별도로 명시 부착(lib/sentry-context).
    sendDefaultPii: false,
    // Session Replay (prod 한정) — 에러 세션 100% + 일반 20%(무료 50/월 한도 내).
    // dev/preview 는 0 → 공용 리플레이 한도 미소모.
    replaysOnErrorSampleRate: isProd ? 1.0 : 0,
    replaysSessionSampleRate: isProd ? 0.2 : 0,
    integrations: [
      // 게임 UI/텍스트는 비민감이라 언마스크. 단 업로드 얼굴 크롭(.sentry-block-face)만 차단.
      // (PixiJS 캔버스 녹화 replayCanvasIntegration 는 미사용 — 모바일 perf.)
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
        maskAllInputs: false,
        block: [".sentry-block-face"],
        mask: [".sentry-block-face"],
      }),
      // 인앱 의견/버그 제보 위젯. async = 모달/스크린샷 코드는 클릭 시 CDN 지연로드 →
      // 초기 번들 경량(모바일 PWA Lighthouse). 스크린샷 OFF(얼굴/캔버스 캡처 방지). /play 에선 CSS 로 숨김.
      Sentry.feedbackAsyncIntegration({
        autoInject: true,
        id: "sentry-feedback",
        colorScheme: "system",
        showBranding: false,
        enableScreenshot: false,
        showName: false,
        showEmail: false,
        triggerLabel: "의견",
        formTitle: "의견 보내기",
        messagePlaceholder: "버그·건의 무엇이든 자유롭게 남겨주세요",
        submitButtonLabel: "보내기",
        cancelButtonLabel: "취소",
        successMessageText: "보내주셔서 감사합니다!",
      }),
    ],
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

