import { runClientMutation } from "./client-mutation.ts";

export const CLIENT_ASSET_LOAD_DEADLINE_MS = 20_000;
export const CLIENT_ASSET_LOAD_ATTEMPT_MS = 19_000;

/**
 * Bounds a single client asset-loader attempt. Asset loaders such as Pixi's
 * cache cannot be safely replayed as a second independent operation, so a
 * timeout is fail-visible and the caller decides when the user may retry.
 */
export async function loadClientAssetWithDeadline<T>(
  load: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    attemptMs?: number;
  } = {},
): Promise<T> {
  const outcome = await runClientMutation({
    attempt: async () => ({
      kind: "confirmed",
      value: await load(),
    }),
    signal: options.signal,
    deadlineMs: options.deadlineMs ?? CLIENT_ASSET_LOAD_DEADLINE_MS,
    attemptMs: options.attemptMs ?? CLIENT_ASSET_LOAD_ATTEMPT_MS,
  });
  if (outcome.kind === "confirmed") return outcome.value;
  if (outcome.kind === "aborted") {
    throw options.signal?.reason ?? new Error("client_asset_load_aborted");
  }
  throw new Error("client_asset_load_unconfirmed");
}
