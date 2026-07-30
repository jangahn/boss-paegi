import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTONE_PAYMENT_WINDOW_TIMEOUT_MS,
  waitForPortOnePayment,
} from "../../lib/pay/client-portone-payment.ts";

test("PortOne payment wait returns one completed SDK result", async () => {
  let calls = 0;
  const request = (() => {
    calls += 1;
    return Promise.resolve({ code: undefined });
  })();
  assert.deepEqual(await waitForPortOnePayment(request), {
    kind: "completed",
    value: { code: undefined },
  });
  assert.equal(calls, 1);
  assert.equal(PORTONE_PAYMENT_WINDOW_TIMEOUT_MS, 10 * 60 * 1_000);
});

test("PortOne payment wait finitely resolves a never-settling SDK call", async () => {
  const never = new Promise<never>(() => undefined);
  assert.deepEqual(
    await waitForPortOnePayment(never, { timeoutMs: 5 }),
    { kind: "timeout" },
  );
});

test("PortOne payment wait observes lifecycle cancellation without replay", async () => {
  const controller = new AbortController();
  const never = new Promise<never>(() => undefined);
  const waiting = waitForPortOnePayment(never, {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  controller.abort(new DOMException("unmounted", "AbortError"));
  assert.deepEqual(await waiting, { kind: "cancelled" });
  assert.deepEqual(
    await waitForPortOnePayment(never, {
      signal: controller.signal,
    }),
    { kind: "cancelled" },
  );
});

test("PortOne payment wait rejects invalid limits and SDK failures", async () => {
  await assert.rejects(
    waitForPortOnePayment(Promise.resolve({}), { timeoutMs: 0 }),
    /invalid_portone_payment_timeout/,
  );
  await assert.rejects(
    waitForPortOnePayment(Promise.reject(new Error("sdk_failed"))),
    /sdk_failed/,
  );
});
