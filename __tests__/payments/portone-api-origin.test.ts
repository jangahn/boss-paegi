import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTONE_API_ORIGIN,
  resolvePortoneApiBaseUrl,
} from "../../lib/pay/portone-api-origin.ts";

test("PortOne API defaults to and accepts only the exact production origin", () => {
  assert.equal(resolvePortoneApiBaseUrl({}), PORTONE_API_ORIGIN);
  assert.equal(
    resolvePortoneApiBaseUrl({
      NODE_ENV: "production",
      PORTONE_API_BASE_URL: PORTONE_API_ORIGIN,
    }),
    PORTONE_API_ORIGIN,
  );

  for (const configured of [
    "https://api.portone.io/",
    "https://API.PORTONE.IO",
    "https://api.portone.io:443",
    "https://api.portone.io/payments",
    "http://api.portone.io",
    " https://api.portone.io",
  ]) {
    assert.throws(
      () =>
        resolvePortoneApiBaseUrl({
          NODE_ENV: "production",
          PORTONE_API_BASE_URL: configured,
        }),
      /invalid_production_portone_api_origin/,
      configured,
    );
  }
});

test("non-production PortOne overrides are limited to normalized loopback HTTP stubs", () => {
  for (const [configured, expected] of [
    ["http://127.0.0.1:4100", "http://127.0.0.1:4100"],
    ["http://localhost:65535/", "http://localhost:65535"],
    ["http://[::1]:8080", "http://[::1]:8080"],
  ] as const) {
    assert.equal(
      resolvePortoneApiBaseUrl({
        NODE_ENV: "test",
        PORTONE_API_BASE_URL: configured,
      }),
      expected,
    );
  }
});

test("PortOne secret-bearing requests reject every non-loopback override class", () => {
  for (const configured of [
    "https://example.com",
    "http://example.com",
    "https://localhost:4100",
    "http://127.0.0.1:4100/payments",
    "http://127.0.0.1:4100?target=other",
    "http://127.0.0.1:4100#fragment",
    "http://user:password@127.0.0.1:4100",
    "file:///tmp/portone",
    "javascript:alert(1)",
    "not-a-url",
    "",
  ]) {
    assert.throws(
      () =>
        resolvePortoneApiBaseUrl({
          NODE_ENV: "test",
          PORTONE_API_BASE_URL: configured,
        }),
      /invalid_portone_api_origin/,
      configured,
    );
  }
});

test("production never enables the loopback PortOne test escape hatch", () => {
  assert.throws(
    () =>
      resolvePortoneApiBaseUrl({
        NODE_ENV: "production",
        PORTONE_API_BASE_URL: "http://127.0.0.1:4100",
      }),
    /invalid_production_portone_api_origin/,
  );
});
