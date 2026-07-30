import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTelemetryHttpAck,
  telemetryRetryDelayMs,
  TelemetryTransport,
} from "../../lib/telemetry/transport.ts";
import type { TelemetryCollector } from "../../lib/telemetry/collector.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(
  body: unknown,
  options: { status?: number; retryAfter?: string } = {},
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.retryAfter !== undefined) {
    headers.set("retry-after", options.retryAfter);
  }
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

function fakeCollector(eventReads: number[]): TelemetryCollector {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    deviceClass: "desktop-pointer",
    startedAtIso: "2026-07-29T00:00:00.000Z",
    snapshot: () => ({
      seqHigh: 3,
      endedAt: null,
      endReason: null,
      durationMs: 100,
      startMap: null,
      startWeapon: null,
      totals: {
        score: 0,
        hitCount: 0,
        maxCombo: 0,
        ultFireCount: 0,
        distinctWeapons: 0,
        distinctMaps: 0,
        apm: 0,
        tapShare: 0,
        maxTouch: 0,
        dpr: 1,
        refreshHz: 60,
        avgFrameMs: 16,
        p95FrameMs: 20,
      },
      weaponSummary: {},
      mapSummary: {},
      milestones: {
        firstHitMs: null,
        firstSwitchMs: null,
        firstUltMs: null,
        abandonAtMs: null,
      },
    }),
    eventsSince: (lastSeq: number) => {
      eventReads.push(lastSeq);
      return [{ seq: 3, type: "session_end", t: 100 }];
    },
  } as unknown as TelemetryCollector;
}

test("telemetry browser acknowledgement is exact and monotonic-sequence safe", () => {
  const valid = { ok: true, mode: "full", lastSeq: 2 };
  assert.deepEqual(parseTelemetryHttpAck(valid), valid);
  assert.deepEqual(
    parseTelemetryHttpAck({
      ok: true,
      mode: "off",
      reason: "already_finalized",
      lastSeq: 3,
    }),
    {
      ok: true,
      mode: "off",
      reason: "already_finalized",
      lastSeq: 3,
    },
  );
  for (const malformed of [
    null,
    { ok: false, mode: "full", lastSeq: 2 },
    { ok: true, mode: "invalid", lastSeq: 2 },
    { ok: true, mode: "full", lastSeq: -1 },
    { ok: true, mode: "full", lastSeq: 1.5 },
    { ok: true, mode: "full", lastSeq: 2_147_483_648 },
    { ok: true, mode: "full" },
    { ok: true, mode: "full", lastSeq: 2, error: "late_failure" },
    { ok: true, mode: "off", reason: "", lastSeq: 2 },
  ]) {
    assert.equal(parseTelemetryHttpAck(malformed), null);
  }
});

test("telemetry retry delay honors Retry-After within a finite bound", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  assert.equal(telemetryRetryDelayMs(null, now), 10_000);
  assert.equal(telemetryRetryDelayMs("0", now), 1_000);
  assert.equal(telemetryRetryDelayMs("15", now), 15_000);
  assert.equal(telemetryRetryDelayMs("999999999999999999", now), 60_000);
  assert.equal(
    telemetryRetryDelayMs("Thu, 30 Jul 2026 00:00:20 GMT", now),
    20_000,
  );
  assert.equal(telemetryRetryDelayMs("invalid", now), 10_000);
});

test("overlapping forced flushes keep the strongest degrade mode regardless of response order", async () => {
  const originalFetch = globalThis.fetch;
  const first = deferred<Response>();
  const second = deferred<Response>();
  const requests: Array<ReturnType<typeof deferred<Response>>> = [
    first,
    second,
  ];
  let requestCount = 0;
  const eventReads: number[] = [];
  globalThis.fetch = (async () => {
    const request = requests[requestCount];
    requestCount += 1;
    if (!request) throw new Error("unexpected_fetch");
    return request.promise;
  }) as typeof fetch;
  try {
    const transport = new TelemetryTransport(fakeCollector(eventReads));
    const older = transport.flush(null);
    const final = transport.flush("game_over", { force: true });

    second.resolve(
      response({
        ok: true,
        mode: "off",
        reason: "already_finalized",
        lastSeq: 3,
      }),
    );
    await final;

    // The older request is still running. Resolving the forced request must
    // not make an ordinary third flush eligible.
    await transport.flush(null);
    assert.equal(requestCount, 2);

    first.resolve(response({ ok: true, mode: "full", lastSeq: 1 }));
    await older;
    await transport.flush(null);
    assert.equal(requestCount, 3);
    assert.deepEqual(
      eventReads,
      [0, 0],
      "off mode survives stale full response, so the third build omits events",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP errors and malformed 2xx responses never acknowledge telemetry deltas", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    response(
      { ok: true, mode: "off", reason: "fake", lastSeq: 99 },
      { status: 500 },
    ),
    response({ ok: true, mode: "off", lastSeq: 99, error: "late" }),
    response({ ok: true, mode: "full", lastSeq: 2 }),
  ];
  const eventReads: number[] = [];
  let now = 0;
  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected_fetch");
    return next;
  }) as typeof fetch;
  try {
    const transport = new TelemetryTransport(fakeCollector(eventReads), {
      now: () => now,
    });
    await transport.flush(null);
    now += 10_000;
    await transport.flush(null);
    now += 10_000;
    await transport.flush(null);
    assert.deepEqual(eventReads, [0, 0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("503 Retry-After preserves the delta and skips only the bounded retry window", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    response(
      { ok: false, error: "ingest_unavailable" },
      { status: 503, retryAfter: "15" },
    ),
    response({ ok: true, mode: "full", lastSeq: 2 }),
  ];
  const eventReads: number[] = [];
  let now = 0;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    const next = responses.shift();
    if (!next) throw new Error("unexpected_fetch");
    return next;
  }) as typeof fetch;
  try {
    const transport = new TelemetryTransport(fakeCollector(eventReads), {
      now: () => now,
    });
    await transport.flush(null);
    assert.equal(requests, 1);
    assert.deepEqual(eventReads, [0]);

    now = 14_999;
    await transport.flush(null);
    assert.equal(requests, 1, "retry window suppresses a hot-loop request");

    now = 15_000;
    await transport.flush(null);
    assert.equal(requests, 2);
    assert.deepEqual(
      eventReads,
      [0, 0],
      "the unacknowledged delta is rebuilt from the same sequence",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
