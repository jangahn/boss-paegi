import { isAllowedFalMediaUrl } from "./birefnet-contract.ts";

export const FAL_GENERATED_IMAGE_MAX_PIXELS = 40_000_000;

export type FluxPulidResult = {
  image: {
    url: string;
    width: number;
    height: number;
    contentType: "image/jpeg" | null;
    fileSize: number | null;
  };
  seed: number;
  nsfw: boolean;
};

export type PersistedFluxPulidResult = {
  candidateIndex: number;
  requestId: string;
  result: FluxPulidResult;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Exact projection of the fal-ai/flux-pulid result used by recovery. In
 * particular, the safety verdict must be present and boolean; truthy coercion
 * or a missing verdict can never make an image eligible for storage.
 */
export function parseFluxPulidResult(value: unknown): FluxPulidResult | null {
  const root = record(value);
  if (
    !root ||
    !Array.isArray(root.images) ||
    root.images.length !== 1 ||
    !Array.isArray(root.has_nsfw_concepts) ||
    root.has_nsfw_concepts.length !== 1 ||
    typeof root.has_nsfw_concepts[0] !== "boolean" ||
    !Number.isSafeInteger(root.seed) ||
    (root.seed as number) < 0
  ) {
    return null;
  }
  const image = record(root.images[0]);
  if (
    !image ||
    typeof image.url !== "string" ||
    !isAllowedFalMediaUrl(image.url) ||
    !Number.isSafeInteger(image.width) ||
    (image.width as number) < 1 ||
    !Number.isSafeInteger(image.height) ||
    (image.height as number) < 1 ||
    (image.width as number) * (image.height as number) >
      FAL_GENERATED_IMAGE_MAX_PIXELS ||
    (image.content_type !== undefined &&
      image.content_type !== "image/jpeg") ||
    (image.file_size !== undefined &&
      (!Number.isSafeInteger(image.file_size) ||
        (image.file_size as number) < 1))
  ) {
    return null;
  }
  return {
    image: {
      url: image.url,
      width: image.width as number,
      height: image.height as number,
      contentType:
        image.content_type === "image/jpeg" ? "image/jpeg" : null,
      fileSize:
        typeof image.file_size === "number" ? image.file_size : null,
    },
    seed: root.seed as number,
    nsfw: root.has_nsfw_concepts[0],
  };
}

export function fluxPulidResultEvidence(
  result: FluxPulidResult,
): Readonly<Record<string, unknown>> {
  return {
    image: {
      url: result.image.url,
      width: result.image.width,
      height: result.image.height,
      content_type: result.image.contentType,
      file_size: result.image.fileSize,
    },
    seed: result.seed,
    nsfw: result.nsfw,
  };
}

export function parsePersistedFluxPulidResult(
  value: unknown,
): FluxPulidResult | null {
  const root = record(value);
  const image = record(root?.image);
  if (
    !root ||
    Object.keys(root).sort().join(",") !== "image,nsfw,seed" ||
    !image ||
    Object.keys(image).sort().join(",") !==
      "content_type,file_size,height,url,width" ||
    typeof root.nsfw !== "boolean"
  ) {
    return null;
  }
  return parseFluxPulidResult({
    images: [
      {
        url: image.url,
        width: image.width,
        height: image.height,
        ...(image.content_type === null
          ? {}
          : { content_type: image.content_type }),
        ...(image.file_size === null ? {} : { file_size: image.file_size }),
      },
    ],
    seed: root.seed,
    has_nsfw_concepts: [root.nsfw],
  });
}

export function parsePersistedFluxPulidResults(
  value: unknown,
): PersistedFluxPulidResult[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const seen = new Set<number>();
  const parsed: PersistedFluxPulidResult[] = [];
  for (const item of value) {
    const row = record(item);
    if (
      !row ||
      Object.keys(row).sort().join(",") !==
        "candidate_index,output,request_id" ||
      !Number.isInteger(row.candidate_index) ||
      (row.candidate_index as number) < 0 ||
      (row.candidate_index as number) > 2 ||
      seen.has(row.candidate_index as number) ||
      typeof row.request_id !== "string" ||
      row.request_id.length < 1 ||
      row.request_id.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(row.request_id)
    ) {
      return null;
    }
    const result = parsePersistedFluxPulidResult(row.output);
    if (!result) return null;
    seen.add(row.candidate_index as number);
    parsed.push({
      candidateIndex: row.candidate_index as number,
      requestId: row.request_id,
      result,
    });
  }
  return parsed.sort((a, b) => a.candidateIndex - b.candidateIndex);
}

export function parseFluxPulidWebhookResult(
  rawBody: Uint8Array,
  signedRequestId: string,
):
  | { status: "ERROR"; result: null }
  | { status: "OK"; result: FluxPulidResult }
  | null {
  try {
    const root = record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      ),
    );
    if (
      !root ||
      root.request_id !== signedRequestId ||
      (root.status !== "OK" && root.status !== "ERROR")
    ) {
      return null;
    }
    if (root.status === "ERROR") return { status: "ERROR", result: null };
    const result = parseFluxPulidResult(root.payload);
    return result ? { status: "OK", result } : null;
  } catch {
    return null;
  }
}
