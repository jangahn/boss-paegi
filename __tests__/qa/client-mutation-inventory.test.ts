import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Strategy =
  | "exact_replay"
  | "durable_recovery"
  | "poll_recovery"
  | "bounded_best_effort"
  | "mixed_exact_and_durable";

type Surface = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  endpoint: string;
  source: string;
  helper: string;
  strategy: Strategy;
};

const CLIENT_MUTATION_SURFACES: readonly Surface[] = [
  { method: "POST", endpoint: "/api/auth/prepare-signup", source: "lib/auth-oauth.ts", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/auth/signout", source: "lib/auth-oauth.ts", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/account/consent", source: "app/consent/ConsentForm.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/account/delete", source: "app/account/page.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/report", source: "components/ReportDialog.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/pay/checkout", source: "app/credits/CreditsClient.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "GET", endpoint: "/api/pay/order-status", source: "lib/pay/client-order-status-poll.ts", helper: "readBoundedClientJsonResponse", strategy: "poll_recovery" },
  { method: "POST", endpoint: "/api/score", source: "lib/score-outbox.ts", helper: "runBoundedClientJsonFetch", strategy: "durable_recovery" },
  { method: "POST", endpoint: "/api/fal", source: "app/generate/page.tsx", helper: "runBoundedClientJsonFetch", strategy: "durable_recovery" },
  { method: "GET", endpoint: "/api/generations", source: "lib/generation-poll.ts", helper: "runBoundedClientJsonFetch", strategy: "poll_recovery" },
  { method: "POST", endpoint: "/api/doll", source: "app/generate/page.tsx", helper: "runBoundedClientJsonFetch", strategy: "durable_recovery" },
  { method: "PATCH", endpoint: "/api/doll", source: "components/gallery/DollCard.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "DELETE", endpoint: "/api/doll", source: "app/gallery/page.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/avatar", source: "lib/avatar.ts", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "PATCH", endpoint: "/api/avatar", source: "lib/avatar.ts", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "DELETE", endpoint: "/api/avatar", source: "lib/avatar.ts", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/highlight", source: "lib/share.ts", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "PATCH", endpoint: "/api/highlight", source: "lib/share.ts", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/telemetry", source: "lib/telemetry/transport.ts", helper: "runBoundedClientJsonFetch", strategy: "bounded_best_effort" },
  { method: "POST", endpoint: "/api/track", source: "lib/acquisition.ts", helper: "AbortController", strategy: "bounded_best_effort" },
  { method: "POST", endpoint: "/api/admin/config", source: "lib/admin-config-client.ts", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/legal", source: "components/admin/content/LegalDocEditor.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/events", source: "components/admin/EventEditor.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  // 테스트 벤치 제출 = fal 실비 유발이나 세션 일회성·무원장(재시도/복구 없음 — 단일 시도 바운드).
  { method: "POST", endpoint: "/api/admin/generation-test/submit", source: "components/admin/content/generation/GenerationTestBench.tsx", helper: "runBoundedClientJsonFetch", strategy: "bounded_best_effort" },
  { method: "POST", endpoint: "/api/admin/event-image", source: "components/admin/EventEditor.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "PATCH", endpoint: "/api/admin/event-image", source: "components/admin/EventEditor.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/site-asset", source: "components/admin/content/MediaConfigEditor.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "PATCH", endpoint: "/api/admin/site-asset", source: "components/admin/content/MediaConfigEditor.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/integrity/ban", source: "components/admin/IntegrityActions.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/integrity/clear", source: "components/admin/IntegrityActions.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/integrity/unban", source: "components/admin/IntegrityActions.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/integrity/void", source: "components/admin/IntegrityActions.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/moderation/dismiss", source: "components/admin/ModerationQueueTable.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/moderation/permanent-delete", source: "components/admin/ModerationQueueTable.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/moderation/restore", source: "components/admin/ModerationQueueTable.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/moderation/takedown", source: "components/admin/ModerationQueueTable.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/reviewers", source: "components/admin/ReviewerAccountsPanel.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "PATCH", endpoint: "/api/admin/reviewers", source: "components/admin/ReviewerAccountsPanel.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "DELETE", endpoint: "/api/admin/reviewers", source: "components/admin/ReviewerAccountsPanel.tsx", helper: "runClientMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/reactivate", source: "components/admin/ReactivateAccountForm.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/adjust", source: "lib/admin-credit-adjust.ts", helper: "runBoundedClientJsonFetch", strategy: "durable_recovery" },
  { method: "POST", endpoint: "/api/admin/cancel", source: "lib/admin-cancel-intent.ts", helper: "runBoundedClientJsonFetch", strategy: "durable_recovery" },
  { method: "POST", endpoint: "/api/admin/refund-credits", source: "lib/admin-refund-intent.ts", helper: "runBoundedClientJsonFetch", strategy: "mixed_exact_and_durable" },
  { method: "POST", endpoint: "/api/admin/resolve-cancellation", source: "components/admin/RefundQueueActions.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/resolve-issue", source: "components/admin/RefundQueueActions.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
  { method: "POST", endpoint: "/api/admin/settle", source: "components/admin/StalePendingTable.tsx", helper: "runReplayedJsonMutation", strategy: "exact_replay" },
] as const;

const DOMAIN_READ_ONLY_POSTS = [
  {
    method: "POST",
    endpoint: "/api/doll/signed-urls",
    source: "app/play/useGameInit.ts",
  },
  {
    method: "POST",
    endpoint: "/api/admin/mutations/receipt",
    source: "components/admin/EventEditor.tsx",
  },
  {
    method: "POST",
    endpoint: "/api/account/onboard",
    source: "app/api/account/onboard/route.ts",
  },
  {
    // fal queue status/result 프록시(읽기 전용 폴링) — 도메인 상태 무변경.
    method: "POST",
    endpoint: "/api/admin/generation-test/status",
    source: "components/admin/content/generation/GenerationTestBench.tsx",
  },
] as const;

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function routeSource(endpoint: string): string {
  return `app/api/${endpoint.slice("/api/".length)}/route.ts`;
}

function key(surface: Pick<Surface, "method" | "endpoint">): string {
  return `${surface.method} ${surface.endpoint}`;
}

test("all 46 current first-party client-triggered domain mutations are explicit", () => {
  assert.equal(
    CLIENT_MUTATION_SURFACES.length,
    46,
    "mutation count changed; classify the new/removed edge explicitly",
  );
  const unique = new Set(CLIENT_MUTATION_SURFACES.map(key));
  assert.equal(unique.size, CLIENT_MUTATION_SURFACES.length);

  for (const surface of CLIENT_MUTATION_SURFACES) {
    const client = read(surface.source);
    assert.ok(
      client.includes(surface.endpoint),
      `${key(surface)} is absent from ${surface.source}`,
    );
    assert.ok(
      client.includes(surface.helper),
      `${key(surface)} lost ${surface.helper}`,
    );

    const routePath = routeSource(surface.endpoint);
    const route = read(routePath);
    assert.match(
      route,
      new RegExp(
        `^export\\s+(?:async\\s+)?(?:function|const)\\s+${surface.method}\\b`,
        "m",
      ),
      `${key(surface)} is not exported by ${routePath}`,
    );
  }
});

test("side-effecting GET recovery edges cannot be misclassified as reads", () => {
  const keys = new Set(CLIENT_MUTATION_SURFACES.map(key));
  assert.equal(keys.has("GET /api/generations"), true);
  assert.equal(keys.has("GET /api/pay/order-status"), true);
  assert.match(
    read("app/api/generations/route.ts"),
    /expire_generation|failGeneration|recoverQueuedGeneration/,
  );
  assert.match(
    read("app/api/pay/order-status/route.ts"),
    /mark_paid_and_grant|handleObservedCancellation|mark_order_failed/,
  );
});

test("domain-read-only POST exclusions are exact and never overlap mutations", () => {
  const mutationKeys = new Set(CLIENT_MUTATION_SURFACES.map(key));
  assert.equal(DOMAIN_READ_ONLY_POSTS.length, 4);
  for (const exclusion of DOMAIN_READ_ONLY_POSTS) {
    assert.equal(mutationKeys.has(key(exclusion)), false, key(exclusion));
    const body = read(exclusion.source);
    if (exclusion.source.startsWith("app/api/")) {
      assert.match(body, /^export async function POST\b/m, exclusion.source);
    } else {
      assert.ok(body.includes(exclusion.endpoint), exclusion.source);
    }
  }
  assert.match(read("app/api/account/onboard/route.ts"), /status: 410/);
  // /api/account/reconsent 410 shim 은 v1.10 에서 제거(동의 일원화 후 호출처 0) — 부활 금지.
  assert.equal(existsSync(new URL("../../app/api/account/reconsent/route.ts", import.meta.url)), false);
});

function walk(directory: string, skipApi: boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  }) as Dirent[]) {
    if (
      entry.isDirectory() &&
      ((skipApi && entry.name === "api") || entry.name === "auth")
    ) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, false));
    if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      files.push(absolute);
    }
  }
  return files;
}

test("browser code has zero unbounded direct response.json body reads", () => {
  const files = [
    ...walk(join(REPO_ROOT, "app"), true),
    ...walk(join(REPO_ROOT, "components"), false),
    ...walk(join(REPO_ROOT, "lib"), false),
  ];
  const violations = files
    .filter((file) => /\.json\s*\(\s*\)/.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
  assert.deepEqual(violations, []);
});
