import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADMIN_ROOT = join(REPO_ROOT, "app/admin");

function adminPages(dir = ADMIN_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return adminPages(path);
    return entry.isFile() && entry.name === "page.tsx" ? [path] : [];
  });
}

function withoutComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("every admin page authorizes before any asynchronous or service-role read", () => {
  const pages = adminPages().sort();
  assert.ok(pages.length > 0);

  for (const path of pages) {
    const label = relative(REPO_ROOT, path);
    const body = readFileSync(path, "utf8");
    const handler = body.indexOf("export default");
    const gate = body.indexOf("await requireAdmin()", handler);
    const firstAwait = body.indexOf("await ", handler);
    const denial = body.indexOf("if (!gate.ok)", gate);
    const nextAwait = body.indexOf(
      "await ",
      gate + "await requireAdmin()".length,
    );
    const adminClient = body.indexOf("createAdminClient()", handler);
    const pageBody = body.lastIndexOf("{", gate);

    assert.ok(handler >= 0, `${label} must retain a default page component`);
    assert.match(
      body,
      /import\s*\{[^}]*\brequireAdmin\b[^}]*\}\s*from\s*"@\/lib\/auth-server"/,
      `${label} must import the exact admin gate`,
    );
    assert.ok(gate > handler, `${label} must call requireAdmin in the page`);
    assert.ok(pageBody > handler, `${label} must retain a page function body`);
    assert.equal(
      withoutComments(body.slice(pageBody + 1, gate)).trim(),
      "const gate =",
      `${label} must make requireAdmin its first executable statement`,
    );
    assert.equal(
      firstAwait,
      gate,
      `${label} must authorize before its first asynchronous operation`,
    );
    assert.ok(
      denial > gate,
      `${label} must stop rendering when requireAdmin fails`,
    );
    assert.equal(
      withoutComments(
        body.slice(gate + "await requireAdmin()".length, denial),
      ).trim(),
      ";",
      `${label} must handle a failed gate before any other statement`,
    );
    if (nextAwait >= 0) {
      assert.ok(
        denial < nextAwait,
        `${label} must handle denial before its next asynchronous read`,
      );
    }
    if (adminClient >= 0) {
      assert.ok(
        denial < adminClient,
        `${label} must handle denial before constructing a service-role client`,
      );
    }
  }
});

test("layout and page gates share one render-pass admin authority read", () => {
  const auth = readFileSync(join(REPO_ROOT, "lib/auth-server.ts"), "utf8");
  const layout = readFileSync(join(ADMIN_ROOT, "layout.tsx"), "utf8");

  assert.match(auth, /import\s*\{\s*cache\s*\}\s*from\s*"react"/);
  assert.match(
    auth,
    /export const requireAdmin = cache\(async \(\): Promise<RequireMemberResult> => \{/,
  );
  assert.match(layout, /await requireAdmin\(\)/);
});
