import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import nextConfig from "../../next.config.ts";

const config = nextConfig;

test("the Next image optimizer has no multi-tenant remote fetch surface", () => {
  assert.deepEqual(config.images?.remotePatterns, []);
  assert.deepEqual(config.images?.localPatterns, [
    { pathname: "/logo.png", search: "" },
  ]);
  assert.deepEqual(config.images?.qualities, [75]);
  assert.equal(config.images?.maximumRedirects, 0);
  assert.notEqual(config.images?.dangerouslyAllowLocalIP, true);
  assert.notEqual(config.images?.dangerouslyAllowSVG, true);
});

test("runtime-configurable logos bypass the Vercel image optimizer", () => {
  for (const relativePath of ["app/page.tsx", "app/login/LoginForm.tsx"]) {
    const source = readFileSync(
      new URL(`../../${relativePath}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /src=\{logoUrl \?\? "\/logo\.png"\}/);
    assert.match(
      source,
      /src=\{logoUrl \?\? "\/logo\.png"\}[\s\S]{0,180}\bunoptimized\b/,
    );
  }
});
