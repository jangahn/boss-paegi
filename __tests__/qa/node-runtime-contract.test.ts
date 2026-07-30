import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  chooseNode22Executable,
} from "../../scripts/qa/run-node22-command.mjs";

const root = new URL("../../", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
) as {
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
};

test("every local build, dev, and start entry point fails closed outside Node 22", () => {
  assert.equal(
    readFileSync(new URL(".nvmrc", root), "utf8").trim(),
    "22",
  );
  assert.equal(packageJson.engines?.node, "22.x");
  assert.equal(
    packageJson.scripts?.prebuild,
    "node scripts/qa/assert-node-major.mjs",
  );
  assert.match(
    packageJson.scripts?.build ?? "",
    /^node scripts\/qa\/assert-node-major\.mjs && /,
  );
  assert.equal(
    packageJson.scripts?.prestart,
    "node scripts/qa/assert-node-major.mjs",
  );
  assert.match(
    packageJson.scripts?.start ?? "",
    /^node scripts\/qa\/assert-node-major\.mjs && /,
  );
  assert.equal(
    packageJson.scripts?.predev,
    "node scripts/qa/run-node22-command.mjs node scripts/qa/assert-node-major.mjs",
  );
  assert.equal(
    packageJson.scripts?.dev,
    "node scripts/qa/run-node22-command.mjs node node_modules/next/dist/bin/next dev --hostname 0.0.0.0",
  );
  assert.doesNotMatch(packageJson.scripts?.dev ?? "", /PATH=":/);
});

test("the dev launcher has no Node 24 or empty-candidate fallback", () => {
  assert.equal(
    chooseNode22Executable({
      currentVersion: "24.4.1",
      currentExecutable: "/system/node",
      candidates: [],
    }),
    null,
  );
  assert.equal(
    chooseNode22Executable({
      currentVersion: "24.4.1",
      currentExecutable: "/system/node",
      candidates: [
        { version: "v20.19.4", executable: "/nvm/v20/bin/node" },
        { version: "v23.11.1", executable: "/nvm/v23/bin/node" },
      ],
    }),
    null,
  );
  assert.equal(
    chooseNode22Executable({
      currentVersion: "24.4.1",
      currentExecutable: "/system/node",
      candidates: [
        { version: "v22.14.0", executable: "/nvm/v22.14/bin/node" },
        { version: "v22.23.2", executable: "/nvm/v22.23/bin/node" },
      ],
    }),
    "/nvm/v22.23/bin/node",
  );
  assert.equal(
    chooseNode22Executable({
      currentVersion: "22.23.2",
      currentExecutable: "/active/node",
      candidates: [],
    }),
    "/active/node",
  );
});

test("a PATH-shadowed global next can never replace the repository-pinned CLI", () => {
  const repositoryRoot = fileURLToPath(root);
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "boss-paegi-next-shadow-"),
  );
  const shadowMarker = join(temporaryDirectory, "shadow-ran");
  const fakeNext = join(temporaryDirectory, "next");

  try {
    writeFileSync(
      fakeNext,
      `#!/bin/sh\n: > "${shadowMarker}"\nexit 0\n`,
      "utf8",
    );
    chmodSync(fakeNext, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts", "qa", "run-node22-command.mjs"),
        "node",
        "node_modules/next/dist/bin/next",
        "dev",
        "--help",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${temporaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(shadowMarker), false);
    assert.match(result.stdout, /Usage: next dev/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
