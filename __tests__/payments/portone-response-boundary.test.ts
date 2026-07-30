import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  PORTONE_RESPONSE_MAX_BODY_BYTES,
  cancelPortonePaymentPartial,
  getPortonePaymentSnapshot,
} = await import("../../lib/portone.ts");

const PAYMENT_ID = "11111111111141118111111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "store_boss_paegi";

test("PortOne GET and cancel responses are bounded before JSON parsing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(
            PORTONE_RESPONSE_MAX_BODY_BYTES + 1,
          ),
        },
      })) as typeof fetch;
    assert.deepEqual(await getPortonePaymentSnapshot(PAYMENT_ID, STORE_ID), {
      ok: false,
      kind: "error",
      error: "bad_payload",
    });

    globalThis.fetch = (async () =>
      new Response(
        new Uint8Array(PORTONE_RESPONSE_MAX_BODY_BYTES + 1),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    assert.deepEqual(await getPortonePaymentSnapshot(PAYMENT_ID, STORE_ID), {
      ok: false,
      kind: "error",
      error: "bad_payload",
    });

    globalThis.fetch = (async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("broken upstream"));
          },
        }),
      }) as Response) as typeof fetch;
    assert.deepEqual(await getPortonePaymentSnapshot(PAYMENT_ID, STORE_ID), {
      ok: false,
      kind: "unreachable",
      error: "request_exception",
    });

    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(
            PORTONE_RESPONSE_MAX_BODY_BYTES + 1,
          ),
        },
      })) as typeof fetch;
    assert.deepEqual(
      await cancelPortonePaymentPartial({
        paymentId: PAYMENT_ID,
        storeId: STORE_ID,
        attemptId: ATTEMPT_ID,
        amount: 1000,
        currentCancellableAmount: 3000,
      }),
      {
        ok: false,
        kind: "outstanding",
        error: "bad_payload",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PortOne GET and cancel are pinned to the immutable order store", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  try {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify({ type: "INVALID_REQUEST", message: "fixture" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({ type: "PAYMENT_NOT_FOUND", message: "fixture" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    assert.deepEqual(await getPortonePaymentSnapshot(PAYMENT_ID, STORE_ID), {
      ok: false,
      kind: "not_found",
      error: "payment_not_found",
    });
    assert.equal(new URL(calls[0]!.url).searchParams.get("storeId"), STORE_ID);

    assert.deepEqual(
      await cancelPortonePaymentPartial({
        paymentId: PAYMENT_ID,
        storeId: STORE_ID,
        attemptId: ATTEMPT_ID,
        amount: 1000,
        currentCancellableAmount: 3000,
      }),
      {
        ok: false,
        kind: "hard_reject",
        error: "INVALID_REQUEST",
      },
    );
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
      storeId: STORE_ID,
      amount: 1000,
      reason: `BP_REFUND:${ATTEMPT_ID}`,
      currentCancellableAmount: 3000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
