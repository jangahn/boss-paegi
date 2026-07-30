#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_NODE_MAJOR = 22;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NODE_GUARD = join(
  REPOSITORY_ROOT,
  "scripts",
  "qa",
  "assert-node-major.mjs",
);

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Selects only an exact Node 22 executable. The candidate list is explicit so
 * the fail-closed no-installation branch can be unit tested without changing
 * HOME or the host PATH.
 */
export function chooseNode22Executable({
  currentVersion,
  currentExecutable,
  candidates,
}) {
  const current = parseVersion(currentVersion);
  if (current?.[0] === REQUIRED_NODE_MAJOR) return currentExecutable;

  const eligible = candidates
    .map((candidate) => ({
      ...candidate,
      parsed: parseVersion(candidate.version),
    }))
    .filter(
      (candidate) =>
        candidate.parsed?.[0] === REQUIRED_NODE_MAJOR &&
        candidate.executable.length > 0,
    )
    .sort((left, right) => compareVersions(left.parsed, right.parsed));

  return eligible.at(-1)?.executable ?? null;
}

function discoverNvmCandidates(versionsRoot) {
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        version: entry.name,
        executable: join(versionsRoot, entry.name, "bin", "node"),
      }))
      .filter((candidate) => existsSync(candidate.executable));
  } catch {
    return [];
  }
}

export function resolveNode22Executable({
  currentVersion = process.versions.node,
  currentExecutable = process.execPath,
  versionsRoot =
    process.env.BOSS_PAEGI_NODE22_VERSIONS_ROOT ??
    join(homedir(), ".nvm", "versions", "node"),
} = {}) {
  return chooseNode22Executable({
    currentVersion,
    currentExecutable,
    candidates: discoverNvmCandidates(versionsRoot),
  });
}

export function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length === 0) {
    console.error("Node 22 command runner requires a command.");
    return 1;
  }

  const nodeExecutable = resolveNode22Executable();
  if (!nodeExecutable) {
    console.error(
      `Command requires Node ${REQUIRED_NODE_MAJOR}.x, but no matching runtime was found.`,
    );
    return 1;
  }

  const guard = spawnSync(nodeExecutable, [NODE_GUARD], {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
  });
  if (guard.status !== 0) return guard.status ?? 1;

  const [command, ...args] = argv;
  const nodeBin = dirname(nodeExecutable);
  const inheritedPath = process.env.PATH ?? "";
  const runtimePath = inheritedPath
    ? `${nodeBin}${delimiter}${inheritedPath}`
    : nodeBin;
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, PATH: runtimePath },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Could not execute Node 22 command: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = main();
}
