type UploadOperation = {
  requestId: string;
  month: string;
  digest: string;
  binding: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function currentKstMonth(): string {
  const date = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
  return date.slice(0, 4) + date.slice(5, 7);
}

async function sha256Blob(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function storageKey(scope: string): string {
  return `boss-paegi:upload-operation:v1:${scope}`;
}

/**
 * Persist only an opaque operation id and content digest. The source image or
 * clip bytes are never written to Web Storage/IndexedDB.
 */
async function stableOperation(args: {
  scope: string;
  binding: string;
  digest: string;
}): Promise<UploadOperation> {
  const key = storageKey(args.scope);
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null") as
      | Partial<UploadOperation>
      | null;
    if (
      parsed &&
      UUID_RE.test(parsed.requestId ?? "") &&
      /^\d{6}$/.test(parsed.month ?? "") &&
      DIGEST_RE.test(parsed.digest ?? "") &&
      parsed.digest === args.digest &&
      parsed.binding === args.binding
    ) {
      return parsed as UploadOperation;
    }
  } catch {
    // Corrupt/disabled storage falls back to a process-local logical attempt.
  }
  const operation = {
    requestId: crypto.randomUUID(),
    month: currentKstMonth(),
    digest: args.digest,
    binding: args.binding,
  };
  try {
    sessionStorage.setItem(key, JSON.stringify(operation));
  } catch {
    // The server still enforces one request id for this invocation.
  }
  return operation;
}

export async function stableClientUploadOperation(args: {
  scope: string;
  binding: string;
  blob: Blob;
}): Promise<UploadOperation> {
  return stableOperation({
    scope: args.scope,
    binding: args.binding,
    digest: await sha256Blob(args.blob),
  });
}

/** Stable tab-local UUID for a logical operation that has no upload bytes. */
export async function stableClientOperation(args: {
  scope: string;
  binding: string;
}): Promise<UploadOperation> {
  return stableOperation({
    scope: args.scope,
    binding: args.binding,
    digest: await sha256Text(args.binding),
  });
}

export function clearClientUploadOperation(
  scope: string,
  requestId: string,
): void {
  const key = storageKey(scope);
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null") as
      | Partial<UploadOperation>
      | null;
    if (parsed?.requestId === requestId) {
      sessionStorage.removeItem(key);
    }
  } catch {
    sessionStorage.removeItem(key);
  }
}
