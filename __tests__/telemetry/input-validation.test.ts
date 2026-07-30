// Public telemetry input boundary tests.
// Run directly because package.json ownership is outside this QA slice:
//   node --test __tests__/telemetry/input-validation.test.ts
// Node 22.6~22.17:
//   node --experimental-strip-types --test __tests__/telemetry/input-validation.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Next's bundler normally resolves aliases, extensionless TS imports, and server-only.
// Reproduce only those resolution rules so Node's dependency-free test runner can load the real modules.
register("./node-loader.mjs", import.meta.url);

const {
  POSTGRES_INT_MIN,
  POSTGRES_INT_MAX,
  TELEMETRY_TIMESTAMP_FUTURE_SKEW_MS,
  TELEMETRY_TIMESTAMP_MAX_AGE_MS,
  inspectTelemetryContentLength,
  parseTelemetryIngestAck,
  readTelemetryRequestBody,
  sanitizePayload,
} = await import("../../lib/telemetry/validate.ts");
const { MAX_PAYLOAD_BYTES } = await import("../../lib/telemetry/budget.ts");
const { POST } = await import("../../app/api/telemetry/route.ts");

const NOW_MS = Date.parse("2026-07-29T12:00:00.000Z");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function validPayload(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    deviceClass: "desktop-pointer",
    startedAt: new Date(NOW_MS).toISOString(),
    summary: {
      seqHigh: 1,
      endedAt: null,
      endReason: null,
      durationMs: 100,
    },
    events: [{ seq: 1, type: "session_start", t: 0 }],
  };
}

function summaryOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.summary as Record<string, unknown>;
}

test("normal collector payload keeps the existing client contract", () => {
  const result = sanitizePayload(validPayload(), { nowMs: NOW_MS });
  assert.ok(result);
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.startedAt, "2026-07-29T12:00:00.000Z");
  assert.equal(result.summary.seqHigh, 1);
  assert.equal(result.summary.endedAt, null);
  assert.equal(result.events[0]?.seq, 1);
});

test("ingest RPC acknowledgement rejects null, partial, and type-confused success", () => {
  const valid = {
    ok: true,
    mode: "full",
    reason: null,
    lastSeq: POSTGRES_INT_MAX,
  };
  assert.deepEqual(parseTelemetryIngestAck(valid), valid);
  for (const malformed of [
    null,
    {},
    { mode: "full" },
    { ok: true },
    { ok: "true", mode: "full" },
    { ok: true, mode: "unknown" },
    { ok: true, mode: "full", reason: 1 },
    { ok: true, mode: "full", lastSeq: -1 },
    { ok: true, mode: "full", lastSeq: 1.5 },
    { ok: true, mode: "full", lastSeq: POSTGRES_INT_MAX + 1 },
  ]) {
    assert.equal(parseTelemetryIngestAck(malformed), null);
  }
});

test("every discrete summary/RPC integer is normalized before PostgreSQL casts", () => {
  const payload = validPayload();
  const summary = summaryOf(payload);
  summary.durationMs = 100.6;
  summary.totals = {
    score: 10.6,
    hitCount: 2.4,
    maxCombo: 1.6,
    ultFireCount: 0.6,
    distinctWeapons: 1.6,
    distinctMaps: 1.4,
    apm: 5.6,
    tapShare: 0.25,
    maxTouch: 1.6,
    dpr: 2.5,
    refreshHz: 59.6,
    avgFrameMs: 16.67,
    p95FrameMs: 20.5,
  };
  summary.weaponSummary = {
    fist: { hits: 2.4, score: 10.6, attempts: 1.6, switches: 0.6 },
  };
  const result = sanitizePayload(payload, { nowMs: NOW_MS });
  assert.ok(result);
  assert.equal(result.summary.durationMs, 101);
  assert.deepEqual(
    {
      score: result.summary.totals.score,
      hitCount: result.summary.totals.hitCount,
      maxCombo: result.summary.totals.maxCombo,
      ultFireCount: result.summary.totals.ultFireCount,
      distinctWeapons: result.summary.totals.distinctWeapons,
      distinctMaps: result.summary.totals.distinctMaps,
      apm: result.summary.totals.apm,
      maxTouch: result.summary.totals.maxTouch,
      refreshHz: result.summary.totals.refreshHz,
    },
    {
      score: 11,
      hitCount: 2,
      maxCombo: 2,
      ultFireCount: 1,
      distinctWeapons: 2,
      distinctMaps: 1,
      apm: 6,
      maxTouch: 2,
      refreshHz: 60,
    },
  );
  assert.deepEqual(result.summary.weaponSummary.fist, {
    hits: 2,
    score: 11,
    attempts: 2,
    switches: 1,
  });
  assert.equal(result.summary.totals.dpr, 2.5);
  assert.equal(result.summary.totals.avgFrameMs, 16.67);
});

test("event seq accepts every sampled PostgreSQL integer unchanged, including both boundaries", () => {
  const values = [POSTGRES_INT_MIN, 0, POSTGRES_INT_MAX];
  let seed = 0x6d2b79f5;
  for (let i = 0; i < 256; i += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    values.push(seed - 0x80000000);
  }

  for (const seq of values) {
    const payload = validPayload();
    payload.events = [{ seq, type: "session_start", t: 0 }];
    const result = sanitizePayload(payload, { nowMs: NOW_MS });
    assert.ok(result, `seq=${seq}`);
    assert.equal(result.events.length, 1, `seq=${seq}`);
    assert.equal(result.events[0]?.seq, seq, `seq=${seq}`);
  }
});

test("event seq outside PostgreSQL integer or non-integral is dropped instead of rounded/cast", () => {
  const invalidValues: unknown[] = [
    POSTGRES_INT_MIN - 1,
    POSTGRES_INT_MAX + 1,
    -0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "1",
    null,
  ];
  for (const seq of invalidValues) {
    const payload = validPayload();
    payload.events = [{ seq, type: "session_start", t: 0 }];
    const result = sanitizePayload(payload, { nowMs: NOW_MS });
    assert.ok(result);
    assert.deepEqual(result.events, [], `seq=${String(seq)}`);
  }
});

test("seqHigh is a non-negative PostgreSQL integer and invalid values reject the payload", () => {
  for (const seqHigh of [0, POSTGRES_INT_MAX]) {
    const payload = validPayload();
    summaryOf(payload).seqHigh = seqHigh;
    const result = sanitizePayload(payload, { nowMs: NOW_MS });
    assert.ok(result);
    assert.equal(result.summary.seqHigh, seqHigh);
  }

  const invalidValues: unknown[] = [
    -1,
    POSTGRES_INT_MAX + 1,
    1.25,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    null,
  ];
  for (const seqHigh of invalidValues) {
    const payload = validPayload();
    summaryOf(payload).seqHigh = seqHigh;
    assert.equal(
      sanitizePayload(payload, { nowMs: NOW_MS }),
      null,
      `seqHigh=${String(seqHigh)}`,
    );
  }
});

test("startedAt accepts both server-window boundaries and rejects one millisecond outside", () => {
  const cases = [
    { delta: -TELEMETRY_TIMESTAMP_MAX_AGE_MS, accepted: true },
    { delta: -TELEMETRY_TIMESTAMP_MAX_AGE_MS - 1, accepted: false },
    { delta: TELEMETRY_TIMESTAMP_FUTURE_SKEW_MS, accepted: true },
    { delta: TELEMETRY_TIMESTAMP_FUTURE_SKEW_MS + 1, accepted: false },
  ];
  for (const { delta, accepted } of cases) {
    const payload = validPayload();
    payload.startedAt = new Date(NOW_MS + delta).toISOString();
    assert.equal(Boolean(sanitizePayload(payload, { nowMs: NOW_MS })), accepted, `delta=${delta}`);
  }
});

test("valid offset ISO timestamps normalize to UTC while malformed calendar/time forms reject", () => {
  const offsetPayload = validPayload();
  offsetPayload.startedAt = "2026-07-29T21:00:00+09:00";
  const normalized = sanitizePayload(offsetPayload, { nowMs: NOW_MS });
  assert.ok(normalized);
  assert.equal(normalized.startedAt, "2026-07-29T12:00:00.000Z");

  const invalidValues: unknown[] = [
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-07-29",
    "2026-07-29 12:00:00Z",
    "2026-07-29T12:00:00",
    "2026-07-29T24:00:00Z",
    "2026-07-29T12:60:00Z",
    "2026-07-29T12:00:60Z",
    "2026-07-29T12:00:00+24:00",
    "not-a-date",
    1_722_251_200_000,
  ];
  for (const startedAt of invalidValues) {
    const payload = validPayload();
    payload.startedAt = startedAt;
    assert.equal(
      sanitizePayload(payload, { nowMs: NOW_MS }),
      null,
      `startedAt=${String(startedAt)}`,
    );
  }
});

test("endedAt must be valid, in the server window, and not precede startedAt", () => {
  const equalPayload = validPayload();
  summaryOf(equalPayload).endedAt = new Date(NOW_MS).toISOString();
  assert.ok(sanitizePayload(equalPayload, { nowMs: NOW_MS }));

  const earlierPayload = validPayload();
  summaryOf(earlierPayload).endedAt = new Date(NOW_MS - 1).toISOString();
  assert.equal(sanitizePayload(earlierPayload, { nowMs: NOW_MS }), null);

  const tooFuturePayload = validPayload();
  summaryOf(tooFuturePayload).endedAt = new Date(
    NOW_MS + TELEMETRY_TIMESTAMP_FUTURE_SKEW_MS + 1,
  ).toISOString();
  assert.equal(sanitizePayload(tooFuturePayload, { nowMs: NOW_MS }), null);

  for (const endedAt of ["", "2026-02-29T12:00:00Z", 123]) {
    const payload = validPayload();
    summaryOf(payload).endedAt = endedAt;
    assert.equal(sanitizePayload(payload, { nowMs: NOW_MS }), null);
  }
});

test("Content-Length inspection is exact at 64KB and handles unbounded decimal input", () => {
  assert.equal(inspectTelemetryContentLength(null), "ok");
  assert.equal(inspectTelemetryContentLength("0"), "ok");
  assert.equal(inspectTelemetryContentLength(String(MAX_PAYLOAD_BYTES)), "ok");
  assert.equal(inspectTelemetryContentLength(`000${MAX_PAYLOAD_BYTES}`), "ok");
  assert.equal(inspectTelemetryContentLength(String(MAX_PAYLOAD_BYTES + 1)), "too_large");
  assert.equal(inspectTelemetryContentLength("9".repeat(1_000)), "too_large");
  for (const invalid of ["", "-1", "+1", "1.5", "1, 2"]) {
    assert.equal(inspectTelemetryContentLength(invalid), "invalid", invalid);
  }
});

test("stream reader enforces UTF-8 bytes, not JavaScript string length", async () => {
  for (const bytes of [MAX_PAYLOAD_BYTES - 1, MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES + 1]) {
    const body = "a".repeat(bytes);
    const result = await readTelemetryRequestBody(
      new Request("http://localhost/api/telemetry", { method: "POST", body }),
    );
    assert.equal(result.ok, bytes <= MAX_PAYLOAD_BYTES, `ASCII bytes=${bytes}`);
  }

  const koreanWithin = "가".repeat(Math.floor(MAX_PAYLOAD_BYTES / 3));
  const within = await readTelemetryRequestBody(
    new Request("http://localhost/api/telemetry", { method: "POST", body: koreanWithin }),
  );
  assert.deepEqual(within, { ok: true, text: koreanWithin });

  const koreanOver = "가".repeat(Math.floor(MAX_PAYLOAD_BYTES / 3) + 1);
  assert.ok(koreanOver.length < MAX_PAYLOAD_BYTES, "old UTF-16 length check would have accepted this");
  const over = await readTelemetryRequestBody(
    new Request("http://localhost/api/telemetry", { method: "POST", body: koreanOver }),
  );
  assert.deepEqual(over, { ok: false, error: "payload_too_large" });
});

test("invalid UTF-8 is rejected as bad_body", async () => {
  const result = await readTelemetryRequestBody(
    new Request("http://localhost/api/telemetry", {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28]),
    }),
  );
  assert.deepEqual(result, { ok: false, error: "bad_body" });
});

test("locked or otherwise unreadable body streams are rejected as bad_body", async () => {
  const request = new Request("http://localhost/api/telemetry", {
    method: "POST",
    body: "{}",
  });
  const lock = request.body?.getReader();
  assert.ok(lock);
  try {
    assert.deepEqual(await readTelemetryRequestBody(request), { ok: false, error: "bad_body" });
  } finally {
    lock.releaseLock();
  }
});

test("route returns 413 from Content-Length before reading body or reaching auth/DB", async () => {
  let bodyAccessed = false;
  const request = {
    headers: new Headers({ "content-length": String(MAX_PAYLOAD_BYTES + 1) }),
    get body() {
      bodyAccessed = true;
      throw new Error("body must not be read");
    },
  };
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  assert.equal(response.status, 413);
  assert.equal(bodyAccessed, false);
  assert.deepEqual(await response.json(), { ok: false, error: "payload_too_large" });
});

test("route applies actual UTF-8 byte cap and accepts the exact cap into JSON parsing", async () => {
  const overResponse = await POST(
    new Request("http://localhost/api/telemetry", {
      method: "POST",
      body: "가".repeat(Math.floor(MAX_PAYLOAD_BYTES / 3) + 1),
    }) as Parameters<typeof POST>[0],
  );
  assert.equal(overResponse.status, 413);
  assert.deepEqual(await overResponse.json(), { ok: false, error: "payload_too_large" });

  // Exact-cap whitespace is intentionally invalid JSON. A 400 proves the byte boundary itself was accepted.
  const exactResponse = await POST(
    new Request("http://localhost/api/telemetry", {
      method: "POST",
      body: " ".repeat(MAX_PAYLOAD_BYTES),
    }) as Parameters<typeof POST>[0],
  );
  assert.equal(exactResponse.status, 400);
  assert.deepEqual(await exactResponse.json(), { ok: false, error: "bad_json" });
});
