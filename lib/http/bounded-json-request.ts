import { readBoundedResponseBytes } from "./bounded-response.ts";

export type BoundedJsonRequestResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error:
        | "invalid_content_type"
        | "too_large"
        | "read_failed"
        | "invalid_json";
    };

export async function readBoundedJsonRequest(
  request: {
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
  },
  maxBytes: number,
): Promise<BoundedJsonRequestResult> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, error: "invalid_content_type" };
  }
  const bounded = await readBoundedResponseBytes(request, maxBytes);
  if (!bounded.ok) return bounded;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bounded.bytes,
    );
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}
