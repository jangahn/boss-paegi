import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GET as callbackShellGet,
} from "../../app/auth/callback/route.ts";
import {
  GET as callbackBootstrapGet,
} from "../../app/auth/callback/bootstrap/route.ts";

const SENTINEL = "QA_CALLBACK_CODE_SHOULD_NOT_APPEAR";

test("callback route HTML is byte-identical for every authorization query", async () => {
  const get = callbackShellGet as unknown as (
    request: Request,
  ) => Response;
  const clean = get(
    new Request("https://boss.example/auth/callback"),
  );
  const credentialed = get(
    new Request(
      "https://boss.example/auth/callback" +
        `?code=${SENTINEL}` +
        "&flow=11111111-1111-4111-8111-111111111111" +
        "&p=google&next=%2Fcredits",
    ),
  );
  const [cleanBody, credentialedBody] = await Promise.all([
    clean.text(),
    credentialed.text(),
  ]);
  assert.equal(credentialedBody, cleanBody);
  assert.equal(credentialedBody.includes(SENTINEL), false);
  assert.match(
    credentialed.headers.get("content-security-policy") ?? "",
    /default-src 'none'; script-src 'self'/u,
  );
  assert.equal(
    credentialed.headers.get("referrer-policy"),
    "no-referrer",
  );
  assert.equal(
    credentialed.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
});

test("bootstrap scrubs the query before a queryless Next request and uses no persistent storage", async () => {
  const response = callbackBootstrapGet();
  const source = await response.text();
  const capture = source.indexOf(
    "rawQuery = window.location.search",
  );
  const scrub = source.indexOf(
    "History.prototype.replaceState.call",
  );
  const navigate = source.indexOf(
    'window.location.replace("/auth/callback/continue" + fragment)',
  );
  assert.ok(capture >= 0);
  assert.ok(scrub > capture);
  assert.ok(navigate > scrub);
  assert.match(
    source,
    /"#oauth-callback=" \+ encodeURIComponent\(rawQuery\)/u,
  );
  assert.doesNotMatch(
    source,
    /sessionStorage|localStorage|document\.cookie/u,
  );
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
});

test("instrumentation consumes and scrubs only the callback fragment before observability", () => {
  const instrumentation = readFileSync(
    new URL("../../instrumentation-client.ts", import.meta.url),
    "utf8",
  );
  const callbackDetection = instrumentation.indexOf(
    'window.location.pathname.startsWith("/auth/callback/")',
  );
  const decode = instrumentation.indexOf(
    "callbackQuery = decodeURIComponent(",
  );
  const store = instrumentation.indexOf(
    "callbackGlobals[CALLBACK_BOOTSTRAP_QUERY_KEY] =",
  );
  const scrub = instrumentation.indexOf(
    "History.prototype.replaceState.call",
  );
  const sentry = instrumentation.indexOf("Sentry.init({");
  assert.ok(callbackDetection >= 0);
  assert.ok(decode > callbackDetection);
  assert.ok(store > decode);
  assert.ok(scrub > store);
  assert.ok(sentry > scrub);
  assert.match(
    instrumentation,
    /window\.location\.hash\.startsWith\("#oauth-callback="\)/u,
  );
  assert.doesNotMatch(
    instrumentation,
    /CALLBACK_BOOTSTRAP_QUERY_KEY\]\s*=\s*window\.location\.search/u,
  );
});
