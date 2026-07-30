import { dollPath } from "./storage-path.ts";

export type ModerationImagePathState =
  | { kind: "purged" }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "signable"; path: string };

/**
 * A malformed legacy row must never become a Storage signing oracle, but one
 * corrupt row must not make the entire moderation queue unavailable either.
 */
export function resolveModerationImagePath(
  imageUrl: string | null,
  artifactsPurgedAt: string | null,
): ModerationImagePathState {
  if (artifactsPurgedAt) return { kind: "purged" };
  if (!imageUrl) return { kind: "missing" };
  const path = dollPath(imageUrl);
  return path ? { kind: "signable", path } : { kind: "invalid" };
}
