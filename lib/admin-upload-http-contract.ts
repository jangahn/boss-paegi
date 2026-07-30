const EVENT_PATH_RE =
  /^\d{6}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/i;
const SITE_PATH_RE =
  /^(og|logo)\/\d{6}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/i;

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

export type AdminUploadInitAck = {
  path: string;
  ext: "png" | "jpg" | "webp" | "gif";
  token: string;
};

export function parseAdminUploadInitAck(
  value: unknown,
  expected:
    | { surface: "event" }
    | { surface: "site"; slot: "og" | "logo" },
): AdminUploadInitAck | null {
  const row = record(value);
  if (
    !row ||
    !hasExactKeys(row, ["path", "ext", "token"]) ||
    typeof row.path !== "string" ||
    typeof row.ext !== "string" ||
    typeof row.token !== "string" ||
    row.token.length === 0 ||
    row.token.length > 8192 ||
    row.token !== row.token.trim()
  ) {
    return null;
  }
  const match =
    expected.surface === "event"
      ? EVENT_PATH_RE.exec(row.path)
      : SITE_PATH_RE.exec(row.path);
  if (
    !match ||
    match.at(-1)?.toLowerCase() !== row.ext.toLowerCase() ||
    (expected.surface === "site" && match[1] !== expected.slot)
  ) {
    return null;
  }
  return row as AdminUploadInitAck;
}

export type AdminUploadConfirmAck = {
  ok: true;
  path: string;
  url: string;
};

export function parseAdminUploadConfirmAck(
  value: unknown,
  expected: {
    path: string;
    bucket: "events" | "site-assets";
    urlField: "url" | "previewUrl";
    storageUrl: string;
  },
): AdminUploadConfirmAck | null {
  const row = record(value);
  if (
    !row ||
    !hasExactKeys(row, ["ok", "path", expected.urlField]) ||
    row.ok !== true ||
    row.path !== expected.path
  ) {
    return null;
  }
  const rawUrl = row[expected.urlField];
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > 8192
  ) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    const storageAuthority = new URL(expected.storageUrl);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      url.origin !== storageAuthority.origin ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" ||
            url.hostname === "localhost" ||
            url.hostname === "::1"))) ||
      url.username !== "" ||
      url.password !== "" ||
      !decodedPath.endsWith(`/${expected.bucket}/${expected.path}`)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    ok: true,
    path: expected.path,
    url: rawUrl,
  };
}
