import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { safeNext } from "../../lib/oauth-metadata.ts";

const APP_ORIGIN = "https://boss-paegi.example";
const BLOCKED_ROOTS = [
  "/auth",
  "/api",
  "/login",
  "/consent",
  "/signup",
  "/reconsent",
] as const;

function assertSafeDestination(input: string | null | undefined): void {
  const destination = safeNext(input);
  assert.match(destination, /^\/(?!\/)/, `single-slash destination: ${JSON.stringify(input)}`);

  const resolved = new URL(destination, APP_ORIGIN);
  assert.equal(
    resolved.origin,
    APP_ORIGIN,
    `same-origin destination: ${JSON.stringify(input)} -> ${destination}`,
  );
  assert.equal(
    resolved.pathname + resolved.search,
    destination,
    `destination must be stable after browser URL parsing: ${JSON.stringify(input)}`,
  );
  assert.equal(
    safeNext(destination),
    destination,
    `sanitization must be idempotent: ${JSON.stringify(input)} -> ${destination}`,
  );
  for (const root of BLOCKED_ROOTS) {
    assert.equal(
      resolved.pathname === root || resolved.pathname.startsWith(`${root}/`),
      false,
      `auth boundary cannot be a destination: ${JSON.stringify(input)} -> ${destination}`,
    );
  }
}

test("safeNext preserves canonical app destinations and removes fragments", () => {
  assert.equal(safeNext("/"), "/");
  assert.equal(safeNext("/gallery"), "/gallery");
  assert.equal(
    safeNext("/gallery?period=week&source=%2Fshare#ignored"),
    "/gallery?period=week&source=%2Fshare",
  );
  assert.equal(safeNext("/history/../gallery?x=1"), "/gallery?x=1");
  assert.equal(safeNext("/뉴스?q=%ED%85%8C%EC%8A%A4%ED%8A%B8"), "/%EB%89%B4%EC%8A%A4?q=%ED%85%8C%EC%8A%A4%ED%8A%B8");
});

test("safeNext blocks every auth/self-loop route boundary including trailing slash", () => {
  for (const root of BLOCKED_ROOTS) {
    for (const suffix of ["", "/", "//", "/child", "/child?next=%2Fgallery"]) {
      assert.equal(safeNext(`${root}${suffix}`), "/", `${root}${suffix}`);
    }
  }

  // Similar names are ordinary, case-sensitive application paths.
  assert.equal(safeNext("/login-help"), "/login-help");
  assert.equal(safeNext("/apiary"), "/apiary");
  assert.equal(safeNext("/authorization"), "/authorization");
});

test("dot-segment normalization cannot serialize an internal parse as protocol-relative", () => {
  const regressions = [
    "/..//evil.example",
    "/.//evil.example",
    "/%2e//evil.example",
    "/%2E//evil.example",
    "/.%2e//evil.example",
    "/%2e.//evil.example",
    "/%2e%2e//evil.example",
    "/safe/..//evil.example",
    "/safe/%2e%2e//evil.example",
    "/safe/../\\\\evil.example",
  ];
  for (const input of regressions) {
    assert.equal(safeNext(input), "/", input);
    assertSafeDestination(input);
  }
});

test("external, authority, backslash, control, malformed and encoded inputs stay internal", () => {
  const attacks = [
    null,
    undefined,
    "",
    " ",
    "gallery",
    "https://evil.example/path",
    "http:\\\\evil.example",
    "javascript:alert(1)",
    "data:text/html,attack",
    "//evil.example/path",
    "///evil.example/path",
    "/\\evil.example/path",
    "/\\\\evil.example/path",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\\@evil.example",
    "/%5cevil.example",
    "/%5c%5cevil.example",
    "/%2f%2fevil.example",
    "/%252f%252fevil.example",
    "/%00/evil.example",
    "/%09/evil.example",
    "/%0a/evil.example",
    "/%0d/evil.example",
    "/%",
    "/%0",
    "/%gg",
    "/\u0000",
    "/\ud800",
    "/／／evil.example",
  ];
  for (const input of attacks) assertSafeDestination(input);
});

test("finite redirect grammar exhaustively preserves the same-origin/idempotence invariants", () => {
  // All products of URL-normalization classes relevant to redirect authority:
  // dot segments (plain/encoded), slash forms, backslash forms, controls,
  // protected roots, encoded separators and ordinary segments.
  const atoms = [
    "",
    ".",
    "..",
    "%2e",
    "%2E",
    ".%2e",
    "%2e.",
    "%2e%2e",
    "safe",
    "evil.example",
    "login",
    "consent",
    "auth",
    "api",
    "%2f",
    "%2F",
    "%5c",
    "%5C",
    "\\",
    "%09",
    "%0a",
    "%0d",
  ] as const;
  const separators = ["/", "//", "/\\", "\\/"] as const;
  const tails = ["evil.example", "login", "consent", "safe"] as const;

  let cases = 0;
  for (const left of atoms) {
    for (const separator of separators) {
      for (const right of atoms) {
        assertSafeDestination(`/${left}${separator}${right}`);
        cases += 1;
      }
    }
  }
  for (const left of atoms) {
    for (const firstSeparator of separators) {
      for (const middle of atoms) {
        for (const secondSeparator of separators) {
          for (const tail of tails) {
            assertSafeDestination(
              `/${left}${firstSeparator}${middle}${secondSeparator}${tail}`,
            );
            cases += 1;
          }
        }
      }
    }
  }

  // Every percent-encoded byte in path/query positions is part of the model.
  for (let byte = 0; byte <= 0xff; byte += 1) {
    const encoded = `%${byte.toString(16).padStart(2, "0")}`;
    assertSafeDestination(`/safe${encoded}/path?q=${encoded}`);
    cases += 1;
  }
  assert.equal(cases, 33_168);
});

test("every user-controlled auth next surface uses the shared sanitizer before navigation", () => {
  const source = (path: string) =>
    readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  assert.match(
    source("proxy.ts"),
    /redirectNoCookie\(\s*request,\s*safeNext\(request\.nextUrl\.searchParams\.get\("next"\)\)\s*\)/,
  );
  assert.match(
    source("app/auth/callback/OAuthCallbackClient.tsx"),
    /next: safeNext\(single\("next"\)\)/,
  );
  assert.match(
    source("app/consent/page.tsx"),
    /const dest = safeNext\(next\)/,
  );
  assert.match(
    source("app/login/LoginForm.tsx"),
    /const next = safeNext\(params\.get\("next"\)\)/,
  );
  assert.match(
    source("lib/auth-oauth.ts"),
    /const next = safeNext\(opts\?\.next\)/,
  );
  // /signup·/reconsent 리다이렉트 stub 은 v1.10 에서 제거됐다(동의 화면 일원화 후 잔재).
  // 라우트가 없으므로 sanitizer 검사 대상도 아니다 — 대신 부활하지 않았는지 확인한다.
  for (const gone of ["app/signup/page.tsx", "app/reconsent/page.tsx"]) {
    assert.equal(existsSync(new URL(`../../${gone}`, import.meta.url)), false, gone);
  }
});

test("member-only login redirects preserve safe payment and generation resume queries", () => {
  assert.equal(
    safeNext(
      "/credits/done?order=11111111-1111-4111-8111-111111111111",
    ),
    "/credits/done?order=11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    safeNext(
      "/generate?resume=22222222-2222-4222-8222-222222222222",
    ),
    "/generate?resume=22222222-2222-4222-8222-222222222222",
  );
  const proxy = readFileSync(
    new URL("../../proxy.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    proxy,
    /const next = safeNext\(path \+ request\.nextUrl\.search\)/,
  );
  assert.match(proxy, /`\/login\?next=\$\{encodeURIComponent\(next\)\}`/);
});
