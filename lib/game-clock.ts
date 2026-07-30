/**
 * performance.now() legitimately starts at 0. `active` is the lifecycle
 * sentinel; timestamp truthiness must never decide whether a game started.
 */
export function activeGameElapsedMs(
  active: boolean,
  startedAt: number,
  now: number,
): number {
  if (!active) return 0;
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, now - startedAt);
}

export function firstHitElapsedMs(args: {
  hitCount: number;
  active: boolean;
  startedAt: number;
  now: number;
  previous: number | null;
}): number | null {
  if (args.hitCount !== 0 || !args.active) return args.previous;
  return Math.round(
    activeGameElapsedMs(true, args.startedAt, args.now),
  );
}
