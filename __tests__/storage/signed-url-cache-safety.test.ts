import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const HTML_SIGNED_URL_ROUTES = [
  "app/share/[scoreId]/page.tsx",
  "app/history/[userId]/[scoreId]/page.tsx",
  "app/doll/[id]/page.tsx",
] as const;

test("HTML routes embedding expiring private URLs always render at request time", () => {
  for (const relative of HTML_SIGNED_URL_ROUTES) {
    const source = readFileSync(
      new URL(`../../${relative}`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /export const dynamic = "force-dynamic"/,
      relative,
    );
    assert.doesNotMatch(
      source,
      /export const revalidate = [1-9]/,
      relative,
    );
    assert.match(source, /signed(?:Doll|Highlight)Url\(/, relative);
  }
});

test("OG image routes may cache rendered bytes, not their short-lived source URL", () => {
  for (const relative of [
    "app/share/[scoreId]/opengraph-image.tsx",
    "app/doll/[id]/opengraph-image.tsx",
  ]) {
    const source = readFileSync(
      new URL(`../../${relative}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /signedDollUrl\(/, relative);
    assert.match(source, /fetchMediaBlob\(/, relative);
    assert.match(source, /OG_DOLL_IMAGE_DOWNLOAD_MAX_BYTES/, relative);
    assert.match(source, /redirect:\s*"error"/, relative);
    assert.match(source, /new ImageResponse\(/, relative);
  }
});
