import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("refund saga는 success/null/malformed/throw/postcondition mismatch를 실제 호출로 검증한다", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const loader = fileURLToPath(
    new URL("../telemetry/node-loader.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL("./refund-saga-transition-fault-injection.mts", import.meta.url),
  );
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-loader",
      loader,
      fixture,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.equal(
    run.status,
    0,
    `fault injection failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.match(
    run.stdout,
    /refund saga transition fault injection passed/,
  );
});
