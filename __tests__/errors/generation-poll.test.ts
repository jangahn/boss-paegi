import assert from "node:assert/strict";
import test from "node:test";
import { pollGeneration } from "../../lib/generation-poll.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-07-29T00:00:00.000Z";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(
  kind: "generating" | "ready" | "interrupted",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: ID,
    kind,
    candidateUrls:
      kind === "ready" ? ["https://storage.example.test/a?token=x"] : [],
    createdAt: CREATED_AT,
    role: "boss",
    ...overrides,
  };
}

const noWait = async () => {};

test("poll returns only strictly parsed ready and interrupted terminal states", async () => {
  assert.deepEqual(
    await pollGeneration(ID, () => false, {
      fetcher: async () =>
        jsonResponse(200, { pending: [row("ready", { role: "exec" })] }),
      wait: noWait,
    }),
    {
      status: "ready",
      urls: ["https://storage.example.test/a?token=x"],
      role: "exec",
    },
  );
  assert.deepEqual(
    await pollGeneration(ID, () => false, {
      fetcher: async () =>
        jsonResponse(200, {
          pending: [row("interrupted", { reason: "photo" })],
        }),
      wait: noWait,
    }),
    { status: "interrupted", reason: "photo" },
  );
});

test("four consecutive HTTP, transport, JSON, or shape failures become unavailable", async () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["http", async () => jsonResponse(503, { error: "unavailable" })],
    ["transport", async () => {
      throw new Error("network down");
    }],
    ["json", async () => new Response("{", { status: 200 })],
    [
      "shape",
      async () =>
        jsonResponse(200, {
          pending: [row("ready", { role: undefined })],
        }),
    ],
  ];

  for (const [label, response] of cases) {
    let calls = 0;
    const result = await pollGeneration(ID, () => false, {
      fetcher: async () => {
        calls += 1;
        return response();
      },
      wait: noWait,
    });
    assert.deepEqual(result, { status: "unavailable" }, label);
    assert.equal(calls, 4, label);
  }
});

test("four consecutive 401 responses are distinguished as unauthorized", async () => {
  let calls = 0;
  const result = await pollGeneration(ID, () => false, {
    fetcher: async () => {
      calls += 1;
      return jsonResponse(401, { error: "member_only" });
    },
    wait: noWait,
  });
  assert.deepEqual(result, { status: "unauthorized" });
  assert.equal(calls, 4);
});

test("a valid authority response resets the consecutive failure budget", async () => {
  const responses = [
    jsonResponse(503, {}),
    jsonResponse(503, {}),
    jsonResponse(503, {}),
    jsonResponse(200, { pending: [row("generating")] }),
    jsonResponse(503, {}),
    jsonResponse(503, {}),
    jsonResponse(503, {}),
    jsonResponse(200, { pending: [row("ready")] }),
  ];
  const result = await pollGeneration(ID, () => false, {
    fetcher: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    wait: noWait,
  });
  assert.equal(result.status, "ready");
  assert.equal(responses.length, 0);
});

test("visible timeout is bounded while background time does not consume the budget", async () => {
  let visibleNow = 0;
  let visibleCalls = 0;
  const timedOut = await pollGeneration(ID, () => false, {
    fetcher: async () => {
      visibleCalls += 1;
      return jsonResponse(200, { pending: [row("generating")] });
    },
    wait: noWait,
    now: () => {
      visibleNow += 100;
      return visibleNow;
    },
    isVisible: () => true,
    maxVisibleMs: 50,
  });
  assert.deepEqual(timedOut, { status: "timeout" });
  assert.equal(visibleCalls, 1);

  const backgroundResponses = [
    jsonResponse(200, { pending: [row("generating")] }),
    jsonResponse(200, { pending: [row("ready")] }),
  ];
  let backgroundNow = 0;
  const ready = await pollGeneration(ID, () => false, {
    fetcher: async () => {
      const response = backgroundResponses.shift();
      assert.ok(response);
      return response;
    },
    wait: noWait,
    now: () => {
      backgroundNow += 1_000_000;
      return backgroundNow;
    },
    isVisible: () => false,
    maxVisibleMs: 1,
  });
  assert.equal(ready.status, "ready");
});

test("each generation recovery request bounds non-cooperative transport and body streams", async () => {
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
    const startedAt = performance.now();
    const result = await pollGeneration(ID, () => false, {
      fetcher,
      wait: noWait,
      requestTimeoutMs: 10,
      consecutiveFailureLimit: 1,
    });
    assert.deepEqual(result, { status: "unavailable" }, label);
    assert.ok(performance.now() - startedAt < 500, label);
  }
});

test("invalid ids, cancellation, and invalid options stop without unsafe polling", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return jsonResponse(200, { pending: [] });
  };
  assert.deepEqual(
    await pollGeneration("not-a-uuid", () => false, {
      fetcher,
      wait: noWait,
    }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await pollGeneration(ID, () => true, { fetcher, wait: noWait }),
    { status: "timeout" },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    pollGeneration(ID, () => false, {
      fetcher,
      wait: noWait,
      consecutiveFailureLimit: 0,
    }),
    /invalid_generation_poll_options/,
  );
});
