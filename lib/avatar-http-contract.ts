const AVATAR_PATH_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/i;

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

function extensionForMime(mime: string): "png" | "jpg" | "webp" | null {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  return null;
}

export type AvatarUploadInitAck = {
  path: string;
  ext: "png" | "jpg" | "webp";
  token: string;
};

export function parseAvatarUploadInitAck(
  value: unknown,
  expectedMime: string,
): AvatarUploadInitAck | null {
  const row = record(value);
  const expectedExt = extensionForMime(expectedMime);
  if (
    !row ||
    !expectedExt ||
    !hasExactKeys(row, ["path", "ext", "token"]) ||
    typeof row.path !== "string" ||
    typeof row.ext !== "string" ||
    row.ext !== expectedExt ||
    !AVATAR_PATH_RE.test(row.path) ||
    !row.path.endsWith(`.${expectedExt}`) ||
    typeof row.token !== "string" ||
    row.token.length === 0 ||
    row.token.length > 8192 ||
    row.token !== row.token.trim()
  ) {
    return null;
  }
  return {
    path: row.path,
    ext: expectedExt,
    token: row.token,
  };
}

function isExpectedPublicAvatarUrl(
  value: unknown,
  path: string,
  storageUrl: string,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    return false;
  }
  try {
    const url = new URL(value);
    const storage = new URL(storageUrl);
    const isSafeLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1");
    return (
      url.origin === storage.origin &&
      (url.protocol === "https:" || isSafeLocalHttp) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      decodeURIComponent(url.pathname) ===
        `/storage/v1/object/public/avatars/${path}`
    );
  } catch {
    return false;
  }
}

export type AvatarReplaceHttpAck =
  | { ok: true; avatarUrl: string; cleanup: "completed" }
  | { accepted: true; avatarUrl: string; cleanup: "pending" };

export function parseAvatarReplaceHttpAck(
  value: unknown,
  expected: { path: string; storageUrl: string },
): AvatarReplaceHttpAck | null {
  const row = record(value);
  if (!row) return null;
  if (
    hasExactKeys(row, ["ok", "avatarUrl"]) &&
    row.ok === true &&
    isExpectedPublicAvatarUrl(
      row.avatarUrl,
      expected.path,
      expected.storageUrl,
    )
  ) {
    return {
      ok: true,
      avatarUrl: row.avatarUrl,
      cleanup: "completed",
    };
  }
  if (
    hasExactKeys(row, ["accepted", "avatarUrl", "cleanup"]) &&
    row.accepted === true &&
    row.cleanup === "pending" &&
    isExpectedPublicAvatarUrl(
      row.avatarUrl,
      expected.path,
      expected.storageUrl,
    )
  ) {
    return {
      accepted: true,
      avatarUrl: row.avatarUrl,
      cleanup: "pending",
    };
  }
  return null;
}

export type AvatarClearHttpAck =
  | { ok: true; cleanup: "completed" }
  | { accepted: true; cleanup: "pending" };

export function parseAvatarClearHttpAck(
  value: unknown,
): AvatarClearHttpAck | null {
  const row = record(value);
  if (!row) return null;
  if (
    hasExactKeys(row, ["ok", "cleanup"]) &&
    row.ok === true &&
    row.cleanup === "completed"
  ) {
    return { ok: true, cleanup: "completed" };
  }
  if (
    hasExactKeys(row, ["accepted", "cleanup"]) &&
    row.accepted === true &&
    row.cleanup === "pending"
  ) {
    return { accepted: true, cleanup: "pending" };
  }
  return null;
}
