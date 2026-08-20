export type SentryReplayPolicy = Readonly<{
  enabled: boolean;
  replaysOnErrorSampleRate: 0 | 1;
  replaysSessionSampleRate: 0 | 0.1;
}>;

const DISABLED_REPLAY_POLICY: SentryReplayPolicy = Object.freeze({
  enabled: false,
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,
});

const ENABLED_REPLAY_POLICY: SentryReplayPolicy = Object.freeze({
  enabled: true,
  replaysOnErrorSampleRate: 1,
  replaysSessionSampleRate: 0.1,
});

/**
 * Session Replay는 production 상시 활성이다(2026-08-21 운영 결정으로
 * env opt-in 게이트 제거). dev/preview는 무료 한도 소진과 environment
 * 혼입을 막기 위해 계속 비활성이며, exact "production"만 활성으로 본다.
 * 업로드 얼굴 영역은 instrumentation-client의 `.sentry-block-face`
 * block/mask로 녹화에서 제외된다.
 */
export function resolveSentryReplayPolicy(
  environment: string,
): SentryReplayPolicy {
  return environment === "production"
    ? ENABLED_REPLAY_POLICY
    : DISABLED_REPLAY_POLICY;
}

/**
 * Lazily creates the Replay integration only after the policy gate passes.
 * Keeping the factory lazy prevents disabled deployments from installing the
 * integration with merely-zero sampling.
 */
export function sentryReplayIntegrations<T>(
  policy: SentryReplayPolicy,
  createIntegration: () => T,
): T[] {
  return policy.enabled ? [createIntegration()] : [];
}
