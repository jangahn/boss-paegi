import * as Sentry from "@sentry/nextjs";
import {
  resolveSentryReplayPolicy,
  sentryReplayIntegrations,
} from "@/lib/sentry-replay-policy";

// 브라우저(클라이언트)용 Sentry init — 클라 미처리 런타임 에러 자동 포착.
// DSN 미설정이면 no-op. (VERCEL_ENV 는 클라에 노출 안 되므로 NEXT_PUBLIC_* 또는 NODE_ENV)
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
// 트레이싱은 production 에서만. dev/preview 가 공용(프로젝트 단위) 무료 한도를
// 태우거나 prod 데이터에 environment:development 를 섞지 않게 한다.
const env =
  process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "development";
const isProd = env === "production";
// Session Replay는 화면 상태를 처리하므로 별도 운영 opt-in을 요구한다.
// production 이면서 exact literal "1"일 때만 통합 자체를 설치한다.
const replay = resolveSentryReplayPolicy(
  env,
  process.env.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED,
);

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
    // Session Replay (prod + exact opt-in 한정) — 에러 세션 100% + 일반 10%.
    // 비활성 상태에서는 두 sampling rate가 0이고 Replay 통합도 설치하지 않는다.
    replaysOnErrorSampleRate: replay.replaysOnErrorSampleRate,
    replaysSessionSampleRate: replay.replaysSessionSampleRate,
    integrations: [
      ...sentryReplayIntegrations(replay, () =>
        // 게임 UI/텍스트는 비민감이라 언마스크. 단 업로드 얼굴 크롭
        // (.sentry-block-face)만 차단. PixiJS 캔버스 replay 확장은 미사용.
        Sentry.replayIntegration({
          maskAllText: false,
          blockAllMedia: false,
          maskAllInputs: false,
          block: [".sentry-block-face"],
          mask: [".sentry-block-face"],
        }),
      ),
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
        // 폼엔 이름/이메일 칸 숨기되, 로그인 유저의 닉네임·email 은 Sentry.setUser 값에서
        // 가져와 숨김 컨텍스트로 피드백에 첨부 → 누가 보냈는지 식별. 익명은 email 없어 닉네임만.
        useSentryUser: { email: "email", name: "username" },
        isEmailRequired: false,
        isNameRequired: false,
        triggerLabel: "의견",
        formTitle: "의견 보내기",
        messageLabel: "내용", // 기본 라벨이 영문("Description")이라 폼 전체 한글 통일
        // 개인정보 안내 — 로그인 상태에선 닉네임·이메일이 함께 전송됨을 폼에서 고지.
        messagePlaceholder:
          "버그·건의 무엇이든 자유롭게 남겨주세요.\n로그인 상태에선 닉네임·이메일이 함께 전송돼요.",
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
