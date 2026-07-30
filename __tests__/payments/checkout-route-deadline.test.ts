import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { waitForCheckoutDependency } from "../../lib/pay/checkout-dependency-deadline.ts";

test("checkout dependency fence resolves one completed dependency", async () => {
  const controller = new AbortController();
  assert.equal(
    await waitForCheckoutDependency(Promise.resolve("ok"), controller.signal),
    "ok",
  );
});

test("checkout dependency fence finitely rejects a never-settling dependency", async () => {
  const controller = new AbortController();
  const wait = waitForCheckoutDependency(
    new Promise<never>(() => undefined),
    controller.signal,
  );
  controller.abort(new Error("checkout_deadline"));
  await assert.rejects(wait, /checkout_deadline/);
});

test("checkout dependency fence observes a late rejection after timeout", async () => {
  const controller = new AbortController();
  let rejectDependency!: (error: Error) => void;
  const dependency = new Promise<never>((_resolve, reject) => {
    rejectDependency = reject;
  });
  const wait = waitForCheckoutDependency(dependency, controller.signal);
  controller.abort(new Error("checkout_deadline"));
  await assert.rejects(wait, /checkout_deadline/);
  rejectDependency(new Error("late_dependency_failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("checkout route starts one 20s budget before auth and fences every pre-RPC wait", () => {
  const route = readFileSync(
    new URL("../../app/api/pay/checkout/route.ts", import.meta.url),
    "utf8",
  );
  const signal = route.indexOf("const checkoutSignal = AbortSignal.timeout");
  const auth = route.indexOf("waitForCheckoutDependency(\n      requireMember()");
  const body = route.indexOf(
    "waitForCheckoutDependency(\n      readApiJsonObjectRequest(req)",
  );
  const config = route.indexOf(
    "waitForCheckoutDependency(\n      getGrowthLeversStrict()",
  );
  const reviewer = route.indexOf(
    "waitForCheckoutDependency(\n      getReviewerStatus(growth, user)",
  );
  const offer = route.indexOf(".abortSignal(checkoutSignal)", reviewer);
  const rpc = route.indexOf(
    '.rpc("create_or_reuse_pending_order"',
    offer,
  );
  assert.match(
    route,
    /const CHECKOUT_DEPENDENCY_TIMEOUT_MS = 20_000/,
  );
  assert.ok(
    signal >= 0 &&
      auth > signal &&
      body > auth &&
      config > body &&
      reviewer > config &&
      offer > reviewer &&
      rpc > offer,
  );
  assert.ok(
    route.indexOf(".abortSignal(checkoutSignal)", rpc) > rpc,
  );
});
