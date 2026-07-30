#!/usr/bin/env node

import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import {
  main as runBackfillMain,
  safeWireText,
} from "./backfill-portone-order-evidence.mjs";
import {
  readCanonicalSourceIdentity,
  verifyFrozenSurfaces,
} from "./apply-production-rollout.mjs";

const DEFAULT_PRODUCTION_ORIGIN = "https://boss-paegi.vercel.app";

/** @typedef {Record<string, string | undefined>} RuntimeEnvironment */

const PUBLIC_FIELDS = Object.freeze([
  ["NEXT_PUBLIC_PORTONE_STORE_ID", "PORTONE_STORE_ID"],
  [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD",
    "PORTONE_CHANNEL_KEY_CARD",
  ],
  [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY",
    "PORTONE_CHANNEL_KEY_TOSSPAY",
  ],
  [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY",
    "PORTONE_CHANNEL_KEY_KAKAOPAY",
  ],
  [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST",
    "PORTONE_CHANNEL_KEY_CARD_TEST",
  ],
  [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST",
    "PORTONE_CHANNEL_KEY_TOSSPAY_TEST",
  ],
  [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST",
    "PORTONE_CHANNEL_KEY_KAKAOPAY_TEST",
  ],
]);

function publicOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** @param {RuntimeEnvironment} env */
export function verifyProductionSupabaseTarget(env = process.env) {
  const projectRef = env.BOSS_PAEGI_SUPABASE_PROJECT_REF;
  if (
    typeof projectRef !== "string" ||
    !/^[a-z0-9]{20}$/.test(projectRef)
  ) {
    return { ok: false, reason: "production_project_ref_invalid" };
  }
  const value = env.NEXT_PUBLIC_SUPABASE_URL;
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "production_supabase_url_mismatch" };
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== `${projectRef}.supabase.co` ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return { ok: false, reason: "production_supabase_url_mismatch" };
    }
  } catch {
    return { ok: false, reason: "production_supabase_url_mismatch" };
  }
  return { ok: true };
}

/**
 * @returns {Promise<
 *   {ok: true, value: string} | {ok: false, reason: string}
 * >}
 */
async function readBoundedText(response, maxBytes) {
  if (!response?.body || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { ok: false, reason: "deployment_body_invalid" };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        try {
          await reader.cancel();
        } catch {
          // The response is already unusable.
        }
        return { ok: false, reason: "deployment_body_invalid" };
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "deployment_body_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
    return { ok: false, reason: "deployment_body_read_failed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { ok: false, reason: "deployment_body_utf8_invalid" };
  }
}

function responseUrlHasOrigin(response, fallbackUrl, origin) {
  try {
    return new URL(response?.url || fallbackUrl).origin === origin;
  } catch {
    return false;
  }
}

/**
 * @returns {
 *   {ok: true, values: RuntimeEnvironment} |
 *   {ok: false, reason: string}
 * }
 */
function configuredPublicValues(sources) {
  const result = {};
  for (const [envName, fieldName] of PUBLIC_FIELDS) {
    const pattern = new RegExp(`${fieldName}:"([^"\\\\]+)"`, "g");
    const matches = sources.flatMap((source) =>
      [...source.matchAll(pattern)].map((match) => match[1]),
    );
    const unique = [
      ...new Set(matches.filter((value) => safeWireText(value, 256))),
    ];
    if (unique.length > 1) {
      return { ok: false, reason: "deployment_public_value_ambiguous" };
    }
    if (unique.length === 1) result[envName] = unique[0];
  }
  const channelCount = Object.keys(result).filter((name) =>
    name.startsWith("NEXT_PUBLIC_PORTONE_CHANNEL_KEY_"),
  ).length;
  if (
    typeof result.NEXT_PUBLIC_PORTONE_STORE_ID !== "string" ||
    channelCount === 0
  ) {
    return { ok: false, reason: "deployment_public_value_missing" };
  }
  return { ok: true, values: result };
}

/**
 * @param {{
 *   env?: RuntimeEnvironment,
 *   fetchImpl?: typeof fetch
 * }} [options]
 * @returns {Promise<
 *   {ok: true, env: RuntimeEnvironment} |
 *   {ok: false, reason: string}
 * >}
 */
export async function loadDeploymentPublicPortoneEnvironment(
  {
    env = process.env,
    fetchImpl = fetch,
  } = {},
) {
  const origin = publicOrigin(
    env.BOSS_PAEGI_PRODUCTION_ORIGIN ??
      DEFAULT_PRODUCTION_ORIGIN,
  );
  if (!origin) return { ok: false, reason: "production_site_url_invalid" };

  let pageResponse;
  try {
    pageResponse = await fetchImpl(`${origin}/credits`, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: "deployment_page_unavailable" };
  }
  if (
    !pageResponse.ok ||
    !responseUrlHasOrigin(
      pageResponse,
      `${origin}/credits`,
      origin,
    )
  ) {
    return { ok: false, reason: "deployment_page_unavailable" };
  }
  const html = await readBoundedText(pageResponse, 2 * 1024 * 1024);
  if (!html.ok) return html;

  const paths = [
    ...new Set(
      [...html.value.matchAll(/\/_next\/static\/[^"' <]+\.js/g)].map(
        (match) => match[0],
      ),
    ),
  ];
  if (paths.length === 0 || paths.length > 100) {
    return { ok: false, reason: "deployment_script_inventory_invalid" };
  }

  const sources = [];
  let totalBytes = 0;
  for (const path of paths) {
    const sourceUrl = new URL(path, origin);
    let response;
    try {
      response = await fetchImpl(sourceUrl, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue;
    }
    if (
      !response.ok ||
      response.redirected ||
      !responseUrlHasOrigin(response, sourceUrl, origin)
    ) {
      continue;
    }
    const source = await readBoundedText(response, 5 * 1024 * 1024);
    if (!source.ok) return source;
    totalBytes += new TextEncoder().encode(source.value).byteLength;
    if (totalBytes > 20 * 1024 * 1024) {
      return { ok: false, reason: "deployment_script_inventory_too_large" };
    }
    if (source.value.includes("PORTONE_STORE_ID")) {
      sources.push(source.value);
    }
  }
  const discovered = configuredPublicValues(sources);
  if (!discovered.ok) return discovered;

  for (const [name, value] of Object.entries(discovered.values)) {
    const existing = env[name];
    if (
      typeof existing === "string" &&
      existing.length > 0 &&
      existing !== value
    ) {
      return { ok: false, reason: "deployment_public_config_mismatch" };
    }
  }
  return { ok: true, env: { ...env, ...discovered.values } };
}

export function parseProductionBackfillArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, reason: "invalid_arguments" };
  }
  let runtimeEnvFile = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime-env-file" && runtimeEnvFile === null) {
      const candidate = argv[index + 1];
      if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.startsWith("-")
      ) {
        return { ok: false, reason: "runtime_env_file_invalid" };
      }
      runtimeEnvFile = candidate;
      index += 1;
    } else if (arg === "--apply" && !apply) {
      apply = true;
    } else {
      return { ok: false, reason: "unsupported_argument" };
    }
  }
  return { ok: true, runtimeEnvFile, apply };
}

export async function main(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const logger =
    typeof dependencies.logger === "function"
      ? dependencies.logger
      : console.log;
  const parsed = parseProductionBackfillArgs(argv);
  if (!parsed.ok) {
    logger(`blocker reason=${parsed.reason}`);
    return 2;
  }
  if (parsed.runtimeEnvFile !== null) {
    try {
      (dependencies.loadEnvFile ?? loadEnvFile)(parsed.runtimeEnvFile);
    } catch {
      logger("blocker reason=runtime_env_file_load_failed");
      return 1;
    }
  }
  const sourceEnv = dependencies.env ?? process.env;
  const target = verifyProductionSupabaseTarget(sourceEnv);
  if (!target.ok) {
    logger(`blocker reason=${target.reason}`);
    return 1;
  }
  let sourceIdentity;
  try {
    sourceIdentity = (
      dependencies.readCanonicalSourceIdentity ??
      readCanonicalSourceIdentity
    )(sourceEnv);
  } catch {
    logger("blocker reason=production_source_identity_invalid");
    return 1;
  }
  const frozenProbe = async () => {
    try {
      return await (
        dependencies.verifyFrozenSurfaces ?? verifyFrozenSurfaces
      )({
        origin:
          sourceEnv.BOSS_PAEGI_PRODUCTION_ORIGIN ??
          DEFAULT_PRODUCTION_ORIGIN,
        expectedProjectRef:
          sourceEnv.BOSS_PAEGI_SUPABASE_PROJECT_REF,
        allowedCommits: new Set([sourceIdentity?.commit]),
        fetchImpl: dependencies.fetchImpl ?? fetch,
      });
    } catch {
      return false;
    }
  };
  if (!(await frozenProbe())) {
    logger("blocker reason=production_deployment_not_frozen");
    return 1;
  }
  const loaded = await loadDeploymentPublicPortoneEnvironment({
    env: sourceEnv,
    fetchImpl: dependencies.fetchImpl ?? fetch,
  });
  if (!loaded.ok) {
    logger(`blocker reason=${loaded.reason}`);
    return 1;
  }
  // Bracket the canonical bundle scrape with the exact paid-route identity.
  // A rolling alias switch must not let config from one deployment authorize a
  // backfill while another deployment is serving the mutation surfaces.
  if (!(await frozenProbe())) {
    logger("blocker reason=production_deployment_not_frozen");
    return 1;
  }
  logger("production_public_config source=canonical_deployment");
  const exitCode = await (
    dependencies.runBackfillMain ?? runBackfillMain
  )(
    parsed.apply ? ["--apply"] : [],
    loaded.env,
    dependencies,
  );
  // The core runner can take long enough for an alias transition. Even a
  // successful/partially committed apply is not accepted as a rollout result
  // unless the same clean source build is still frozen at the end.
  if (!(await frozenProbe())) {
    logger("blocker reason=production_deployment_not_frozen");
    return 1;
  }
  return exitCode;
}

if (
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("blocker reason=unexpected_failure");
      process.exitCode = 1;
    });
}
