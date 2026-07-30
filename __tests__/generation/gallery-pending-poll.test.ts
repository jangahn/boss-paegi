import assert from "node:assert/strict";
import test from "node:test";
import {
  pollGalleryPendingGenerations,
} from "../../lib/gallery-pending-poll.ts";

const ID = "00000000-0000-4000-8000-000000000001";

function pending(kind: "generating" | "ready" | "interrupted") {
  return {
    pending: [
      {
        id: ID,
        kind,
        candidateUrls:
          kind === "ready"
            ? ["https://example.com/1.png"]
            : [],
        createdAt: "2026-07-30T00:00:00.000Z",
        role: "boss",
      },
    ],
  };
}

test("gallery polling is single-flight and stops on the first terminal snapshot", async () => {
  const snapshots = [
    pending("generating"),
    pending("generating"),
    pending("ready"),
  ];
  const seen: string[] = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let waits = 0;
  const outcome = await pollGalleryPendingGenerations({
    signal: new AbortController().signal,
    fetcher: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const body = snapshots[calls++]!;
      await Promise.resolve();
      active -= 1;
      return Response.json(body);
    },
    wait: async () => {
      waits += 1;
    },
    onRows: (rows) => seen.push(rows[0]!.kind),
    onError: () => assert.fail("unexpected polling error"),
  });

  assert.equal(outcome, "terminal");
  assert.equal(maxActive, 1);
  assert.equal(calls, 3);
  assert.equal(waits, 2);
  assert.deepEqual(seen, ["generating", "generating", "ready"]);
});

test("gallery polling stops at the exact elapsed boundary", async () => {
  let clock = 0;
  let calls = 0;
  const outcome = await pollGalleryPendingGenerations({
    signal: new AbortController().signal,
    fetcher: async () => {
      calls += 1;
      return Response.json(pending("generating"));
    },
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    intervalMs: 4,
    maxElapsedMs: 8,
    onRows: () => {},
    onError: () => assert.fail("unexpected polling error"),
  });
  assert.equal(outcome, "timeout");
  assert.equal(calls, 2);
});

test("gallery polling bounds consecutive response failures", async () => {
  let calls = 0;
  let errors = 0;
  const outcome = await pollGalleryPendingGenerations({
    signal: new AbortController().signal,
    fetcher: async () => {
      calls += 1;
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
    wait: async () => {},
    consecutiveFailureLimit: 3,
    onRows: () => assert.fail("unexpected rows"),
    onError: () => {
      errors += 1;
    },
  });
  assert.equal(outcome, "unavailable");
  assert.equal(calls, 3);
  assert.equal(errors, 3);
});

test("gallery polling cancellation aborts a live request without publishing rows", async () => {
  const controller = new AbortController();
  let published = false;
  let requestAborted = false;
  const outcomePromise = pollGalleryPendingGenerations({
    signal: controller.signal,
    fetcher: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            reject(init?.signal?.reason);
          },
          { once: true },
        );
      }),
    requestTimeoutMs: 1_000,
    onRows: () => {
      published = true;
    },
    onError: () => assert.fail("unexpected polling error"),
  });
  controller.abort(new DOMException("unmounted", "AbortError"));
  const outcome = await outcomePromise;
  assert.equal(outcome, "cancelled");
  assert.equal(requestAborted, true);
  assert.equal(published, false);
});

test("gallery polling closes the abort-before-listener race without starting late work", async () => {
  let abortedReads = 0;
  let fetchSawAborted = false;
  const raceSignal = {
    get aborted() {
      abortedReads += 1;
      return abortedReads >= 2;
    },
    get reason() {
      return new DOMException("unmounted", "AbortError");
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  const outcome = await pollGalleryPendingGenerations({
    signal: raceSignal,
    fetcher: async (_input, init) => {
      fetchSawAborted = init?.signal?.aborted === true;
      throw init?.signal?.reason;
    },
    requestTimeoutMs: 1_000,
    onRows: () => assert.fail("unexpected rows"),
    onError: () => assert.fail("unexpected polling error"),
  });
  assert.equal(outcome, "cancelled");
  assert.equal(fetchSawAborted, false);
});

test("gallery polling bounds non-cooperative transport and never-ending JSON bodies", async () => {
  for (const [label, fetcher] of [
    [
      "transport",
      async () => new Promise<Response>(() => {}),
    ],
    [
      "body",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"pending":['));
            },
          }),
          { status: 200 },
        ),
    ],
  ] as const) {
    let errors = 0;
    const startedAt = performance.now();
    const outcome = await pollGalleryPendingGenerations({
      signal: new AbortController().signal,
      fetcher,
      wait: async () => {},
      requestTimeoutMs: 10,
      consecutiveFailureLimit: 1,
      onRows: () => assert.fail(`${label}: unexpected rows`),
      onError: () => {
        errors += 1;
      },
    });
    assert.equal(outcome, "unavailable", label);
    assert.equal(errors, 1, label);
    assert.ok(performance.now() - startedAt < 500, label);
  }
});

test("gallery polling uses a nondecreasing elapsed clock", async () => {
  const clock = [100, 100, 50, 40, 200];
  let calls = 0;
  const outcome = await pollGalleryPendingGenerations({
    signal: new AbortController().signal,
    fetcher: async () => {
      calls += 1;
      return Response.json(pending("generating"));
    },
    wait: async () => {},
    now: () => clock.shift() ?? 200,
    maxElapsedMs: 100,
    onRows: () => {},
    onError: () => assert.fail("unexpected polling error"),
  });
  assert.equal(outcome, "timeout");
  assert.equal(calls, 2);
});
