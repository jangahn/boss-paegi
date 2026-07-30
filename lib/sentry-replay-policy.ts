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
 * Session Replay processes visible browser state, so it has a stricter gate
 * than ordinary error/performance monitoring. It is enabled only when both:
 * - the browser environment is exactly production; and
 * - the public operational opt-in is the exact literal "1".
 *
 * Values such as "true", "01", whitespace-padded "1", preview, and an
 * absent variable all fail closed.
 */
export function resolveSentryReplayPolicy(
  environment: string,
  operationalOptIn: string | undefined,
): SentryReplayPolicy {
  return environment === "production" && operationalOptIn === "1"
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
