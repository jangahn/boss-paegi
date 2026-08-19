export const HIGHLIGHT_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const DOLL_IMAGE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const OG_DOLL_IMAGE_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;

type MediaKind = "video" | "image" | "ogImage";
type SupportedMediaType =
  | "video/mp4"
  | "video/webm"
  | "image/png"
  | "image/jpeg"
  | "image/webp";

const TYPES: Record<
  MediaKind,
  readonly SupportedMediaType[]
> = {
  video: ["video/mp4", "video/webm"],
  image: ["image/png", "image/jpeg", "image/webp"],
  // OG 이미지(satori/next/og) 임베드용: satori 는 png/apng/jpeg/gif/svg 만 지원하고 webp 를
  // 못 그린다(`u2 is not iterable` 로 렌더 전체가 500). accept 목록은 그대로 콘텐츠 협상
  // 헤더가 되는데, Supabase 이미지 변환 엔드포인트는 accept 에 webp 가 있으면 webp 로
  // 응답하므로 이 kind 에서는 webp 를 협상에서 제외한다(→ 원본 포맷 png 유지).
  ogImage: ["image/png", "image/jpeg"],
};

const EXTENSIONS: Record<SupportedMediaType, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export class MediaDownloadError extends Error {
  readonly kind:
    | "invalid_url"
    | "http"
    | "content_type"
    | "too_large"
    | "empty"
    | "signature";
  readonly status: number | undefined;

  constructor(
    kind: MediaDownloadError["kind"],
    status?: number,
  ) {
    super(
      kind === "http"
        ? `media_download_http_${status ?? "unknown"}`
        : `media_download_${kind}`,
    );
    this.name = "MediaDownloadError";
    this.kind = kind;
    this.status = status;
  }
}

function validHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !!parsed.hostname &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function bytesStartWith(
  bytes: Uint8Array,
  expected: readonly number[],
  offset = 0,
): boolean {
  return (
    bytes.length >= offset + expected.length &&
    expected.every((value, index) => bytes[offset + index] === value)
  );
}

async function hasMediaSignature(
  blob: Blob,
  type: SupportedMediaType,
): Promise<boolean> {
  const bytes = new Uint8Array(
    await blob.slice(0, 16).arrayBuffer(),
  );
  if (type === "video/mp4") {
    return bytesStartWith(bytes, [0x66, 0x74, 0x79, 0x70], 4);
  }
  if (type === "video/webm") {
    return bytesStartWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  }
  if (type === "image/png") {
    return bytesStartWith(bytes, [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  }
  if (type === "image/jpeg") {
    return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
  }
  return (
    bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytesStartWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

export type DownloadedMedia = {
  blob: Blob;
  type: SupportedMediaType;
  extension: string;
};

async function readBoundedBlob(
  response: Response,
  maxBytes: number,
  type: SupportedMediaType,
): Promise<Blob> {
  if (response.body === null) return new Blob([], { type });

  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new MediaDownloadError("too_large");
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel("media_too_large").catch(() => undefined);
        throw new MediaDownloadError("too_large");
      }
      // Own each chunk: a stream implementation may reuse/mutate its backing
      // buffer after the next read.
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      parts.push(copy.buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(parts, { type });
}

export async function fetchMediaBlob(
  url: string,
  options: {
    kind: MediaKind;
    maxBytes: number;
    signal?: AbortSignal;
    redirect?: "follow" | "error";
  },
  fetcher: typeof fetch = fetch,
): Promise<DownloadedMedia> {
  if (
    !validHttpUrl(url) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  ) {
    throw new MediaDownloadError("invalid_url");
  }
  const accepted = TYPES[options.kind];
  const response = await fetcher(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: accepted.join(", ") },
    signal: options.signal,
    redirect: options.redirect ?? "follow",
  });
  if (!response.ok) {
    throw new MediaDownloadError("http", response.status);
  }
  if (response.url && !validHttpUrl(response.url)) {
    throw new MediaDownloadError("invalid_url");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      throw new MediaDownloadError("too_large");
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > options.maxBytes) {
      throw new MediaDownloadError("too_large");
    }
  }

  const type = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!type || !accepted.includes(type as SupportedMediaType)) {
    throw new MediaDownloadError("content_type");
  }

  const blob = await readBoundedBlob(
    response,
    options.maxBytes,
    type as SupportedMediaType,
  );
  if (blob.size === 0) throw new MediaDownloadError("empty");
  if (blob.size > options.maxBytes) {
    throw new MediaDownloadError("too_large");
  }
  if (!(await hasMediaSignature(blob, type as SupportedMediaType))) {
    throw new MediaDownloadError("signature");
  }
  return {
    blob,
    type: type as SupportedMediaType,
    extension: EXTENSIONS[type as SupportedMediaType],
  };
}
