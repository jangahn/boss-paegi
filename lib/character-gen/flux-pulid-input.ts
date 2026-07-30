import type { GenerationPlan } from "./plan.ts";

export type FluxPulidQueueInput = Readonly<{
  prompt: string;
  reference_image_url: string;
  image_size: string;
  num_inference_steps: number;
  guidance_scale: number;
  negative_prompt: string;
  true_cfg: number;
  id_weight: number;
  enable_safety_checker: boolean;
  max_sequence_length: number;
}>;

export function buildFluxPulidInputs(
  faceImageUrl: string,
  plan: GenerationPlan,
): { index: number; input: FluxPulidQueueInput }[] {
  return plan.candidates.map((candidate) => ({
    index: candidate.index,
    input: {
      prompt: candidate.positivePrompt,
      reference_image_url: faceImageUrl,
      image_size: plan.request.imageSize,
      num_inference_steps: plan.request.numInferenceSteps,
      guidance_scale: plan.request.guidanceScale,
      negative_prompt: plan.negative,
      true_cfg: plan.request.trueCfg,
      id_weight: plan.request.idWeight,
      enable_safety_checker: plan.request.enableSafetyChecker,
      max_sequence_length: plan.request.maxSequenceLength,
    },
  }));
}
