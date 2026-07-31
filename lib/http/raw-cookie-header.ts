const COOKIE_HEADER_MAX_CHARS = 256 * 1024;

export type RawCookiePair = {
  name: string;
  value: string;
};

export type RawCookieHeaderResult =
  | { kind: "ok"; cookies: readonly RawCookiePair[] }
  | { kind: "invalid" };

/**
 * Parses a Cookie request header without collapsing duplicate names.
 *
 * Native/Next cookie maps intentionally keep one value per name, which is
 * unsuitable for security CAS: duplicate marker, proof, base or chunk cookies
 * must be observable and rejected. Percent-decode failures are fail-closed.
 */
export function parseRawCookieHeader(
  header: string | null | undefined,
): RawCookieHeaderResult {
  if (!header) return { kind: "ok", cookies: [] };
  if (header.length > COOKIE_HEADER_MAX_CHARS) {
    return { kind: "invalid" };
  }
  const cookies: RawCookiePair[] = [];
  for (const segment of header.split(";")) {
    const pair = segment.trim();
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    if (equals <= 0) return { kind: "invalid" };
    const rawName = pair.slice(0, equals).trim();
    const rawValue = pair.slice(equals + 1).trim();
    if (
      rawName.length === 0 ||
      /[\s\u0000-\u001f\u007f();,\\"]/u.test(rawName)
    ) {
      return { kind: "invalid" };
    }
    try {
      cookies.push({
        name: decodeURIComponent(rawName),
        value: decodeURIComponent(rawValue),
      });
    } catch {
      return { kind: "invalid" };
    }
    if (cookies.length > 512) return { kind: "invalid" };
  }
  return { kind: "ok", cookies };
}

function rawNameCouldDecodeToPrefix(
  rawName: string,
  prefix: string,
): boolean {
  let decodedPrefix = "";
  for (
    let index = 0;
    index < rawName.length &&
    decodedPrefix.length < prefix.length;
    index += 1
  ) {
    if (rawName[index] !== "%") {
      decodedPrefix += rawName[index];
      continue;
    }
    const hex = rawName.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/iu.test(hex)) {
      // Once an escape is malformed it cannot complete a still-partial
      // protected prefix. Treat it as protected only when the valid bytes
      // before the bad escape already established the whole namespace.
      return decodedPrefix.startsWith(prefix);
    }
    decodedPrefix += String.fromCharCode(
      Number.parseInt(hex, 16),
    );
    index += 2;
  }
  return (
    decodedPrefix.startsWith(prefix) ||
    prefix.startsWith(decodedPrefix)
  );
}

/**
 * Parses only security-sensitive cookie namespaces. Malformed unrelated
 * cookies are ignored so an extension/legacy app cannot permanently pin OAuth
 * recovery, while any name that is or could decode to a protected prefix
 * remains duplicate-observable and fail-closed.
 */
export function parseRawCookieHeaderForPrefixes(
  header: string | null | undefined,
  prefixes: readonly string[],
): RawCookieHeaderResult {
  if (
    prefixes.length === 0 ||
    prefixes.some((prefix) => prefix.length === 0)
  ) {
    return { kind: "invalid" };
  }
  if (!header) return { kind: "ok", cookies: [] };
  if (header.length > COOKIE_HEADER_MAX_CHARS) {
    return { kind: "invalid" };
  }
  const cookies: RawCookiePair[] = [];
  let pairCount = 0;
  for (const segment of header.split(";")) {
    const pair = segment.trim();
    if (pair.length === 0) continue;
    pairCount += 1;
    if (pairCount > 512) return { kind: "invalid" };
    const equals = pair.indexOf("=");
    const rawName = (
      equals < 0 ? pair : pair.slice(0, equals)
    ).trim();
    const protectedRawName = prefixes.some((prefix) =>
      rawNameCouldDecodeToPrefix(rawName, prefix),
    );
    if (
      equals <= 0 ||
      rawName.length === 0 ||
      /[\s\u0000-\u001f\u007f();,\\"]/u.test(rawName)
    ) {
      if (protectedRawName) return { kind: "invalid" };
      continue;
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      if (protectedRawName) return { kind: "invalid" };
      continue;
    }
    if (!prefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    const rawValue = pair.slice(equals + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      return { kind: "invalid" };
    }
    cookies.push({ name, value });
  }
  return { kind: "ok", cookies };
}
