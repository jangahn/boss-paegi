import assert from "node:assert/strict";
import test from "node:test";

import {
  loadDeploymentPublicPortoneEnvironment,
  main,
  parseProductionBackfillArgs,
  verifyProductionSupabaseTarget,
} from "../../scripts/qa/backfill-portone-order-evidence-production.mjs";

function responseWithUrl(
  body: string,
  url: string,
  init: ResponseInit = {},
) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("production backfill CLI is dry-run by default and accepts exact flags", () => {
  assert.deepEqual(parseProductionBackfillArgs([]), {
    ok: true,
    runtimeEnvFile: null,
    apply: false,
  });
  assert.deepEqual(
    parseProductionBackfillArgs([
      "--runtime-env-file",
      "/tmp/runtime.env",
      "--apply",
    ]),
    {
      ok: true,
      runtimeEnvFile: "/tmp/runtime.env",
      apply: true,
    },
  );
  for (const args of [
    ["--runtime-env-file"],
    ["--runtime-env-file", "--apply"],
    ["--runtime-env-file", "a", "--runtime-env-file", "b"],
    ["--apply", "--apply"],
    ["--unknown"],
  ]) {
    assert.equal(parseProductionBackfillArgs(args).ok, false);
  }
});

test("loader derives only the configured public PortOne subset from same-origin chunks", async () => {
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const result = await loadDeploymentPublicPortoneEnvironment({
    env: {
      NODE_ENV: "test",
      BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
      SUPABASE_SERVICE_ROLE_KEY: "secret-not-logged",
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, redirect: init?.redirect });
      if (url.endsWith("/credits")) {
        return responseWithUrl(
          [
            '<script src="/_next/static/chunks/a.js"></script>',
            '<script src="/_next/static/chunks/b.js"></script>',
          ].join(""),
          url,
        );
      }
      if (url.endsWith("/a.js")) {
        return responseWithUrl(
          'x={PORTONE_STORE_ID:"store-public",PORTONE_CHANNEL_KEY_CARD_TEST:"channel-test-card"}',
          url,
        );
      }
      return responseWithUrl("unrelated", url);
    },
  });

  assert.equal(result.ok, true);
  assert.equal("env" in result, true);
  if (!("env" in result) || !result.env) return;
  assert.equal(
    result.env.NEXT_PUBLIC_PORTONE_STORE_ID,
    "store-public",
  );
  assert.equal(
    result.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST,
    "channel-test-card",
  );
  assert.equal(
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD" in result.env,
    false,
  );
  assert.equal(result.env.SUPABASE_SERVICE_ROLE_KEY, "secret-not-logged");
  assert.deepEqual(
    requests.map(({ redirect }) => redirect),
    ["follow", "error", "error"],
  );
});

test("loader defaults to the canonical production origin", async () => {
  const requested: string[] = [];
  const result = await loadDeploymentPublicPortoneEnvironment({
    env: {
      NODE_ENV: "test",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    },
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/credits")) {
        return responseWithUrl(
          '<script src="/_next/static/chunks/a.js"></script>',
          url,
        );
      }
      return responseWithUrl(
        'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD_TEST:"channel-a"}',
        url,
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(requested[0], "https://boss-paegi.vercel.app/credits");
});

test("loader fails closed on missing, ambiguous, mismatched, or cross-origin deployment config", async () => {
  const run = (
    sources: string[],
    env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
    },
    scriptUrl = "https://boss-paegi.example/_next/static/chunks/a.js",
  ) =>
    loadDeploymentPublicPortoneEnvironment({
      env,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/credits")) {
          return responseWithUrl(
            sources
              .map(
                (_, index) =>
                  `<script src="/_next/static/chunks/${index}.js"></script>`,
              )
              .join(""),
            url,
          );
        }
        const index = Number.parseInt(
          url.match(/\/([0-9]+)\.js$/)?.[1] ?? "0",
          10,
        );
        return responseWithUrl(sources[index] ?? "", scriptUrl);
      },
    });

  assert.deepEqual(await run(["unrelated"]), {
    ok: false,
    reason: "deployment_public_value_missing",
  });
  assert.deepEqual(
    await run([
      'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD:"channel-a"}',
      'x={PORTONE_STORE_ID:"store-b",PORTONE_CHANNEL_KEY_CARD:"channel-a"}',
    ]),
    {
      ok: false,
      reason: "deployment_public_value_ambiguous",
    },
  );
  assert.deepEqual(
    await run(
      [
        'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD:"channel-a"}',
      ],
      {
        NODE_ENV: "test",
        BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
        NEXT_PUBLIC_PORTONE_STORE_ID: "store-other",
      },
    ),
    {
      ok: false,
      reason: "deployment_public_config_mismatch",
    },
  );
  assert.deepEqual(
    await run(
      [
        'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD:"channel-a"}',
      ],
      undefined,
      "https://attacker.example/_next/static/chunks/a.js",
    ),
    {
      ok: false,
      reason: "deployment_public_value_missing",
    },
  );

  assert.deepEqual(
    await loadDeploymentPublicPortoneEnvironment({
      env: {
        NODE_ENV: "test",
        BOSS_PAEGI_PRODUCTION_ORIGIN: "http://localhost:3000",
      },
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    {
      ok: false,
      reason: "production_site_url_invalid",
    },
  );
});

test("production wrapper reports only fixed reason codes when env loading fails", async () => {
  const logs: string[] = [];
  const exitCode = await main(
    ["--runtime-env-file", "/not/printed/runtime.env"],
    {
      logger: (line: string) => logs.push(line),
      loadEnvFile: () => {
        throw new Error("contains a secret");
      },
    },
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(logs, [
    "blocker reason=runtime_env_file_load_failed",
  ]);
});

test("production wrapper binds the runtime Supabase URL to the exact project ref", () => {
  const ref = "abcdefghijklmnopqrst";
  assert.deepEqual(
    verifyProductionSupabaseTarget({
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: ref,
      NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
    }),
    { ok: true },
  );

  for (const env of [
    {
      NODE_ENV: "test",
      NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
    },
    {
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: ref,
      NEXT_PUBLIC_SUPABASE_URL:
        "https://zzzzzzzzzzzzzzzzzzzz.supabase.co",
    },
    {
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: ref,
      NEXT_PUBLIC_SUPABASE_URL: `http://${ref}.supabase.co`,
    },
    {
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: ref,
      NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co/rest`,
    },
  ]) {
    assert.equal(verifyProductionSupabaseTarget(env).ok, false);
  }
});

test("production wrapper brackets config and backfill with one clean frozen source identity", async () => {
  const projectRef = "abcdefghijklmnopqrst";
  const commit = "abcdef0123456789abcdef0123456789abcdef01";
  const events: string[] = [];
  const probeOptions: Array<Record<string, unknown>> = [];
  let delegatedArgs: string[] | null = null;
  let delegatedEnv: Record<string, string | undefined> | null = null;

  const exitCode = await main(["--apply"], {
    env: {
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: projectRef,
      BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
      NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      PORTONE_V2_API_SECRET: "portone-secret",
    },
    readCanonicalSourceIdentity: () => {
      events.push("source");
      return {
        commit,
        sourceTree: "1111111111111111111111111111111111111111",
      };
    },
    verifyFrozenSurfaces: async (options: Record<string, unknown>) => {
      events.push("freeze");
      probeOptions.push(options);
      return true;
    },
    fetchImpl: async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/credits")) {
        events.push("page");
        return responseWithUrl(
          '<script src="/_next/static/chunks/a.js"></script>',
          url,
        );
      }
      events.push("chunk");
      return responseWithUrl(
        'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD_TEST:"channel-a"}',
        url,
      );
    },
    runBackfillMain: async (
      args: string[],
      env: Record<string, string | undefined>,
    ) => {
      events.push("backfill");
      delegatedArgs = args;
      delegatedEnv = env;
      return 0;
    },
    logger: () => {},
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    "source",
    "freeze",
    "page",
    "chunk",
    "freeze",
    "backfill",
    "freeze",
  ]);
  assert.deepEqual(delegatedArgs, ["--apply"]);
  assert.equal(
    (
      delegatedEnv as Record<string, string | undefined> | null
    )?.NEXT_PUBLIC_PORTONE_STORE_ID,
    "store-a",
  );
  assert.equal(probeOptions.length, 3);
  for (const options of probeOptions) {
    assert.equal(options.expectedProjectRef, projectRef);
    assert.deepEqual(options.allowedCommits, new Set([commit]));
  }
});

test("production wrapper never delegates when the deployment changes after config discovery", async () => {
  const projectRef = "abcdefghijklmnopqrst";
  const logs: string[] = [];
  let probe = 0;
  let delegated = false;
  const exitCode = await main([], {
    env: {
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: projectRef,
      BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
      NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
    },
    readCanonicalSourceIdentity: () => ({
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      sourceTree: "1111111111111111111111111111111111111111",
    }),
    verifyFrozenSurfaces: async () => {
      probe += 1;
      return probe === 1;
    },
    fetchImpl: async (input: unknown) => {
      const url = String(input);
      return url.endsWith("/credits")
        ? responseWithUrl(
            '<script src="/_next/static/chunks/a.js"></script>',
            url,
          )
        : responseWithUrl(
            'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD_TEST:"channel-a"}',
            url,
          );
    },
    runBackfillMain: async () => {
      delegated = true;
      return 0;
    },
    logger: (line: string) => logs.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(delegated, false);
  assert.equal(probe, 2);
  assert.equal(
    logs.at(-1),
    "blocker reason=production_deployment_not_frozen",
  );
});

test("a lost final frozen identity makes even a delegated success nonzero", async () => {
  const projectRef = "abcdefghijklmnopqrst";
  let probe = 0;
  let delegated = 0;
  const exitCode = await main(["--apply"], {
    env: {
      NODE_ENV: "test",
      BOSS_PAEGI_SUPABASE_PROJECT_REF: projectRef,
      BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
      NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
    },
    readCanonicalSourceIdentity: () => ({
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      sourceTree: "1111111111111111111111111111111111111111",
    }),
    verifyFrozenSurfaces: async () => {
      probe += 1;
      return probe < 3;
    },
    fetchImpl: async (input: unknown) => {
      const url = String(input);
      return url.endsWith("/credits")
        ? responseWithUrl(
            '<script src="/_next/static/chunks/a.js"></script>',
            url,
          )
        : responseWithUrl(
            'x={PORTONE_STORE_ID:"store-a",PORTONE_CHANNEL_KEY_CARD_TEST:"channel-a"}',
            url,
          );
    },
    runBackfillMain: async () => {
      delegated += 1;
      return 0;
    },
    logger: () => {},
  });

  assert.equal(exitCode, 1);
  assert.equal(delegated, 1);
  assert.equal(probe, 3);
});
