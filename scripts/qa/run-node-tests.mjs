import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const testsRoot = path.join(repositoryRoot, "__tests__");
const testFilePattern = /\.test\.(?:[cm]?[jt]s|tsx)$/;

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discover(absolute)));
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(absolute);
    }
  }

  return files;
}

const files = (await discover(testsRoot)).sort((left, right) =>
  left < right ? -1 : left > right ? 1 : 0,
);

if (files.length === 0) {
  throw new Error("No Node test files discovered under __tests__");
}

console.log(`Discovered ${files.length} Node test files recursively.`);
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...files],
  {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.signal) {
  console.error(`Node test runner terminated by ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
