import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parsePlayDollLookup,
  parsePlayDollSignedUrl,
  PlayDollInitError,
} from "../../lib/play-doll-init.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("play doll lookup rejects dependency failure, no-row, and malformed authority rows", () => {
  assert.deepEqual(
    parsePlayDollLookup(
      { image_url: "owner/doll.png", role: "teamlead" },
      null,
    ),
    { image_url: "owner/doll.png", role: "teamlead" },
  );

  for (const [data, error] of [
    [null, new Error("db unavailable")],
    [null, null],
    [{ image_url: "", role: "boss" }, null],
    [{ image_url: " padded ", role: "boss" }, null],
    [{ image_url: "owner/doll.png", role: "unknown" }, null],
  ] as const) {
    assert.throws(
      () => parsePlayDollLookup(data, error),
      PlayDollInitError,
    );
  }
});

test("play signing requires one valid URL and treats explicit missing as unavailable", () => {
  assert.equal(
    parsePlayDollSignedUrl(ID, {
      urls: { [ID]: "https://storage.example.test/doll?token=x" },
      missingIds: [],
    }),
    "https://storage.example.test/doll?token=x",
  );

  for (const value of [
    null,
    {},
    { urls: {}, missingIds: [] },
    { urls: {}, missingIds: [ID] },
    { urls: { [ID]: "javascript:alert(1)" }, missingIds: [] },
  ]) {
    assert.throws(
      () => parsePlayDollSignedUrl(ID, value),
      PlayDollInitError,
    );
  }
});

test("play init exposes retry instead of an endless spinner or custom-doll placeholder", () => {
  const hook = readFileSync(
    new URL("../../app/play/useGameInit.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("../../app/play/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(hook, /\.maybeSingle\(\)/);
  assert.match(hook, /parsePlayDollLookup\(lookup\.data, lookup\.error\)/);
  assert.match(hook, /if \(!response\.ok\)/);
  assert.match(hook, /parsePlayDollSignedUrl/);
  assert.match(hook, /runBoundedClientJsonFetch/);
  assert.match(hook, /loadClientAssetWithDeadline/);
  assert.match(hook, /operationAbort\.abort/);
  assert.match(hook, /setGameInitError\(/);
  assert.match(hook, /onInitialBackgroundReady\(initialBackgroundKey\)/);
  assert.doesNotMatch(hook, /if \(!fullUrl\) return undefined/);
  assert.doesNotMatch(hook, /thumbUrl \?\? fullUrl/);
  assert.doesNotMatch(hook, /play\.doll_texture_fail[\s\S]{0,120}return undefined/);

  assert.match(page, /role="alert"/);
  assert.match(page, /setGameInitAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(page, /!gameReady && !gameInitError/);
});

test("background switching commits UI, telemetry, and URL only after texture success", () => {
  const page = readFileSync(
    new URL("../../app/play/page.tsx", import.meta.url),
    "utf8",
  );
  const load = page.indexOf(
    "const tex = await loadClientAssetWithDeadline",
  );
  const render = page.indexOf("game.setBackground(tex)", load);
  const commit = page.indexOf("appliedBgKeyRef.current = bgKey", render);
  const telemetry = page.indexOf("telemetry.onMapSelect(previousKey, bgKey)", commit);
  const url = page.indexOf("window.history.replaceState", telemetry);
  const rollback = page.indexOf("setBgKey(previousKey)", url);

  assert.ok(load >= 0);
  assert.ok(render > load);
  assert.ok(commit > render);
  assert.ok(telemetry > commit);
  assert.ok(url > telemetry);
  assert.ok(rollback > url);
  assert.match(page, /play\.bg_texture_fail/);
  assert.match(page, /controller\.abort/);
  assert.match(page, /role="status"/);
  assert.doesNotMatch(page, /Assets\.load\(b\.url\)\.catch\(\(\) => undefined\)/);
});
