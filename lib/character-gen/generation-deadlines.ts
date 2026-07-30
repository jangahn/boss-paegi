/** Ordinary queued generation recovery/finalization deadline. */
export const QUEUED_STALE_MS = 30 * 60 * 1000;

/**
 * Unknown-ack upper policy: 10-minute caller start deadline + fal's documented
 * default one-hour processing timeout + two-hour webhook retry window +
 * ten-minute operational margin. The model provider does not expose a submit
 * idempotency key or a caller-enforced processing deadline, so this is an
 * explicit external-service boundary rather than a mathematical delivery
 * guarantee.
 */
export const SUBMIT_ACK_STALE_MS = 200 * 60 * 1000;
