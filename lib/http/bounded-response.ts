export type BoundedResponseBytes =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: "too_large" | "read_failed" };

export type ResponseBodySurface = {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export function responseContentLengthAllowed(
  value: string | null,
  maxBytes: number,
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

/** Read a fetch response without ever buffering more than maxBytes. */
export async function readBoundedResponseBytes(
  response: ResponseBodySurface,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedResponseBytes> {
  if (
    !responseContentLengthAllowed(
      response.headers.get("content-length"),
      maxBytes,
    )
  ) {
    return { ok: false, error: "too_large" };
  }
  if (response.body === null) {
    return { ok: true, bytes: new Uint8Array() };
  }

  const reader = response.body.getReader();
  if (signal?.aborted) {
    await reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
    return { ok: false, error: "read_failed" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        return { ok: false, error: "read_failed" };
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel("response_too_large").catch(() => undefined);
        return { ok: false, error: "too_large" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, error: "read_failed" };
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
