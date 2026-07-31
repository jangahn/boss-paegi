import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  readOAuthReceiptMigrationSource,
  verifyOAuthReceiptSourceLineage,
} from "../../scripts/qa/oauth-receipt-source-lineage.mjs";

function git(repositoryRoot: string, ...arguments_: string[]) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function repository(t: TestContext) {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "boss-paegi-oauth-lineage-"),
  );
  t.after(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
  });
  git(repositoryRoot, "init", "--quiet", "--initial-branch=main");
  git(repositoryRoot, "config", "user.name", "Boss Paegi QA");
  git(repositoryRoot, "config", "user.email", "qa@example.invalid");
  return repositoryRoot;
}

async function commitFile(
  repositoryRoot: string,
  filename: string,
  contents: string,
  message: string,
) {
  await mkdir(path.dirname(path.join(repositoryRoot, filename)), {
    recursive: true,
  });
  await writeFile(path.join(repositoryRoot, filename), contents, "utf8");
  git(repositoryRoot, "add", "--", filename);
  git(repositoryRoot, "commit", "--quiet", "-m", message);
  return git(repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}");
}

test("receipt migration source comes from the immutable commit blob, not the descendant worktree", async (t) => {
  const repositoryRoot = await repository(t);
  const version = "0093_oauth_flow_intents";
  const filename = `supabase/migrations/${version}.sql`;
  const receiptSource = "begin;\nselect 'receipt';\ncommit;\n";
  const receiptCommit = await commitFile(
    repositoryRoot,
    filename,
    receiptSource,
    "oauth expand receipt",
  );
  await commitFile(
    repositoryRoot,
    filename,
    "begin;\nselect 'rewritten descendant';\ncommit;\n",
    "rewrite historical migration",
  );

  assert.equal(
    readOAuthReceiptMigrationSource({
      receiptCommit,
      migrationVersion: version,
      repositoryRoot,
    }),
    receiptSource,
  );
});

test("receipt migration source rejects path injection, missing blobs, and invalid UTF-8", async (t) => {
  const repositoryRoot = await repository(t);
  const receiptCommit = await commitFile(
    repositoryRoot,
    "base.txt",
    "base\n",
    "base",
  );
  for (const migrationVersion of [
    "../0093_oauth_flow_intents",
    "0093-oauth",
    "0093_OAUTH",
    "0093_oauth.sql",
  ]) {
    assert.throws(
      () =>
        readOAuthReceiptMigrationSource({
          receiptCommit,
          migrationVersion,
          repositoryRoot,
        }),
      /oauth_receipt_migration_version_invalid/u,
    );
  }
  assert.throws(
    () =>
      readOAuthReceiptMigrationSource({
        receiptCommit,
        migrationVersion: "0093_oauth_flow_intents",
        repositoryRoot,
      }),
    /oauth_receipt_lineage_git_invalid/u,
  );

  const invalidFilename =
    "supabase/migrations/0093_oauth_flow_intents.sql";
  await mkdir(path.dirname(path.join(repositoryRoot, invalidFilename)), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, invalidFilename),
    Buffer.from([0xff, 0xfe, 0xfd]),
  );
  git(repositoryRoot, "add", "--", invalidFilename);
  git(repositoryRoot, "commit", "--quiet", "-m", "invalid utf8");
  const invalidCommit = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  );
  assert.throws(
    () =>
      readOAuthReceiptMigrationSource({
        receiptCommit: invalidCommit,
        migrationVersion: "0093_oauth_flow_intents",
        repositoryRoot,
      }),
    /oauth_receipt_migration_source_invalid/u,
  );
});

test("same receipt and deployment commit resolves the immutable receipt tree without moving HEAD", async (t) => {
  const repositoryRoot = await repository(t);
  const receiptCommit = await commitFile(
    repositoryRoot,
    "receipt.txt",
    "expand\n",
    "oauth expand receipt",
  );
  const expectedTree = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    `${receiptCommit}^{tree}`,
  );
  const headBefore = git(repositoryRoot, "rev-parse", "HEAD");

  const result = verifyOAuthReceiptSourceLineage({
    receiptCommit,
    deploymentCommit: receiptCommit,
    repositoryRoot,
  });

  assert.deepEqual(result, {
    receiptCommit,
    receiptTree: expectedTree,
    deploymentCommit: receiptCommit,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(git(repositoryRoot, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(repositoryRoot, "status", "--porcelain=v1"), "");
});

test("a descendant fix-forward preserves the original receipt tree", async (t) => {
  const repositoryRoot = await repository(t);
  const receiptCommit = await commitFile(
    repositoryRoot,
    "receipt.txt",
    "expand\n",
    "oauth expand receipt",
  );
  const receiptTree = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    `${receiptCommit}^{tree}`,
  );
  const deploymentCommit = await commitFile(
    repositoryRoot,
    "fix-forward.txt",
    "safe descendant\n",
    "fix forward",
  );
  assert.notEqual(
    receiptTree,
    git(repositoryRoot, "rev-parse", "--verify", "HEAD^{tree}"),
  );

  assert.deepEqual(
    verifyOAuthReceiptSourceLineage({
      receiptCommit,
      deploymentCommit,
      repositoryRoot,
    }),
    { receiptCommit, receiptTree, deploymentCommit },
  );
});

test("a merge deployment accepts a receipt commit reachable through a non-first-parent branch", async (t) => {
  const repositoryRoot = await repository(t);
  const baseCommit = await commitFile(
    repositoryRoot,
    "base.txt",
    "base\n",
    "base",
  );
  git(repositoryRoot, "switch", "--quiet", "-c", "oauth-expand");
  const receiptCommit = await commitFile(
    repositoryRoot,
    "receipt.txt",
    "expand\n",
    "oauth expand receipt",
  );
  const receiptTree = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    `${receiptCommit}^{tree}`,
  );

  git(repositoryRoot, "switch", "--quiet", "main");
  await commitFile(
    repositoryRoot,
    "main-change.txt",
    "independent main change\n",
    "main change",
  );
  git(
    repositoryRoot,
    "merge",
    "--quiet",
    "--no-ff",
    "oauth-expand",
    "-m",
    "merge oauth expand",
  );
  const deploymentCommit = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  );
  assert.notEqual(deploymentCommit, baseCommit);

  assert.deepEqual(
    verifyOAuthReceiptSourceLineage({
      receiptCommit,
      deploymentCommit,
      repositoryRoot,
    }),
    { receiptCommit, receiptTree, deploymentCommit },
  );
});

test("a rebased or cherry-picked equivalent commit is not receipt ancestry", async (t) => {
  const repositoryRoot = await repository(t);
  await commitFile(repositoryRoot, "base.txt", "base\n", "base");
  git(repositoryRoot, "switch", "--quiet", "-c", "oauth-expand");
  const receiptCommit = await commitFile(
    repositoryRoot,
    "receipt.txt",
    "expand\n",
    "oauth expand receipt",
  );

  git(repositoryRoot, "switch", "--quiet", "main");
  await commitFile(
    repositoryRoot,
    "deployment-base.txt",
    "diverged\n",
    "deployment base",
  );
  git(repositoryRoot, "cherry-pick", "--quiet", receiptCommit);
  const deploymentCommit = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  );
  assert.notEqual(receiptCommit, deploymentCommit);

  assert.throws(
    () =>
      verifyOAuthReceiptSourceLineage({
        receiptCommit,
        deploymentCommit,
        repositoryRoot,
      }),
    /oauth_receipt_commit_not_ancestor/u,
  );
});

test("missing commit objects and non-commit object IDs fail closed", async (t) => {
  const repositoryRoot = await repository(t);
  const deploymentCommit = await commitFile(
    repositoryRoot,
    "base.txt",
    "base\n",
    "base",
  );
  const treeObject = git(
    repositoryRoot,
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  );

  for (const receiptCommit of ["f".repeat(40), treeObject]) {
    assert.throws(
      () =>
        verifyOAuthReceiptSourceLineage({
          receiptCommit,
          deploymentCommit,
          repositoryRoot,
        }),
      /oauth_receipt_lineage_git_invalid/u,
    );
  }
  assert.throws(
    () =>
      verifyOAuthReceiptSourceLineage({
        receiptCommit: deploymentCommit,
        deploymentCommit: "e".repeat(40),
        repositoryRoot,
      }),
    /oauth_receipt_lineage_git_invalid/u,
  );
});

test("malformed or non-canonical commit IDs are rejected before Git resolution", async (t) => {
  const repositoryRoot = await repository(t);
  const commit = await commitFile(
    repositoryRoot,
    "base.txt",
    "base\n",
    "base",
  );

  for (const receiptCommit of [
    commit.slice(0, 12),
    commit.toUpperCase(),
    ` ${commit}`,
    "g".repeat(40),
  ]) {
    assert.throws(
      () =>
        verifyOAuthReceiptSourceLineage({
          receiptCommit,
          deploymentCommit: commit,
          repositoryRoot,
        }),
      /oauth_receipt_commit_invalid/u,
    );
  }
  for (const deploymentCommit of [
    commit.slice(0, 39),
    commit.toUpperCase(),
    `${commit}\n`,
    "z".repeat(40),
  ]) {
    assert.throws(
      () =>
        verifyOAuthReceiptSourceLineage({
          receiptCommit: commit,
          deploymentCommit,
          repositoryRoot,
        }),
      /oauth_deployment_commit_invalid/u,
    );
  }
});

test("repository and Git execution failures never degrade to acceptance", async (t) => {
  const repositoryRoot = await repository(t);
  const commit = await commitFile(
    repositoryRoot,
    "base.txt",
    "base\n",
    "base",
  );
  const nonRepository = await mkdtemp(
    path.join(tmpdir(), "boss-paegi-not-git-"),
  );
  t.after(async () => {
    await rm(nonRepository, { recursive: true, force: true });
  });

  assert.throws(
    () =>
      verifyOAuthReceiptSourceLineage({
        receiptCommit: commit,
        deploymentCommit: commit,
        repositoryRoot: nonRepository,
      }),
    /oauth_receipt_lineage_git_invalid/u,
  );
  assert.throws(
    () =>
      verifyOAuthReceiptSourceLineage({
        receiptCommit: commit,
        deploymentCommit: commit,
        repositoryRoot: "",
      }),
    /oauth_receipt_lineage_arguments_invalid/u,
  );
});

test("local replace refs cannot rewrite receipt tree or ancestry", async (t) => {
  const repositoryRoot = await repository(t);
  await commitFile(repositoryRoot, "base.txt", "base\n", "base");
  git(repositoryRoot, "switch", "--quiet", "-c", "receipt-branch");
  const receiptCommit = await commitFile(
    repositoryRoot,
    "receipt.txt",
    "expand\n",
    "oauth expand receipt",
  );
  const originalReceiptTree = git(
    repositoryRoot,
    "--no-replace-objects",
    "rev-parse",
    "--verify",
    `${receiptCommit}^{tree}`,
  );

  git(repositoryRoot, "switch", "--quiet", "main");
  const deploymentCommit = await commitFile(
    repositoryRoot,
    "unrelated.txt",
    "unrelated deployment\n",
    "unrelated deployment",
  );
  git(repositoryRoot, "replace", receiptCommit, deploymentCommit);
  assert.notEqual(
    git(
      repositoryRoot,
      "rev-parse",
      "--verify",
      `${receiptCommit}^{tree}`,
    ),
    originalReceiptTree,
  );

  assert.throws(
    () =>
      verifyOAuthReceiptSourceLineage({
        receiptCommit,
        deploymentCommit,
        repositoryRoot,
      }),
    /oauth_receipt_commit_not_ancestor/u,
  );
});

test("deprecated local graft metadata cannot forge receipt ancestry", async (t) => {
  const repositoryRoot = await repository(t);
  await commitFile(repositoryRoot, "base.txt", "base\n", "base");
  git(repositoryRoot, "switch", "--quiet", "-c", "receipt-branch");
  const receiptCommit = await commitFile(
    repositoryRoot,
    "receipt.txt",
    "expand\n",
    "oauth expand receipt",
  );

  git(repositoryRoot, "switch", "--quiet", "main");
  const deploymentCommit = await commitFile(
    repositoryRoot,
    "unrelated.txt",
    "unrelated deployment\n",
    "unrelated deployment",
  );
  const gitDirectory = git(
    repositoryRoot,
    "rev-parse",
    "--absolute-git-dir",
  );
  await writeFile(
    path.join(gitDirectory, "info", "grafts"),
    `${deploymentCommit} ${receiptCommit}\n`,
    "utf8",
  );

  assert.throws(
    () =>
      verifyOAuthReceiptSourceLineage({
        receiptCommit,
        deploymentCommit,
        repositoryRoot,
      }),
    /oauth_receipt_commit_not_ancestor|oauth_receipt_lineage_git_invalid/u,
  );
});
