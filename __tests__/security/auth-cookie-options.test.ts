import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { supabaseAuthCookieOptions } from "../../lib/supabase/auth-cookie-options.ts";

test("Supabase auth cookies are Secure on production/preview builds", () => {
  assert.deepEqual(supabaseAuthCookieOptions("production"), {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: true,
  });
});

test("local HTTP development remains usable without weakening production", () => {
  for (const nodeEnv of ["development", "test", undefined] as const) {
    assert.equal(supabaseAuthCookieOptions(nodeEnv).secure, false);
  }
});

test("browser, server, and proxy clients share the exact cookie policy", () => {
  for (const relativePath of [
    "lib/supabase/client.ts",
    "lib/supabase/server.ts",
    "lib/supabase/middleware.ts",
  ]) {
    const source = readFileSync(
      new URL(`../../${relativePath}`, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /cookieOptions:\s*supabaseAuthCookieOptions\(\)/,
      relativePath,
    );
  }
});
