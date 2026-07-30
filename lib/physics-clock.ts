/** Matter 0.20 warns and becomes less stable above its 60 Hz base delta. */
export const MATTER_MAX_STEP_MS = 1000 / 60;
/** Do not simulate an entire background-tab pause on the next visible frame. */
export const PHYSICS_FRAME_CLAMP_MS = 32;

export type PhysicsStepPlan = Readonly<{
  steps: number;
  stepMs: number;
}>;

/**
 * Convert an arbitrary render-frame delta into bounded Matter updates.
 * Invalid/non-positive clocks are a no-op; long frames retain at most 32 ms
 * and are evenly subdivided so every Engine.update call is <= 1000/60 ms.
 */
export function planPhysicsSteps(deltaMs: number): PhysicsStepPlan {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return { steps: 0, stepMs: 0 };
  }
  const simulatedMs = Math.min(deltaMs, PHYSICS_FRAME_CLAMP_MS);
  // Subnormal positive numbers may underflow to 0 when divided; they still
  // represent a valid forward clock and therefore get one tiny update.
  const steps = Math.max(
    1,
    Math.ceil(simulatedMs / MATTER_MAX_STEP_MS),
  );
  return { steps, stepMs: simulatedMs / steps };
}
