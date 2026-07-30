import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function indices(haystack: string, needle: string): number[] {
  const values: number[] = [];
  let offset = 0;
  for (;;) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return values;
    values.push(index);
    offset = index + needle.length;
  }
}

function assertReadersAuthorized(
  body: string,
  authorityNeedle: string,
  readerNeedle: string,
  count: number,
): void {
  const readers = indices(body, readerNeedle);
  assert.equal(readers.length, count, readerNeedle);
  for (const reader of readers) {
    const handler = body.lastIndexOf("export async function", reader);
    const authority = body.lastIndexOf(authorityNeedle, reader);
    assert.ok(
      handler >= 0 && handler < authority && authority < reader,
      `${authorityNeedle} must precede each body read in the same handler`,
    );
  }
}

test("all owned member/public JSON routes use the bounded object reader", () => {
  const routes = new Map<string, number>([
    ["app/api/avatar/route.ts", 2],
    ["app/api/doll/route.ts", 2],
    ["app/api/highlight/route.ts", 2],
    ["app/api/pay/checkout/route.ts", 1],
    ["app/api/account/consent/route.ts", 1],
    ["app/api/doll/signed-urls/route.ts", 1],
  ]);

  let totalReaders = 0;
  for (const [path, expectedReaders] of routes) {
    const body = source(path);
    assert.doesNotMatch(body, /\breq\.json\s*\(/, path);
    assert.match(
      body,
      /import \{ readApiJsonObjectRequest \} from "@\/lib\/http\/api-json-request";/,
      path,
    );
    const readers = indices(body, "readApiJsonObjectRequest(req)");
    assert.equal(readers.length, expectedReaders, path);
    totalReaders += readers.length;
  }
  assert.equal(totalReaders, 9);
});

test("authentication/authorization and public rate-limit ordering is unchanged", () => {
  const avatar = source("app/api/avatar/route.ts");
  assertReadersAuthorized(
    avatar,
    "const gate = await requireMember();",
    "await readApiJsonObjectRequest(req)",
    2,
  );

  const doll = source("app/api/doll/route.ts");
  assertReadersAuthorized(
    doll,
    "const gate = await requireMember();",
    "await readApiJsonObjectRequest(req)",
    2,
  );

  const highlight = source("app/api/highlight/route.ts");
  assertReadersAuthorized(
    highlight,
    "const gate = await requireActiveUser();",
    "await readApiJsonObjectRequest(req)",
    2,
  );

  const checkout = source("app/api/pay/checkout/route.ts");
  const configured = checkout.indexOf("if (!portoneConfigured())");
  const gate = checkout.indexOf(
    "gate = await waitForCheckoutDependency(",
  );
  const limiter = checkout.indexOf("if (!rateLimit(`pay-checkout:");
  const checkoutRead = checkout.indexOf("readApiJsonObjectRequest(req)");
  assert.ok(
    configured >= 0 &&
      configured < gate &&
      gate < limiter &&
      limiter < checkoutRead,
  );

  const consent = source("app/api/account/consent/route.ts");
  assert.ok(
    consent.indexOf("const gate = await requireAuthedNonDeleted();") <
      consent.indexOf("await readApiJsonObjectRequest(req)"),
  );

  const signedUrls = source("app/api/doll/signed-urls/route.ts");
  assert.ok(
    signedUrls.indexOf("await readApiJsonObjectRequest(req)") <
      signedUrls.indexOf('"consume_doll_signed_url_quota"'),
  );
  assert.ok(
    signedUrls.indexOf('"consume_doll_signed_url_quota"') <
      signedUrls.indexOf('.from("dolls")'),
  );
  assert.match(
    signedUrls,
    /publicWriteNetworkActorKey\(req\.headers\)/,
  );
  assert.doesNotMatch(signedUrls, /x-forwarded-for|signurls:ip:|rateLimit\(/);
});

function countJsonFetches(path: string, endpoint: string): number {
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `(?:fetch\\(|input:\\s*)["']${escaped}["'][\\s\\S]{0,500}?headers:\\s*\\{\\s*"Content-Type":\\s*"application/json"\\s*\\}`,
    "g",
  );
  return [...source(path).matchAll(expression)].length;
}

test("all current browser callers already send application/json", () => {
  assert.equal(countJsonFetches("lib/avatar.ts", "/api/avatar"), 2);
  assert.equal(countJsonFetches("app/generate/page.tsx", "/api/doll"), 1);
  assert.equal(countJsonFetches("components/gallery/DollCard.tsx", "/api/doll"), 1);
  assert.equal(
    countJsonFetches("app/play/useGameInit.ts", "/api/doll/signed-urls"),
    1,
  );
  assert.equal(
    countJsonFetches("app/gallery/page.tsx", "/api/doll/signed-urls"),
    1,
  );
  assert.match(
    source("app/play/useGameInit.ts"),
    /runBoundedClientJsonFetch/,
  );
  assert.match(
    source("app/gallery/page.tsx"),
    /runBoundedClientJsonFetch/,
  );
  assert.equal(countJsonFetches("lib/share.ts", "/api/highlight"), 3);
  assert.equal(
    countJsonFetches("app/credits/CreditsClient.tsx", "/api/pay/checkout"),
    1,
  );
  assert.equal(
    countJsonFetches("app/consent/ConsentForm.tsx", "/api/account/consent"),
    1,
  );
});
