import assert from "node:assert/strict";
import test from "node:test";
import {
  ORDER_STATUS_POLL_MAX_RESPONSE_BYTES,
  pollClientOrderStatus,
} from "../../lib/pay/client-order-status-poll.ts";

const ORDER = "00000000-0000-4000-8000-000000000001";

function snapshot(
  status: "pending" | "paid" | "paid_review" | "canceled" | "failed",
) {
  return {
    status,
    credits: 3,
    amount: 1_000,
    productId: "credits_3",
  };
}

test("client order polling maps every authoritative terminal status", async () => {
  const cases = [
    ["paid", { status: "paid", credits: 3 }],
    ["paid_review", { status: "review" }],
    ["canceled", { status: "error" }],
    ["failed", { status: "error" }],
  ] as const;
  for (const [status, expected] of cases) {
    const outcome = await pollClientOrderStatus(ORDER, {
      signal: new AbortController().signal,
      fetcher: async () => Response.json(snapshot(status)),
    });
    assert.deepEqual(outcome, expected, status);
  }
});

test("client order polling is single-flight and stops after paid convergence", async () => {
  const statuses = ["pending", "pending", "paid"] as const;
  let calls = 0;
  let waits = 0;
  let active = 0;
  let maxActive = 0;
  const outcome = await pollClientOrderStatus(ORDER, {
    signal: new AbortController().signal,
    fetcher: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const status = statuses[calls++]!;
      await Promise.resolve();
      active -= 1;
      return Response.json(snapshot(status));
    },
    wait: async () => {
      waits += 1;
    },
  });
  assert.deepEqual(outcome, { status: "paid", credits: 3 });
  assert.equal(maxActive, 1);
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test("client order polling bounds malformed and transient responses", async () => {
  for (const response of [
    () => Response.json({ nope: true }),
    () => Response.json({ error: "unavailable" }, { status: 503 }),
  ]) {
    let calls = 0;
    const outcome = await pollClientOrderStatus(ORDER, {
      signal: new AbortController().signal,
      fetcher: async () => {
        calls += 1;
        return response();
      },
      wait: async () => {},
      maxAttempts: 3,
    });
    assert.deepEqual(outcome, { status: "pending" });
    assert.equal(calls, 3);
  }
});

test("client order polling never buffers over 64 KiB and rejects invalid UTF-8", async () => {
  assert.equal(ORDER_STATUS_POLL_MAX_RESPONSE_BYTES, 64 * 1024);
  const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]);
  for (const response of [
    () =>
      new Response(
        new Uint8Array(ORDER_STATUS_POLL_MAX_RESPONSE_BYTES + 1),
      ),
    () =>
      new Response(new Uint8Array(), {
        headers: {
          "content-length": String(
            ORDER_STATUS_POLL_MAX_RESPONSE_BYTES + 1,
          ),
        },
      }),
    () => new Response(invalidUtf8),
  ]) {
    let calls = 0;
    const outcome = await pollClientOrderStatus(ORDER, {
      signal: new AbortController().signal,
      fetcher: async () => {
        calls += 1;
        return response();
      },
      wait: async () => {},
      maxAttempts: 2,
    });
    assert.deepEqual(outcome, { status: "pending" });
    assert.equal(calls, 2);
  }
});

test("client order polling deadline cancels a never-ending 200 response body", async () => {
  let cancelled = false;
  let calls = 0;
  const outcome = await pollClientOrderStatus(ORDER, {
    signal: new AbortController().signal,
    fetcher: async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
    wait: async () => {},
    requestTimeoutMs: 5,
    maxAttempts: 1,
  });
  assert.deepEqual(outcome, { status: "pending" });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("client order polling treats invalid or inaccessible orders as terminal", async () => {
  let calls = 0;
  const invalid = await pollClientOrderStatus("not-an-order", {
    signal: new AbortController().signal,
    fetcher: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  assert.deepEqual(invalid, { status: "error" });
  assert.equal(calls, 0);

  for (const status of [400, 401, 403, 404]) {
    const outcome = await pollClientOrderStatus(ORDER, {
      signal: new AbortController().signal,
      fetcher: async () => Response.json({}, { status }),
    });
    assert.deepEqual(outcome, { status: "error" }, String(status));
  }
});

test("client order polling aborts an in-flight request on unmount", async () => {
  const controller = new AbortController();
  let requestAborted = false;
  const outcomePromise = pollClientOrderStatus(ORDER, {
    signal: controller.signal,
    fetcher: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            reject(init.signal?.reason);
          },
          { once: true },
        );
      }),
  });
  controller.abort(new DOMException("unmounted", "AbortError"));
  assert.deepEqual(await outcomePromise, { status: "cancelled" });
  assert.equal(requestAborted, true);
});
