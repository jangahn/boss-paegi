import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  API_NO_STORE_HEADERS,
  GLOBAL_SECURITY_HEADERS,
} from "../../lib/security-headers.ts";

const values = new Map(
  GLOBAL_SECURITY_HEADERS.map(({ key, value }) => [key.toLowerCase(), value]),
);

test("global security headers are unique and enforce the compatible baseline", () => {
  assert.equal(values.size, GLOBAL_SECURITY_HEADERS.length);
  assert.equal(values.get("x-content-type-options"), "nosniff");
  assert.equal(values.get("x-frame-options"), "DENY");
  assert.equal(
    values.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  assert.equal(
    values.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains; preload",
  );
  assert.equal(
    values.get("permissions-policy"),
    "camera=(self), microphone=(), geolocation=(), browsing-topics=()",
  );

  const csp = values.get("content-security-policy") ?? "";
  const directives = new Set(
    csp.split(";").map((directive) => directive.trim()),
  );
  assert.deepEqual(
    directives,
    new Set([
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]),
  );
});

test("Next applies the baseline to every response and hides its framework header", () => {
  const source = readFileSync(
    new URL("../../next.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /poweredByHeader:\s*false/);
  assert.match(
    source,
    /source:\s*"\/\(\.\*\)"[\s\S]*headers:\s*\[\.\.\.GLOBAL_SECURITY_HEADERS\]/,
  );
  assert.match(
    source,
    /source:\s*"\/api\/:path\*"[\s\S]*headers:\s*\[\.\.\.API_NO_STORE_HEADERS\]/,
  );
});

test("every API response is browser/CDN no-store by default", () => {
  assert.deepEqual(API_NO_STORE_HEADERS, [
    {
      key: "Cache-Control",
      value: "private, no-store, max-age=0",
    },
  ]);
});

test("scheduled public events are not stale in browser or edge caches", () => {
  const source = readFileSync(
    new URL("../../app/api/events/active/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /"Cache-Control":\s*"no-store"/);
  assert.match(
    source,
    /"Vercel-CDN-Cache-Control":\s*\n?\s*"no-store"/,
  );
  assert.doesNotMatch(source, /stale-while-revalidate/);
  assert.doesNotMatch(source, /"Cache-Control":\s*"public/);
});
