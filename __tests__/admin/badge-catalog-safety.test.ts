import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
}

test("badge impact is a complete service-only database aggregate", () => {
  const migration = source(
    "supabase/migrations/008899_server_read_surface_rollout_gate.sql",
  );
  assert.match(
    migration,
    /create or replace function public\.get_admin_badge_impact\(\)/,
  );
  assert.match(migration, /count\(distinct ub\.owner_id\)/);
  assert.match(migration, /count\(distinct ss\.score_id\)/);
  assert.match(migration, /unnest\(\s*coalesce\(ss\.badge_ids/);
  assert.match(
    migration,
    /revoke all on function public\.get_admin_badge_impact\(\)[\s\S]*?from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_admin_badge_impact\(\)[\s\S]*?to service_role;/,
  );
});

test("badge editor never converts a capped or failed authority read to zero impact", () => {
  const page = source("app/admin/content/badge_catalog/page.tsx");
  assert.match(page, /admin\.rpc\("get_admin_badge_impact"\)/);
  assert.match(page, /requireSupabaseRows\(/);
  assert.match(page, /validateAdminRows/);
  assert.doesNotMatch(page, /\.from\("user_badges"\)/);
  assert.doesNotMatch(page, /\.from\("score_stats"\)/);
  assert.doesNotMatch(page, /\bdata\s*\?\?\s*\[\]/);
});

test("persisted badge slugs are immutable while a new badge slug is editable", () => {
  const editor = source(
    "components/admin/content/BadgeCatalogEditor.tsx",
  );
  assert.match(
    editor,
    /initial\.badges\.map\([\s\S]*?slugLocked: true/,
  );
  assert.match(editor, /slugLocked: false/);
  assert.match(editor, /readOnly=\{b\.slugLocked\}/);
});
