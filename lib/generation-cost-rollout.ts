export const GENERATION_COST_ROLLOUT_HEADER =
  "x-boss-paegi-generation-cost-rollout";
export const GENERATION_COST_FROZEN_BODY = {
  error: "generation_unavailable",
} as const;

/**
 * Exact opt-in gate for routes that can start paid fal.ai work.
 *
 * Defaulting closed is intentional: the database expand migration must land
 * before a full application deployment is allowed to reach Moondream or
 * birefnet. Values such as "true", "yes", or whitespace variants never open
 * the boundary accidentally.
 */
export function generationCostPathEnabled(
  value: string | undefined = process.env.GENERATION_COST_PATH_ENABLED,
): boolean {
  return value === "1";
}
