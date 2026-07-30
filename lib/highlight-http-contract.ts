const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function extensionForMime(mime: string): "mp4" | "webm" | null {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/webm") return "webm";
  return null;
}

export type HighlightUploadInitAck = {
  uploadId: string;
  ext: "mp4" | "webm";
  path: string;
  token: string;
};

export function parseHighlightUploadInitAck(
  value: unknown,
  expected: { scoreId: string; mime: string },
): HighlightUploadInitAck | null {
  const row = record(value);
  const expectedExt = extensionForMime(expected.mime);
  if (
    !row ||
    !UUID_RE.test(expected.scoreId) ||
    !expectedExt ||
    !hasExactKeys(row, ["uploadId", "ext", "path", "token"]) ||
    typeof row.uploadId !== "string" ||
    !UUID_RE.test(row.uploadId) ||
    row.ext !== expectedExt ||
    row.path !== `${expected.scoreId}/${row.uploadId}.${expectedExt}` ||
    typeof row.token !== "string" ||
    row.token.length === 0 ||
    row.token.length > 8192 ||
    row.token !== row.token.trim()
  ) {
    return null;
  }
  return {
    uploadId: row.uploadId,
    ext: expectedExt,
    path: row.path,
    token: row.token,
  };
}

export type HighlightMutationHttpAck =
  | { ok: true; alreadyAttached: false }
  | { ok: true; alreadyAttached: true };

export function parseHighlightMutationHttpAck(
  value: unknown,
): HighlightMutationHttpAck | null {
  const row = record(value);
  if (!row) return null;
  if (hasExactKeys(row, ["ok"]) && row.ok === true) {
    return { ok: true, alreadyAttached: false };
  }
  if (
    hasExactKeys(row, ["ok", "alreadyAttached"]) &&
    row.ok === true &&
    row.alreadyAttached === true
  ) {
    return { ok: true, alreadyAttached: true };
  }
  return null;
}
