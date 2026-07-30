import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  legalEdgeCacheIdentityAt,
  legalEdgeCacheUsable,
} from "../../lib/legal/edge-cache-policy.ts";

test("an edge legal cache entry can never survive KST activation midnight", () => {
  const before = Date.parse("2026-07-31T14:59:59.999Z");
  const midnight = Date.parse("2026-07-31T15:00:00.000Z");
  const identity = legalEdgeCacheIdentityAt(before);

  assert.deepEqual(identity, {
    kstDate: "2026-07-31",
    expiresAt: midnight,
  });
  assert.equal(legalEdgeCacheUsable(identity, before), true);
  assert.equal(legalEdgeCacheUsable(identity, midnight - 1), true);
  assert.equal(legalEdgeCacheUsable(identity, midnight), false);
  assert.equal(
    legalEdgeCacheUsable(
      { kstDate: "2026-07-31", expiresAt: midnight + 60_000 },
      midnight,
    ),
    false,
    "the KST civil date identity is a second independent boundary",
  );
});

test("ordinary cache entries keep the short TTL and validate inputs", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const identity = legalEdgeCacheIdentityAt(now, 60_000);
  assert.deepEqual(identity, {
    kstDate: "2026-07-30",
    expiresAt: now + 60_000,
  });
  assert.equal(legalEdgeCacheUsable(identity, now + 59_999), true);
  assert.equal(legalEdgeCacheUsable(identity, now + 60_000), false);
  assert.equal(legalEdgeCacheUsable(null, now), false);
  assert.equal(legalEdgeCacheUsable(identity, "invalid"), false);
  assert.throws(
    () => legalEdgeCacheIdentityAt("invalid"),
    /invalid_legal_edge_cache_input/,
  );
  assert.throws(
    () => legalEdgeCacheIdentityAt(now, 0),
    /invalid_legal_edge_cache_input/,
  );
});

test("public legal versions prohibit browser and CDN stale reuse", () => {
  const route = readFileSync(
    new URL("../../app/api/legal/versions/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(route, /"CDN-Cache-Control": "no-store"/);
  assert.match(route, /"Vercel-CDN-Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /stale-while-revalidate|max-age=60/);

  const edge = readFileSync(
    new URL("../../lib/legal/edge-versions.ts", import.meta.url),
    "utf8",
  );
  assert.match(edge, /legalEdgeCacheUsable\(cached, now\)/);
  assert.match(edge, /legalEdgeCacheIdentityAt\(Date\.now\(\)\)/);
  assert.match(edge, /\.eq\("doc_type", docType\)/);
  assert.match(edge, /\.limit\(1\)/);
});
