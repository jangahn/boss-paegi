import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/0074_score_submission_integrity.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(name: string): string {
  const start = migration.indexOf(
    `create or replace function public.${name}(`,
  );
  assert.ok(start >= 0, `${name} definition missing`);
  const end = migration.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} definition terminator missing`);
  return migration.slice(start, end);
}

test("member ban never materializes an unbounded score UUID array", () => {
  const body = functionBody("admin_ban_member");
  assert.doesNotMatch(body, /v_score_ids|array_agg|=\s*any\s*\(/i);
  assert.match(
    body,
    /update public\.scores[\s\S]*?owner_id = p_member_id[\s\S]*?review_status <> 'voided';\s*get diagnostics v_scores = row_count;/,
  );
  assert.match(
    body,
    /insert into public\.score_flags[\s\S]*?from public\.scores s\s*where s\.owner_id = p_member_id\s*and s\.review_status = 'voided'/,
  );
});
