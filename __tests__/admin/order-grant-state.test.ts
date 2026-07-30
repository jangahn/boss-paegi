import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
}

test("every admin order read preserves the paid no-grant marker", () => {
  const listRead = source("lib/admin-orders.ts");
  const dashboardRead = source("lib/admin-data.ts");
  const userRead = source("lib/admin-users.ts");

  assert.match(
    listRead,
    /\.select\(\s*"order_uuid, refunded_credits, refunded_amount, error_message"/,
  );
  assert.match(
    listRead,
    /error_message: "nullableString"[\s\S]*requireExactAdminIdCoverage/,
  );
  assert.match(
    listRead,
    /error_message: financial\.error_message/,
  );
  assert.match(
    dashboardRead,
    /const ORDER_SELECT =[\s\S]*paid_at, error_message, user_id/,
  );
  assert.match(
    dashboardRead,
    /profiles:profiles!orders_user_id_fkey\(display_name\)/,
    "orders has multiple profile foreign keys; dashboard reads must pin the purchaser relationship",
  );
  assert.match(
    dashboardRead,
    /const WARN_SELECT =[\s\S]*paid_at, error_message, user_id/,
  );
  assert.match(
    userRead,
    /\.from\("orders"\)[\s\S]*paid_at, error_message, user_id/,
  );
});

test("admin order rows render quarantined PAID as zero grant for every marker", () => {
  const table = source("components/admin/OrdersTable.tsx");
  assert.match(
    table,
    /r\.status === "paid" && r\.error_message !== null/,
  );
  assert.match(table, /paidReview \? "paid_review" : r\.status/);
  assert.match(table, /지급 0 · 요청 \{r\.credits\}/);
  assert.doesNotMatch(
    table,
    /paidReview[\s\S]{0,250}STATUS_COLOR\[displayedStatus\]/,
  );
});
