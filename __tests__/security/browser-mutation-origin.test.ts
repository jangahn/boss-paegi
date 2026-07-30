import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  browserMutationOriginAllowed,
  isBrowserApiMutation,
} from "../../lib/browser-mutation-origin.ts";

const REQUEST_URL = "https://boss-paegi.vercel.app/api/account/delete";

function allowed(
  origin: string | null,
  fetchSite: string | null,
  requestUrl = REQUEST_URL,
  host: string | null = null,
): boolean {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
  if (host !== null) headers.set("host", host);
  return browserMutationOriginAllowed(requestUrl, headers);
}

test("only state-changing API methods enter the browser-origin gate", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.equal(isBrowserApiMutation("/api/example", method), true, method);
  }
  for (const method of ["GET", "HEAD", "OPTIONS", "TRACE", "CONNECT"]) {
    assert.equal(isBrowserApiMutation("/api/example", method), false, method);
  }
  for (const path of ["/api", "/apix/example", "/account/delete", "/"]) {
    assert.equal(isBrowserApiMutation(path, "POST"), false, path);
  }
});

test("exact same-origin browser mutations pass", () => {
  for (const origin of [
    "https://boss-paegi.vercel.app",
    "https://BOSS-PAEGI.VERCEL.APP",
  ]) {
    assert.equal(allowed(origin, "same-origin"), true, origin);
  }
  assert.equal(
    allowed(
      "https://preview.example:8443",
      "same-origin",
      "https://preview.example:8443/api/score",
    ),
    true,
  );
  assert.equal(
    allowed(
      "http://127.0.0.1:3911",
      "same-origin",
      "http://localhost:3911/api/score",
      "127.0.0.1:3911",
    ),
    true,
  );
});

test("scheme, host, port, sibling, opaque, and malformed origins fail closed", () => {
  for (const origin of [
    "http://boss-paegi.vercel.app",
    "https://boss-paegi.vercel.app:8443",
    "https://evil.example",
    "https://preview.boss-paegi.vercel.app",
    "null",
    "",
    "not a URL",
    "https://boss-paegi.vercel.app https://evil.example",
  ]) {
    assert.equal(allowed(origin, "cross-site"), false, origin);
    assert.equal(allowed(origin, "same-site"), false, origin);
  }
  assert.equal(
    allowed(
      "https://evil.example",
      "same-site",
      REQUEST_URL,
      "boss-paegi.vercel.app,evil.example",
    ),
    false,
  );
});

test("Fetch Metadata cannot downgrade a cross-site request", () => {
  assert.equal(
    allowed("https://boss-paegi.vercel.app", "cross-site"),
    false,
  );
  assert.equal(allowed(null, "cross-site"), false);
  assert.equal(allowed(null, "same-site"), false);
  assert.equal(allowed(null, "unknown-future-value"), false);

  for (const fetchSite of [null, "same-origin", "none", " SAME-ORIGIN "]) {
    assert.equal(allowed(null, fetchSite), true, String(fetchSite));
  }
});

test("proxy enforces the gate before session refresh while signed webhooks bypass it", () => {
  const proxy = readFileSync(
    new URL("../../proxy.ts", import.meta.url),
    "utf8",
  );
  const webhookBypass = proxy.indexOf("if (isWebhookPath(path))");
  const originGate = proxy.indexOf("isBrowserApiMutation(path");
  const sessionRefresh = proxy.indexOf("await updateSession(request)");
  assert.ok(webhookBypass >= 0);
  assert.ok(originGate > webhookBypass);
  assert.ok(sessionRefresh > originGate);
  assert.match(proxy, /error:\s*"forbidden_origin"/);
  assert.match(proxy, /status:\s*403/);
});
