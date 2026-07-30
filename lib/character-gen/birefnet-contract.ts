export type BirefnetImage = {
  url: string;
  width: number;
  height: number;
  contentType: "image/png" | null;
};

function exactObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * New submissions require the documented private fal CDN v3 object surface.
 * Legacy public fal.media/GCS fallbacks are rejected: the per-request
 * lifecycle ACL can only be proven for v3 objects, so accepting another host
 * would silently widen generated-media visibility.
 */
export function isAllowedFalMediaUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return false;
    }
    return (
      parsed.hostname.toLowerCase() === "v3b.fal.media" &&
      parsed.pathname.startsWith("/files/b/") &&
      parsed.pathname.length > "/files/b/".length
    );
  } catch {
    return false;
  }
}

export const isAllowedBirefnetOutputUrl = isAllowedFalMediaUrl;

export function parseBirefnetOutput(value: unknown): BirefnetImage | null {
  const root = exactObject(value);
  const image = exactObject(root?.image);
  if (!image) return null;
  if (
    typeof image.url !== "string" ||
    !isAllowedFalMediaUrl(image.url) ||
    !Number.isSafeInteger(image.width) ||
    (image.width as number) < 1 ||
    (image.width as number) > 8192 ||
    !Number.isSafeInteger(image.height) ||
    (image.height as number) < 1 ||
    (image.height as number) > 8192 ||
    (image.content_type !== undefined &&
      image.content_type !== "image/png")
  ) {
    return null;
  }
  return {
    url: image.url,
    width: image.width as number,
    height: image.height as number,
    contentType:
      image.content_type === "image/png" ? "image/png" : null,
  };
}
