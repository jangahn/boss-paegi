import assert from "node:assert/strict";
import test from "node:test";

import {
  BOSS_PAEGI_GITHUB_REPOSITORY_ID,
  BOSS_PAEGI_GITHUB_REPOSITORY_OWNER_ID,
  BOSS_PAEGI_PRODUCTION_ALIAS,
  BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS,
  BOSS_PAEGI_VERCEL_PROJECT_ID,
  BOSS_PAEGI_VERCEL_TEAM_ID,
  readVercelProductionAttestation,
  sameVercelProductionAttestation,
} from "../../scripts/qa/vercel-production-attestation.mjs";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const DEPLOYMENT_ID = "dpl_1234567890abcdefghijklmnop";
const DEPLOYMENT_URL = "boss-paegi-release-jang-ahn.vercel.app";
const NOW = Date.parse("2026-07-31T12:05:00.000Z");
const READY = Date.parse("2026-07-31T12:01:00.000Z");
const ALIAS_CURRENT = Date.parse("2026-07-31T12:01:01.000Z");
const ENV = Object.freeze({
  BOSS_PAEGI_VERCEL_API_TOKEN: "vercel-api-token-for-tests",
  BOSS_PAEGI_VERCEL_ORG_ID: BOSS_PAEGI_VERCEL_TEAM_ID,
  BOSS_PAEGI_VERCEL_PROJECT_ID,
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function aliasPayload(overrides: Record<string, unknown> = {}) {
  return {
    alias: BOSS_PAEGI_PRODUCTION_ALIAS,
    uid: "a".repeat(128),
    created: "2026-06-05T09:29:41.339Z",
    createdAt: Date.parse("2026-06-05T09:29:41.339Z"),
    updatedAt: ALIAS_CURRENT,
    deploymentId: DEPLOYMENT_ID,
    projectId: BOSS_PAEGI_VERCEL_PROJECT_ID,
    redirect: null,
    redirectStatusCode: null,
    ...overrides,
  };
}

function gitRepoPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "github",
    repoId: BOSS_PAEGI_GITHUB_REPOSITORY_ID,
    repoOwnerId: BOSS_PAEGI_GITHUB_REPOSITORY_OWNER_ID,
    path: "jangahn/boss-paegi",
    defaultBranch: "main",
    name: "boss-paegi",
    org: "jangahn",
    repo: "boss-paegi",
    private: false,
    ownerType: "team",
    ...overrides,
  };
}

function gitMetaPayload(overrides: Record<string, unknown> = {}) {
  return {
    githubCommitSha: COMMIT,
    githubCommitRef: "main",
    githubCommitOrg: "jangahn",
    githubCommitRepo: "boss-paegi",
    githubOrg: "jangahn",
    githubRepo: "boss-paegi",
    githubDeployment: "1",
    ...overrides,
  };
}

function deploymentPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPLOYMENT_ID,
    url: DEPLOYMENT_URL,
    name: "boss-paegi",
    projectId: BOSS_PAEGI_VERCEL_PROJECT_ID,
    ownerId: BOSS_PAEGI_VERCEL_TEAM_ID,
    team: {
      id: BOSS_PAEGI_VERCEL_TEAM_ID,
      name: "JangAhn's projects",
      slug: "jang-ahn-s-projects",
    },
    project: {
      id: BOSS_PAEGI_VERCEL_PROJECT_ID,
      name: "boss-paegi",
      framework: "nextjs",
    },
    source: "git",
    gitRepo: gitRepoPayload(),
    alias: [BOSS_PAEGI_PRODUCTION_ALIAS],
    createdAt: READY - 120_000,
    ready: READY,
    readyState: "READY",
    readySubstate: "PROMOTED",
    status: "READY",
    target: "production",
    aliasAssigned: true,
    aliasAssignedAt: ALIAS_CURRENT,
    config: {
      functionTimeout:
        BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS,
    },
    projectSettings: { nodeVersion: "22.x" },
    meta: gitMetaPayload(),
    ...overrides,
  };
}

function providerHarness({
  alias = aliasPayload(),
  deployment = deploymentPayload(),
  githubBranch = {
    name: "main",
    commit: {
      sha: COMMIT,
      url: `https://api.github.com/repos/jangahn/boss-paegi/commits/${COMMIT}`,
    },
  },
}: {
  alias?: Record<string, unknown>;
  deployment?: Record<string, unknown>;
  githubBranch?: Record<string, unknown>;
} = {}) {
  const requests: URL[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.method, "GET");
    if (url.hostname === "api.github.com") {
      assert.equal(
        url.pathname,
        "/repos/jangahn/boss-paegi/branches/main",
      );
      assert.equal(
        new Headers(init?.headers).get("accept"),
        "application/vnd.github+json",
      );
      assert.equal(
        new Headers(init?.headers).get("x-github-api-version"),
        "2022-11-28",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        null,
      );
      return jsonResponse(githubBranch);
    }
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer vercel-api-token-for-tests",
    );
    assert.equal(url.searchParams.get("teamId"), BOSS_PAEGI_VERCEL_TEAM_ID);
    if (url.pathname.startsWith("/v4/aliases/")) {
      assert.equal(
        url.searchParams.get("projectId"),
        BOSS_PAEGI_VERCEL_PROJECT_ID,
      );
      return jsonResponse(alias);
    }
    assert.equal(url.pathname, `/v13/deployments/${DEPLOYMENT_ID}`);
    assert.equal(url.searchParams.get("withGitRepoInfo"), "true");
    return jsonResponse(deployment);
  };
  return { fetchImpl, requests };
}

test("Vercel attestation binds the current alias to one immutable READY production deployment", async () => {
  const harness = providerHarness();
  const result = await readVercelProductionAttestation({
    expectedCommit: COMMIT.toUpperCase(),
    env: ENV,
    fetchImpl: harness.fetchImpl,
    nowMs: NOW,
  });
  assert.deepEqual(
    { ...result, evidenceSha256: undefined },
    {
      provider: "vercel",
      teamId: BOSS_PAEGI_VERCEL_TEAM_ID,
      projectId: BOSS_PAEGI_VERCEL_PROJECT_ID,
      deploymentId: DEPLOYMENT_ID,
      deploymentUrl: DEPLOYMENT_URL,
      productionAlias: BOSS_PAEGI_PRODUCTION_ALIAS,
      aliasUid: "a".repeat(128),
      appCommit: COMMIT,
      functionTimeoutSeconds:
        BOSS_PAEGI_VERCEL_FUNCTION_TIMEOUT_SECONDS,
      gitProvider: "github",
      gitRepositoryId: BOSS_PAEGI_GITHUB_REPOSITORY_ID,
      gitRepository: "jangahn/boss-paegi",
      gitRef: "main",
      gitMainCommit: COMMIT,
      deploymentCreatedAt: READY - 120_000,
      providerReadyAt: READY,
      aliasCurrentSince: ALIAS_CURRENT,
      evidenceSha256: undefined,
    },
  );
  assert.match(result.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.equal(harness.requests.length, 3);
});

test("same-commit redeployments remain distinct provider attestations", async () => {
  const first = providerHarness();
  const firstResult = await readVercelProductionAttestation({
    expectedCommit: COMMIT,
    env: ENV,
    fetchImpl: first.fetchImpl,
    nowMs: NOW,
  });
  const otherDeploymentId = "dpl_abcdefghijklmnopqrstuvwxyz1234";
  const second = providerHarness({
    alias: aliasPayload({
      deploymentId: otherDeploymentId,
      uid: "b".repeat(128),
      updatedAt: ALIAS_CURRENT + 1_000,
    }),
    deployment: deploymentPayload({
      id: otherDeploymentId,
      url: "boss-paegi-new-release.vercel.app",
      aliasAssignedAt: ALIAS_CURRENT + 1_000,
    }),
  });
  const secondFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v13/deployments/")) {
      assert.equal(url.pathname, `/v13/deployments/${otherDeploymentId}`);
      return jsonResponse(
        deploymentPayload({
          id: otherDeploymentId,
          url: "boss-paegi-new-release.vercel.app",
          aliasAssignedAt: ALIAS_CURRENT + 1_000,
        }),
      );
    }
    return second.fetchImpl(input, init);
  };
  const secondResult = await readVercelProductionAttestation({
    expectedCommit: COMMIT,
    env: ENV,
    fetchImpl: secondFetch,
    nowMs: NOW,
  });
  assert.equal(
    sameVercelProductionAttestation(firstResult, secondResult),
    false,
  );
});

test("attestation rejects every identity, state, and timeline drift", async () => {
  const cases = [
    { alias: aliasPayload({ alias: "other.vercel.app" }) },
    { alias: aliasPayload({ projectId: "prj_otherotherotherother" }) },
    { alias: aliasPayload({ uid: "unsafe" }) },
    { alias: aliasPayload({ redirect: "other.vercel.app" }) },
    { alias: aliasPayload({ updatedAt: NOW + 10_000 }) },
    {
      deployment: deploymentPayload({ projectId: "prj_otherotherotherother" }),
    },
    { deployment: deploymentPayload({ ownerId: "team_otherotherother" }) },
    {
      deployment: deploymentPayload({
        team: {
          id: "team_otherotherother",
          name: "other",
          slug: "other",
        },
      }),
    },
    {
      deployment: deploymentPayload({
        project: {
          id: "prj_otherotherotherother",
          name: "boss-paegi",
        },
      }),
    },
    {
      deployment: deploymentPayload({
        project: {
          id: BOSS_PAEGI_VERCEL_PROJECT_ID,
          name: "other",
        },
      }),
    },
    { deployment: deploymentPayload({ source: "cli" }) },
    { deployment: deploymentPayload({ gitRepo: null }) },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({
          repoId: BOSS_PAEGI_GITHUB_REPOSITORY_ID + 1,
        }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({
          repoOwnerId: BOSS_PAEGI_GITHUB_REPOSITORY_OWNER_ID + 1,
        }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ path: "jangahn/other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ defaultBranch: "develop" }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ private: true }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ type: "gitlab" }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ name: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ org: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ repo: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        gitRepo: gitRepoPayload({ ownerType: "user" }),
      }),
    },
    { deployment: deploymentPayload({ target: "preview" }) },
    { deployment: deploymentPayload({ readyState: "BUILDING" }) },
    { deployment: deploymentPayload({ status: "ERROR" }) },
    { deployment: deploymentPayload({ readySubstate: "STAGED" }) },
    { deployment: deploymentPayload({ aliasAssigned: false }) },
    { deployment: deploymentPayload({ alias: ["other.vercel.app"] }) },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubCommitSha: "1".repeat(40) }),
      }),
    },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubCommitRef: "feature" }),
      }),
    },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubCommitOrg: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubCommitRepo: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubOrg: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubRepo: "other" }),
      }),
    },
    {
      deployment: deploymentPayload({
        meta: gitMetaPayload({ githubDeployment: "0" }),
      }),
    },
    {
      deployment: deploymentPayload({
        url: "boss-paegi.vercel.app.evil.example",
      }),
    },
    {
      deployment: deploymentPayload({
        url: BOSS_PAEGI_PRODUCTION_ALIAS,
      }),
    },
    { deployment: deploymentPayload({ createdAt: READY + 1 }) },
    {
      deployment: deploymentPayload({
        projectSettings: { nodeVersion: "20.x" },
      }),
    },
    {
      deployment: deploymentPayload({
        nodeVersion: "20.x",
        projectSettings: { nodeVersion: "22.x" },
      }),
    },
    {
      deployment: deploymentPayload({
        config: { functionTimeout: 301 },
      }),
    },
    {
      deployment: deploymentPayload({
        config: {},
      }),
    },
  ];
  for (const candidate of cases) {
    const harness = providerHarness(candidate);
    await assert.rejects(
      readVercelProductionAttestation({
        expectedCommit: COMMIT,
        env: ENV,
        fetchImpl: harness.fetchImpl,
        nowMs: NOW,
      }),
      /vercel_(?:alias|deployment)_(?:attestation|timeline)_invalid/u,
    );
  }
});

test("attestation independently binds the deployment commit to GitHub main", async () => {
  for (const githubBranch of [
    {
      name: "develop",
      commit: {
        sha: COMMIT,
        url: `https://api.github.com/repos/jangahn/boss-paegi/commits/${COMMIT}`,
      },
    },
    {
      name: "main",
      commit: {
        sha: "1".repeat(40),
        url: `https://api.github.com/repos/jangahn/boss-paegi/commits/${"1".repeat(40)}`,
      },
    },
    {
      name: "main",
      commit: {
        sha: COMMIT,
        url: `https://api.github.com/repos/jangahn/other/commits/${COMMIT}`,
      },
    },
  ]) {
    const harness = providerHarness({ githubBranch });
    await assert.rejects(
      readVercelProductionAttestation({
        expectedCommit: COMMIT,
        env: ENV,
        fetchImpl: harness.fetchImpl,
        nowMs: NOW,
      }),
      /vercel_git_main_attestation_invalid/u,
    );
  }
});

test("attestation refuses missing or cross-project provider credentials before network I/O", async () => {
  for (const env of [
    {},
    { ...ENV, BOSS_PAEGI_VERCEL_ORG_ID: "team_otherotherother" },
    { ...ENV, BOSS_PAEGI_VERCEL_PROJECT_ID: "prj_otherotherotherother" },
  ]) {
    let fetched = false;
    await assert.rejects(
      readVercelProductionAttestation({
        expectedCommit: COMMIT,
        env,
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({});
        },
        nowMs: NOW,
      }),
      /vercel_(?:access_token_missing|team_id_mismatch|project_id_mismatch)/u,
    );
    assert.equal(fetched, false);
  }
});
