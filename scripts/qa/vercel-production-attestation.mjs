import { createHash } from "node:crypto";

const VERCEL_API_ORIGIN = "https://api.vercel.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_PROVIDER_BODY_BYTES = 1024 * 1024;

export const BOSS_PAEGI_VERCEL_TEAM_ID =
  "team_NmYBq4k4t5BbaQKQNAHRgu8a";
export const BOSS_PAEGI_VERCEL_PROJECT_ID =
  "prj_s2s6J5J4DTUufvEMM0Pds8oUwhKU";
export const BOSS_PAEGI_PRODUCTION_ALIAS = "boss-paegi.vercel.app";
export const BOSS_PAEGI_GITHUB_REPOSITORY_ID = 1_260_129_355;
export const BOSS_PAEGI_GITHUB_REPOSITORY_OWNER_ID = 287_722_068;
export const BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS = 300;

function exactCommit(value, reason) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(reason);
  return normalized;
}

function positiveEpoch(value, reason) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 9_007_199_254_740_991
  ) {
    throw new Error(reason);
  }
  return value;
}

function exactVercelHostname(value, reason) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(
      normalized,
    )
  ) {
    throw new Error(reason);
  }
  return normalized;
}

async function readBoundedJson(response) {
  if (!response?.body) throw new Error("vercel_response_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("vercel_response_invalid");
      }
      total += value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel();
        throw new Error("vercel_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("vercel_response_invalid");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("vercel_response_invalid");
  }
}

async function providerGet(pathname, vercel, fetchImpl) {
  let response;
  try {
    const url = new URL(pathname, VERCEL_API_ORIGIN);
    url.searchParams.set("teamId", vercel.teamId);
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${vercel.token}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("vercel_request_failed");
  }
  if (!response.ok || response.redirected) {
    try {
      await response.body?.cancel();
    } catch {
      // Provider bodies may contain account metadata; never surface them.
    }
    throw new Error("vercel_request_failed");
  }
  return readBoundedJson(response);
}

async function readGitHubMainCommit(expectedCommit, githubToken, fetchImpl) {
  let response;
  try {
    const url = new URL(
      "/repos/jangahn/boss-paegi/branches/main",
      GITHUB_API_ORIGIN,
    );
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (githubToken !== null) {
      headers.Authorization = `Bearer ${githubToken}`;
    }
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("vercel_git_main_request_failed");
  }
  if (!response.ok || response.redirected) {
    try {
      await response.body?.cancel();
    } catch {
      // GitHub error bodies are not release evidence.
    }
    throw new Error("vercel_git_main_request_failed");
  }
  const branch = await readBoundedJson(response);
  if (
    !branch ||
    typeof branch !== "object" ||
    Array.isArray(branch) ||
    branch.name !== "main" ||
    !branch.commit ||
    typeof branch.commit !== "object" ||
    Array.isArray(branch.commit) ||
    exactCommit(
      branch.commit.sha,
      "vercel_git_main_attestation_invalid",
    ) !== expectedCommit ||
    branch.commit.url !==
      `${GITHUB_API_ORIGIN}/repos/jangahn/boss-paegi/commits/${expectedCommit}`
  ) {
    throw new Error("vercel_git_main_attestation_invalid");
  }
  return expectedCommit;
}

function readVercelEnvironment(env) {
  const token = env.BOSS_PAEGI_VERCEL_API_TOKEN;
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("vercel_access_token_missing");
  }
  const teamId = env.BOSS_PAEGI_VERCEL_ORG_ID;
  const projectId = env.BOSS_PAEGI_VERCEL_PROJECT_ID;
  if (teamId !== BOSS_PAEGI_VERCEL_TEAM_ID) {
    throw new Error("vercel_team_id_mismatch");
  }
  if (projectId !== BOSS_PAEGI_VERCEL_PROJECT_ID) {
    throw new Error("vercel_project_id_mismatch");
  }
  const githubToken =
    typeof env.PERSONAL_GITHUB_TOKEN === "string" &&
    env.PERSONAL_GITHUB_TOKEN.length >= 16
      ? env.PERSONAL_GITHUB_TOKEN
      : null;
  return { token, teamId, projectId, githubToken };
}

export function vercelProductionEvidenceSha256(evidence) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: "boss-paegi-vercel-production-attestation/v2",
        ...evidence,
      }),
    )
    .digest("hex");
}

/**
 * @typedef {Readonly<{
 *   provider: "vercel",
 *   teamId: string,
 *   projectId: string,
 *   deploymentId: string,
 *   deploymentUrl: string,
 *   productionAlias: string,
 *   aliasUid: string,
 *   appCommit: string,
 *   functionTimeoutSeconds: number,
 *   gitProvider: "github",
 *   gitRepositoryId: number,
 *   gitRepository: "jangahn/boss-paegi",
 *   gitRef: "main",
 *   gitMainCommit: string,
 *   deploymentCreatedAt: number,
 *   providerReadyAt: number,
 *   aliasCurrentSince: number,
 *   evidenceSha256: string
 * }>} VercelProductionAttestation
 */

/**
 * Resolves the current production alias through Vercel itself and binds it to
 * one immutable production deployment. No operator-provided timestamp or URL
 * is accepted as deployment authority.
 *
 * @param {{
 *   expectedCommit: string,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   nowMs?: number
 * }} options
 * @returns {Promise<VercelProductionAttestation>}
 */
export async function readVercelProductionAttestation({
  expectedCommit,
  env = process.env,
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    throw new Error("vercel_attestation_arguments_invalid");
  }
  const commit = exactCommit(
    expectedCommit,
    "vercel_attestation_commit_invalid",
  );
  const aliasHostname = exactVercelHostname(
    BOSS_PAEGI_PRODUCTION_ALIAS,
    "vercel_production_alias_invalid",
  );
  const vercel = readVercelEnvironment(env);
  const alias = await providerGet(
    `/v4/aliases/${encodeURIComponent(aliasHostname)}?projectId=${encodeURIComponent(
      vercel.projectId,
    )}`,
    vercel,
    fetchImpl,
  );
  if (
    !alias ||
    typeof alias !== "object" ||
    Array.isArray(alias) ||
    alias.alias !== aliasHostname ||
    alias.projectId !== vercel.projectId ||
    typeof alias.uid !== "string" ||
    !/^[0-9a-f]{64,256}$/.test(alias.uid) ||
    typeof alias.deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]{16,64}$/.test(alias.deploymentId) ||
    typeof alias.updatedAt !== "number" ||
    alias.redirect !== null
  ) {
    throw new Error("vercel_alias_attestation_invalid");
  }
  const aliasUpdatedAt = positiveEpoch(
    alias.updatedAt,
    "vercel_alias_attestation_invalid",
  );

  const deployment = await providerGet(
    `/v13/deployments/${encodeURIComponent(
      alias.deploymentId,
    )}?withGitRepoInfo=true`,
    vercel,
    fetchImpl,
  );
  const deploymentUrl = exactVercelHostname(
    deployment?.url,
    "vercel_deployment_attestation_invalid",
  );
  const deploymentCommit = exactCommit(
    deployment?.meta?.githubCommitSha,
    "vercel_deployment_attestation_invalid",
  );
  const providerReadyAt = positiveEpoch(
    deployment?.ready,
    "vercel_deployment_attestation_invalid",
  );
  const aliasAssignedAt =
    typeof deployment?.aliasAssignedAt === "number"
      ? positiveEpoch(
          deployment.aliasAssignedAt,
          "vercel_deployment_attestation_invalid",
        )
      : providerReadyAt;
  if (
    !deployment ||
    typeof deployment !== "object" ||
    Array.isArray(deployment) ||
    deployment.id !== alias.deploymentId ||
    deployment.projectId !== vercel.projectId ||
    deployment.ownerId !== vercel.teamId ||
    deployment.team?.id !== vercel.teamId ||
    deployment.project?.id !== vercel.projectId ||
    deployment.project?.name !== "boss-paegi" ||
    // `source` is only Vercel's best-effort classification, so it is a
    // conservative supplementary signal. The authoritative main-ref check
    // below comes directly from GitHub and is also bound to gitRepo+meta.
    deployment.source !== "git" ||
    !deployment.gitRepo ||
    typeof deployment.gitRepo !== "object" ||
    Array.isArray(deployment.gitRepo) ||
    deployment.gitRepo.type !== "github" ||
    deployment.gitRepo.repoId !== BOSS_PAEGI_GITHUB_REPOSITORY_ID ||
    deployment.gitRepo.repoOwnerId !==
      BOSS_PAEGI_GITHUB_REPOSITORY_OWNER_ID ||
    deployment.gitRepo.path !== "jangahn/boss-paegi" ||
    deployment.gitRepo.defaultBranch !== "main" ||
    deployment.gitRepo.name !== "boss-paegi" ||
    deployment.gitRepo.org !== "jangahn" ||
    deployment.gitRepo.repo !== "boss-paegi" ||
    deployment.gitRepo.private !== false ||
    deployment.gitRepo.ownerType !== "team" ||
    deployment.target !== "production" ||
    deployment.readyState !== "READY" ||
    deployment.status !== "READY" ||
    deployment.readySubstate !== "PROMOTED" ||
    deployment.aliasAssigned !== true ||
    !Array.isArray(deployment.alias) ||
    !deployment.alias.includes(aliasHostname) ||
    deploymentUrl === aliasHostname ||
    deploymentCommit !== commit ||
    deployment.meta?.githubCommitSha !== commit ||
    deployment.meta?.githubCommitOrg !== "jangahn" ||
    deployment.meta?.githubCommitRepo !== "boss-paegi" ||
    deployment.meta?.githubCommitRef !== "main" ||
    deployment.meta?.githubOrg !== "jangahn" ||
    deployment.meta?.githubRepo !== "boss-paegi" ||
    deployment.meta?.githubDeployment !== "1" ||
    (
      deployment.nodeVersion ??
      deployment.projectSettings?.nodeVersion
    ) !== "22.x" ||
    deployment.config?.functionTimeout !==
      BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS
  ) {
    throw new Error("vercel_deployment_attestation_invalid");
  }
  const gitMainCommit = await readGitHubMainCommit(
    commit,
    vercel.githubToken,
    fetchImpl,
  );
  const deploymentCreatedAt = positiveEpoch(
    deployment.createdAt,
    "vercel_deployment_attestation_invalid",
  );
  const aliasCurrentSince = Math.max(
    providerReadyAt,
    aliasAssignedAt,
    aliasUpdatedAt,
  );
  if (
    deploymentCreatedAt > providerReadyAt ||
    providerReadyAt > aliasCurrentSince ||
    aliasCurrentSince > nowMs + 5_000
  ) {
    throw new Error("vercel_deployment_timeline_invalid");
  }

  const evidence = Object.freeze({
    provider: "vercel",
    teamId: vercel.teamId,
    projectId: vercel.projectId,
    deploymentId: deployment.id,
    deploymentUrl,
    productionAlias: aliasHostname,
    aliasUid: alias.uid,
    appCommit: commit,
    functionTimeoutSeconds:
      BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS,
    gitProvider: "github",
    gitRepositoryId: BOSS_PAEGI_GITHUB_REPOSITORY_ID,
    gitRepository: "jangahn/boss-paegi",
    gitRef: "main",
    gitMainCommit,
    deploymentCreatedAt,
    providerReadyAt,
    aliasCurrentSince,
  });
  return Object.freeze({
    ...evidence,
    evidenceSha256: vercelProductionEvidenceSha256(evidence),
  });
}

export function sameVercelProductionAttestation(left, right) {
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  return (
    left.evidenceSha256 === right.evidenceSha256 &&
    left.deploymentId === right.deploymentId &&
    left.aliasUid === right.aliasUid &&
    left.aliasCurrentSince === right.aliasCurrentSince
  );
}
