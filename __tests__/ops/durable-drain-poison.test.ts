import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("durable drain poison-row fault injection passes under the Next alias loader", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = fileURLToPath(
    new URL("./durable-drain-poison-fixture.mts", import.meta.url),
  );
  const loader = fileURLToPath(
    new URL("../telemetry/node-loader.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--loader",
      loader,
      "--test",
      fixture,
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
});
