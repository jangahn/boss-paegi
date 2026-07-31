import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(
  new URL("../..", import.meta.url),
);
const EXACT_SHA1 = /^[0-9a-f]{40}$/u;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 4_096;
const MAX_MIGRATION_SOURCE_BYTES = 2 * 1024 * 1024;
const EXACT_MIGRATION_VERSION = /^[0-9]{4,6}_[a-z0-9_]+$/u;

const REDIRECTING_GIT_ENVIRONMENT_KEYS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

function exactCommit(value, reason) {
  if (typeof value !== "string" || !EXACT_SHA1.test(value)) {
    throw new Error(reason);
  }
  return value;
}

function isolatedGitEnvironment() {
  const environment = { ...process.env };
  for (const key of REDIRECTING_GIT_ENVIRONMENT_KEYS) {
    delete environment[key];
  }
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.LC_ALL = "C";
  return environment;
}

function runGit(repositoryRoot, arguments_) {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.commitGraph=false",
      "-C",
      repositoryRoot,
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: isolatedGitEnvironment(),
      input: "",
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status === null) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }
  return result;
}

function readGitBlob(repositoryRoot, objectPath, expectedBytes) {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.commitGraph=false",
      "-C",
      repositoryRoot,
      "cat-file",
      "blob",
      objectPath,
    ],
    {
      encoding: null,
      env: isolatedGitEnvironment(),
      input: Buffer.alloc(0),
      maxBuffer: MAX_MIGRATION_SOURCE_BYTES + 1,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.length !== 0 ||
    result.stdout.length !== expectedBytes
  ) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error("oauth_receipt_migration_source_invalid");
  }
}

function resolveCommit(repositoryRoot, commit) {
  const result = runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ]);
  if (
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    !/^[0-9a-f]{40}\n$/u.test(result.stdout)
  ) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }
  const resolved = result.stdout.slice(0, 40);
  if (resolved !== commit) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }
  return resolved;
}

function resolveCommitTree(repositoryRoot, commit) {
  const result = runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${commit}^{tree}`,
  ]);
  if (
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    !/^[0-9a-f]{40}\n$/u.test(result.stdout)
  ) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }
  return result.stdout.slice(0, 40);
}

/**
 * Reads the exact migration blob recorded in an immutable receipt commit.
 * `git cat-file` avoids checkout, worktree filters, and mutable refs.
 *
 * @param {{
 *   receiptCommit: string,
 *   migrationVersion: string,
 *   repositoryRoot?: string
 * }} options
 * @returns {string}
 */
export function readOAuthReceiptMigrationSource({
  receiptCommit,
  migrationVersion,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new Error("oauth_receipt_lineage_arguments_invalid");
  }
  const canonicalReceiptCommit = exactCommit(
    receiptCommit,
    "oauth_receipt_commit_invalid",
  );
  if (
    typeof migrationVersion !== "string" ||
    !EXACT_MIGRATION_VERSION.test(migrationVersion)
  ) {
    throw new Error("oauth_receipt_migration_version_invalid");
  }
  resolveCommit(repositoryRoot, canonicalReceiptCommit);
  const objectPath =
    `${canonicalReceiptCommit}:supabase/migrations/${migrationVersion}.sql`;
  const sizeResult = runGit(repositoryRoot, [
    "cat-file",
    "-s",
    objectPath,
  ]);
  if (
    sizeResult.status !== 0 ||
    typeof sizeResult.stdout !== "string" ||
    !/^[1-9][0-9]{0,7}\n$/u.test(sizeResult.stdout) ||
    sizeResult.stderr !== ""
  ) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }
  const expectedBytes = Number(sizeResult.stdout.trim());
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > MAX_MIGRATION_SOURCE_BYTES
  ) {
    throw new Error("oauth_receipt_migration_source_invalid");
  }
  const source = readGitBlob(
    repositoryRoot,
    objectPath,
    expectedBytes,
  );
  if (source.length === 0) {
    throw new Error("oauth_receipt_migration_source_invalid");
  }
  return source;
}

/**
 * Resolves one immutable OAuth migration receipt commit from the repository's
 * local object database and proves that the deployed commit descends from it.
 * Exact object IDs and disabled replace refs prevent mutable refs or local
 * replacement objects from changing the receipt's source identity.
 *
 * @param {{
 *   receiptCommit: string,
 *   deploymentCommit: string,
 *   repositoryRoot?: string
 * }} options
 * @returns {{
 *   receiptCommit: string,
 *   receiptTree: string,
 *   deploymentCommit: string
 * }}
 */
export function verifyOAuthReceiptSourceLineage({
  receiptCommit,
  deploymentCommit,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new Error("oauth_receipt_lineage_arguments_invalid");
  }
  const canonicalReceiptCommit = exactCommit(
    receiptCommit,
    "oauth_receipt_commit_invalid",
  );
  const canonicalDeploymentCommit = exactCommit(
    deploymentCommit,
    "oauth_deployment_commit_invalid",
  );

  resolveCommit(repositoryRoot, canonicalReceiptCommit);
  resolveCommit(repositoryRoot, canonicalDeploymentCommit);
  const receiptTree = exactCommit(
    resolveCommitTree(repositoryRoot, canonicalReceiptCommit),
    "oauth_receipt_tree_invalid",
  );

  const ancestry = runGit(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    canonicalReceiptCommit,
    canonicalDeploymentCommit,
  ]);
  if (ancestry.status === 1) {
    throw new Error("oauth_receipt_commit_not_ancestor");
  }
  if (
    ancestry.status !== 0 ||
    ancestry.stdout !== "" ||
    ancestry.stderr !== ""
  ) {
    throw new Error("oauth_receipt_lineage_git_invalid");
  }

  return Object.freeze({
    receiptCommit: canonicalReceiptCommit,
    receiptTree,
    deploymentCommit: canonicalDeploymentCommit,
  });
}
