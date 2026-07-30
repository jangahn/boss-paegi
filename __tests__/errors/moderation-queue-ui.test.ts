import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("moderation queue distinguishes exact totals from the latest-100 preview", () => {
  const table = readFileSync(
    new URL(
      "../../components/admin/ModerationQueueTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(table, /row\.reports_truncated/);
  assert.match(table, /최근 100건만 표시 · 전체/);
  assert.match(table, /row\.report_count\.toLocaleString\(\)/);
  assert.match(table, /aria-expanded=\{open\}/);
  assert.match(table, /aria-controls=\{reportListId\}/);
  assert.match(table, /id=\{reportListId\}/);
  assert.match(table, /aria-label="신고 상세"/);
});
