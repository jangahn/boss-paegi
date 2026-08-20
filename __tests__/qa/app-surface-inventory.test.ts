import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
  type Dirent,
} from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_ROOT = join(REPO_ROOT, "app");
const API_ROOT = join(APP_ROOT, "api");

const EXPECTED_PAGES = [
  "/",
  "/account",
  "/account/credits",
  "/account/payments",
  "/admin",
  "/admin/acquisition",
  "/admin/analytics",
  "/admin/analytics/sessions",
  "/admin/analytics/sessions/[id]",
  "/admin/content",
  "/admin/content/badge_catalog",
  "/admin/content/business_info",
  "/admin/content/generation_config",
  "/admin/content/growth_levers",
  "/admin/content/history/[key]",
  "/admin/content/legal",
  "/admin/content/legal/[docType]",
  "/admin/content/marketing_copy",
  "/admin/content/media_config",
  "/admin/content/role_content",
  "/admin/content/score_config",
  "/admin/content/session_limits",
  "/admin/content/site_content",
  "/admin/events",
  "/admin/events/[id]",
  "/admin/generations",
  "/admin/generations/[id]",
  "/admin/integrity",
  "/admin/integrity/[scoreId]",
  "/admin/ledger",
  "/admin/moderation",
  "/admin/orders",
  "/admin/refunds",
  "/admin/reviewers",
  "/admin/users",
  "/admin/users/[id]",
  "/badges",
  "/auth/callback/continue",
  "/auth/flow-pending",
  "/auth/reconcile",
  "/consent",
  "/credits",
  "/credits/done",
  "/doll/[id]",
  "/faq",
  "/gallery",
  "/generate",
  "/history/[userId]",
  "/history/[userId]/[scoreId]",
  "/leaderboard",
  "/login",
  "/news",
  "/news/[id]",
  "/play",
  "/privacy",
  "/reconsent",
  "/share/[scoreId]",
  "/signup",
  "/terms",
] as const;

const EXPECTED_NON_API_ROUTE_HANDLERS = [
  "/auth/callback",
  "/auth/callback/bootstrap",
  "/llms.txt",
] as const;

const EXPECTED_APIS = [
  "/api/account/consent",
  "/api/account/delete",
  "/api/account/onboard",
  "/api/account/reconsent",
  "/api/admin/adjust",
  "/api/admin/cancel",
  "/api/admin/config",
  "/api/admin/event-image",
  "/api/admin/events",
  "/api/admin/generation-test/status",
  "/api/admin/generation-test/submit",
  "/api/admin/integrity/ban",
  "/api/admin/integrity/clear",
  "/api/admin/integrity/unban",
  "/api/admin/integrity/void",
  "/api/admin/legal",
  "/api/admin/moderation/dismiss",
  "/api/admin/moderation/permanent-delete",
  "/api/admin/moderation/restore",
  "/api/admin/moderation/takedown",
  "/api/admin/mutations/receipt",
  "/api/admin/reactivate",
  "/api/admin/refund-credits",
  "/api/admin/resolve-cancellation",
  "/api/admin/resolve-issue",
  "/api/admin/reviewers",
  "/api/admin/settle",
  "/api/admin/site-asset",
  "/api/auth/prepare-signup",
  "/api/auth/signout",
  "/api/auth/oauth-flow/abandon",
  "/api/auth/oauth-flow/bind-target",
  "/api/auth/oauth-flow/cancel",
  "/api/auth/oauth-flow/complete-signout",
  "/api/auth/oauth-flow/expire",
  "/api/auth/oauth-flow/finalize",
  "/api/auth/oauth-flow/preflight",
  "/api/auth/oauth-flow/release",
  "/api/auth/oauth-flow/revoke-bound-target",
  "/api/auth/oauth-flow/rotate-target",
  "/api/auth/oauth-flow/signout",
  "/api/auth/oauth-flow/status",
  "/api/avatar",
  "/api/config/public",
  "/api/doll",
  "/api/doll/signed-urls",
  "/api/events/active",
  "/api/fal",
  "/api/fal/face-webhook",
  "/api/fal/pick-webhook",
  "/api/fal/webhook",
  "/api/generations",
  "/api/highlight",
  "/api/leaderboard",
  "/api/ops/analytics-maintain",
  "/api/ops/content-maintain",
  "/api/ops/credit-expire",
  "/api/ops/gen-recover",
  "/api/ops/integrity-scan",
  "/api/ops/privacy-maintain",
  "/api/ops/reconcile",
  "/api/ops/telemetry-maintain",
  "/api/ops/warm",
  "/api/pay/checkout",
  "/api/pay/order-status",
  "/api/pay/webhook",
  "/api/report",
  "/api/score",
  "/api/telemetry",
  "/api/track",
] as const;

const EXPECTED_OAUTH_FLOW_APIS = [
  "/api/auth/oauth-flow/abandon",
  "/api/auth/oauth-flow/bind-target",
  "/api/auth/oauth-flow/cancel",
  "/api/auth/oauth-flow/complete-signout",
  "/api/auth/oauth-flow/expire",
  "/api/auth/oauth-flow/finalize",
  "/api/auth/oauth-flow/preflight",
  "/api/auth/oauth-flow/release",
  "/api/auth/oauth-flow/revoke-bound-target",
  "/api/auth/oauth-flow/rotate-target",
  "/api/auth/oauth-flow/signout",
  "/api/auth/oauth-flow/status",
] as const;

const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

function walkForLeaf(directory: string, leaf: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  }) as Dirent[]) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkForLeaf(absolute, leaf));
    } else if (entry.isFile() && entry.name === leaf) {
      found.push(absolute);
    }
  }
  return found;
}

function toRoute(
  absolute: string,
  root: string,
  leaf: "page.tsx" | "route.ts",
  prefix = "",
): string {
  const normalized = relative(root, absolute).split(sep).join("/");
  const directory =
    normalized === leaf
      ? ""
      : normalized.slice(0, -(leaf.length + 1));
  return directory ? `${prefix}/${directory}` : prefix || "/";
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

test("every page and API route is enrolled in the exact app surface manifest", () => {
  const pages = walkForLeaf(APP_ROOT, "page.tsx")
    .map((absolute) => toRoute(absolute, APP_ROOT, "page.tsx"))
    .sort();
  const apis = walkForLeaf(API_ROOT, "route.ts")
    .map((absolute) => toRoute(absolute, API_ROOT, "route.ts", "/api"))
    .sort();
  const nonApiRouteHandlers = walkForLeaf(
    APP_ROOT,
    "route.ts",
  )
    .filter(
      (absolute) =>
        !absolute.startsWith(`${API_ROOT}${sep}`),
    )
    .map((absolute) =>
      toRoute(absolute, APP_ROOT, "route.ts"),
    )
    .sort();

  assert.equal(pages.length, 59, "page count changed; update the exact manifest");
  assert.equal(apis.length, 70, "API count changed; update the exact manifest");
  assert.equal(
    nonApiRouteHandlers.length,
    3,
    "non-API route-handler count changed; update the exact manifest",
  );
  assert.deepEqual(pages, sorted(EXPECTED_PAGES));
  assert.deepEqual(apis, sorted(EXPECTED_APIS));
  assert.deepEqual(
    nonApiRouteHandlers,
    sorted(EXPECTED_NON_API_ROUTE_HANDLERS),
  );
  assert.deepEqual(
    apis.filter((route) =>
      route.startsWith("/api/auth/oauth-flow/"),
    ),
    sorted(EXPECTED_OAUTH_FLOW_APIS),
    "OAuth flow API security surface changed; update its exact manifest and rollout probes",
  );
  assert.equal(
    apis.filter((route) => route.startsWith("/api/ops/")).length,
    9,
    "ops route count changed; update cron contracts and scheduler inventory",
  );
});

test("every API route explicitly exports at least one supported HTTP method", () => {
  for (const absolute of walkForLeaf(API_ROOT, "route.ts")) {
    const route = toRoute(absolute, API_ROOT, "route.ts", "/api");
    const source = readFileSync(absolute, "utf8");
    const exported = HTTP_METHODS.filter((method) =>
      new RegExp(
        `^export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`,
        "m",
      ).test(source),
    );
    assert.ok(exported.length > 0, `${route} has no explicit HTTP method`);
    assert.doesNotMatch(
      source,
      /^export\s+default\b/m,
      `${route} must not hide an API handler behind a default export`,
    );
    for (const method of exported) {
      const occurrences =
        source.match(
          new RegExp(
            `^export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`,
            "gm",
          ),
        )?.length ?? 0;
      assert.equal(occurrences, 1, `${route} exports ${method} more than once`);
    }
  }
});

test("temporary local-QA credentials and payload artifacts are absent", () => {
  const forbiddenRepoArtifacts = [
    join(API_ROOT, "local-qa-session", "route.ts"),
    join(API_ROOT, "__local_qa_session", "route.ts"),
  ];
  for (const path of forbiddenRepoArtifacts) {
    assert.equal(existsSync(path), false, path);
  }
  assert.equal(existsSync("/tmp/mc-eval.txt"), false, "/tmp/mc-eval.txt");
  assert.equal(
    EXPECTED_APIS.some((route) => /(?:^|[/_-])local[/_-]?qa(?:[/_-]|$)/i.test(route)),
    false,
    "local QA endpoints must never enter the deployable route manifest",
  );
});
