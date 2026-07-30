// Generation uploads are public HTTP input even though the route later
// requires a member. Keep parsing bounded before auth/config/provider work.

export const GENERATION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const GENERATION_FORM_OVERHEAD_MAX_BYTES = 64 * 1024;
export const GENERATION_FORM_MAX_BODY_BYTES =
  GENERATION_IMAGE_MAX_BYTES + GENERATION_FORM_OVERHEAD_MAX_BYTES;

type RequestBodySurface = {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export type GenerationFormReadResult =
  | { ok: true; form: FormData }
  | { ok: false; error: "body_too_large" | "invalid_body" };

export function generationContentLengthAllowed(
  value: string | null,
  maxBytes = GENERATION_FORM_MAX_BODY_BYTES,
): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return false;
  if (value === null) return true;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) <= BigInt(maxBytes);
  } catch {
    return false;
  }
}

export async function readGenerationRequestBody(
  request: RequestBodySurface,
  maxBytes = GENERATION_FORM_MAX_BODY_BYTES,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: "body_too_large" | "invalid_body" }
> {
  if (
    !generationContentLengthAllowed(
      request.headers.get("content-length"),
      maxBytes,
    )
  ) {
    return { ok: false, error: "body_too_large" };
  }

  if (request.body === null) {
    return { ok: true, bytes: new Uint8Array() };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        return { ok: false, error: "invalid_body" };
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        void reader.cancel("body_too_large").catch(() => undefined);
        return { ok: false, error: "body_too_large" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, error: "invalid_body" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readGenerationFormData(
  request: RequestBodySurface,
): Promise<GenerationFormReadResult> {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)
  ) {
    return { ok: false, error: "invalid_body" };
  }

  const body = await readGenerationRequestBody(request);
  if (!body.ok) return body;
  try {
    const form = await new Response(body.bytes.buffer as ArrayBuffer, {
      headers: { "content-type": contentType },
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, error: "invalid_body" };
  }
}
