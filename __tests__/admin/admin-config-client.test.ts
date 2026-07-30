import assert from "node:assert/strict";
import test from "node:test";

import { submitAdminConfigMutation } from "../../lib/admin-config-client.ts";

const BODY = {
  key: "growth_levers",
  value: { creditsEnabled: false },
  baseVersion: 4,
};

test("config response loss replays the byte-identical deterministic payload", async () => {
  const bodies: string[] = [];
  let calls = 0;
  const result = await submitAdminConfigMutation({
    body: BODY,
    baseVersion: 4,
    deadlineMs: 100,
    attemptMs: 50,
    fetcher: async (_input, init) => {
      calls += 1;
      bodies.push(String(init?.body));
      if (calls === 1) throw new TypeError("response_lost");
      return Response.json({ ok: true, version: 5 });
    },
  });
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    ack: { ok: true, version: 5 },
    error: null,
    unconfirmed: false,
  });
  assert.equal(calls, 2);
  assert.equal(bodies[0], JSON.stringify(BODY));
  assert.equal(bodies[1], bodies[0]);
});

test("malformed 2xx is replayed but never guessed successful", async () => {
  let calls = 0;
  const result = await submitAdminConfigMutation({
    body: BODY,
    baseVersion: 4,
    deadlineMs: 100,
    attemptMs: 50,
    fetcher: async () => {
      calls += 1;
      return Response.json({ ok: true, version: 6 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unconfirmed, true);
  assert.equal(result.error, "result_unconfirmed");
  assert.equal(calls, 2);
});

test("definitive config conflicts are not replayed", async () => {
  let calls = 0;
  const result = await submitAdminConfigMutation({
    body: BODY,
    baseVersion: 4,
    deadlineMs: 100,
    attemptMs: 50,
    fetcher: async () => {
      calls += 1;
      return Response.json({ error: "version_conflict" }, { status: 409 });
    },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    ack: null,
    error: "version_conflict",
    unconfirmed: false,
  });
  assert.equal(calls, 1);
});

test("a never-resolving config publication releases the caller deadline", async () => {
  const result = await submitAdminConfigMutation({
    body: BODY,
    baseVersion: 4,
    deadlineMs: 40,
    attemptMs: 10,
    fetcher: () => new Promise<Response>(() => {}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.unconfirmed, true);
  assert.equal(result.error, "result_unconfirmed");
});
