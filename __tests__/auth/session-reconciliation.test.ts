import assert from "node:assert/strict";
import test from "node:test";

import { runClientMutation } from "../../lib/client-mutation.ts";
import {
  SESSION_RECONCILIATION_CHANNEL,
  acquireSessionReconciliation,
  createSessionReconciliationController,
} from "../../lib/session-reconciliation.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function createManualDeferred() {
  const jobs: Array<{ active: boolean; callback: () => void }> = [];
  return {
    defer(callback: () => void) {
      const job = { active: true, callback };
      jobs.push(job);
      return () => {
        job.active = false;
      };
    },
    async flush() {
      while (jobs.length > 0) {
        const job = jobs.shift();
        if (job?.active) job.callback();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test("bootstrap auth events establish one stable baseline without self-invalidation", async () => {
  const deferred = createManualDeferred();
  let currentUserId: string | null = USER_A;
  let reads = 0;
  let broadcasts = 0;
  const invalidations: unknown[] = [];
  const controller = createSessionReconciliationController({
    readCurrentUserId: async () => {
      reads += 1;
      return currentUserId;
    },
    invalidate: (value) => invalidations.push(value),
    broadcastHint: () => {
      broadcasts += 1;
    },
    defer: deferred.defer,
  });

  controller.notifyAuthChange("INITIAL_SESSION", null);
  controller.notifyAuthChange("SIGNED_IN", USER_A);
  assert.deepEqual(controller.getState(), {
    phase: "bootstrapping",
  });
  assert.equal(broadcasts, 0);

  controller.completeBootstrap(USER_A);
  await deferred.flush();
  assert.deepEqual(controller.getState(), {
    phase: "stable",
    userId: USER_A,
  });
  assert.equal(reads, 1);
  assert.equal(broadcasts, 1);
  assert.deepEqual(invalidations, []);

  controller.notifyAuthChange("TOKEN_REFRESHED", USER_A);
  controller.notifyAuthChange("USER_UPDATED", USER_A);
  await deferred.flush();
  assert.equal(reads, 1);
  assert.equal(broadcasts, 1);

  currentUserId = USER_A;
  controller.notifyAuthChange("SIGNED_IN", USER_B);
  await deferred.flush();
  assert.equal(reads, 2);
  assert.equal(broadcasts, 2);
  assert.deepEqual(controller.getState(), {
    phase: "stable",
    userId: USER_A,
  });
  assert.deepEqual(invalidations, []);
});

test("changed and signed-out hints require an authoritative read and invalidate once", async () => {
  const deferred = createManualDeferred();
  let currentUserId: string | null = USER_A;
  const invalidations: Array<{
    previousUserId: string | null;
    observedUserId: string | null;
    reason: string;
  }> = [];
  const controller = createSessionReconciliationController({
    readCurrentUserId: async () => currentUserId,
    invalidate: (value) => invalidations.push(value),
    defer: deferred.defer,
  });
  controller.completeBootstrap(USER_A);
  await deferred.flush();

  currentUserId = null;
  controller.notifyAuthChange("SIGNED_OUT", null);
  controller.notifyExternalHint("cross-tab");
  controller.notifyDocumentResumed("focus");
  await deferred.flush();

  assert.deepEqual(controller.getState(), {
    phase: "invalidating",
    previousUserId: USER_A,
    observedUserId: null,
    reason: "document:focus",
  });
  assert.deepEqual(invalidations, [
    {
      previousUserId: USER_A,
      observedUserId: null,
      reason: "document:focus",
    },
  ]);

  currentUserId = USER_B;
  controller.notifyAuthChange("SIGNED_IN", USER_B);
  controller.failBootstrap("late-failure");
  await deferred.flush();
  assert.equal(invalidations.length, 1);
});

test("a failed authoritative read and bootstrap failure both fail closed", async (t) => {
  await t.test("authoritative read failure", async () => {
    const deferred = createManualDeferred();
    const invalidations: Array<{ reason: string }> = [];
    let failRead = false;
    const controller = createSessionReconciliationController({
      readCurrentUserId: async () => {
        if (failRead) throw new Error("session_storage_unavailable");
        return USER_A;
      },
      invalidate: (value) => invalidations.push(value),
      defer: deferred.defer,
    });
    controller.completeBootstrap(USER_A);
    await deferred.flush();
    failRead = true;
    controller.notifyExternalHint("cross-tab");
    await deferred.flush();

    assert.equal(invalidations.length, 1);
    assert.equal(
      invalidations[0]?.reason,
      "cross-tab:authoritative-read-failed",
    );
  });

  await t.test("bootstrap failure", () => {
    const invalidations: Array<{ reason: string }> = [];
    const controller = createSessionReconciliationController({
      readCurrentUserId: async () => USER_A,
      invalidate: (value) => invalidations.push(value),
    });
    controller.failBootstrap();
    controller.failBootstrap("duplicate");
    assert.deepEqual(invalidations, [
      {
        previousUserId: null,
        observedUserId: null,
        reason: "bootstrap:failed",
      },
    ]);
  });
});

test("a late authoritative read cannot invalidate a released owner", async () => {
  const deferred = createManualDeferred();
  let resolveRead:
    | ((userId: string | null) => void)
    | undefined;
  const invalidations: unknown[] = [];
  const controller = createSessionReconciliationController({
    readCurrentUserId: () =>
      new Promise<string | null>((resolve) => {
        resolveRead = resolve;
      }),
    invalidate: (value) => invalidations.push(value),
    defer: deferred.defer,
  });
  controller.completeBootstrap(USER_A);
  const flushing = deferred.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.stop();
  resolveRead?.(USER_B);
  await flushing;
  assert.deepEqual(invalidations, []);
});

test("synchronous and invalid schedulers cannot strand reconciliation", async (t) => {
  await t.test("synchronous scheduler", async () => {
    let reads = 0;
    let cancellations = 0;
    const invalidations: unknown[] = [];
    const controller = createSessionReconciliationController({
      readCurrentUserId: async () => {
        reads += 1;
        return USER_A;
      },
      invalidate: (value) => invalidations.push(value),
      defer: (callback) => {
        callback();
        return () => {
          cancellations += 1;
        };
      },
    });
    controller.completeBootstrap(USER_A);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.notifyExternalHint("cross-tab");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(cancellations, 2);
    assert.deepEqual(invalidations, []);
  });

  await t.test("invalid scheduler", () => {
    const invalidations: Array<{ reason: string }> = [];
    const controller = createSessionReconciliationController({
      readCurrentUserId: async () => USER_A,
      invalidate: (value) => invalidations.push(value),
      defer: (() => undefined) as unknown as (
        callback: () => void,
      ) => () => void,
    });
    controller.completeBootstrap(USER_A);
    assert.deepEqual(invalidations, [
      {
        previousUserId: USER_A,
        observedUserId: USER_A,
        reason:
          "bootstrap:reconciliation-schedule-failed",
      },
    ]);
  });
});

class FakeEventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event = new Event(type)) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

class FakeBroadcastChannel {
  readonly posts: unknown[] = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  closed = false;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.delete(listener);
  }

  postMessage(message: unknown) {
    this.posts.push(message);
  }

  emit(message: unknown) {
    for (const listener of this.listeners) {
      listener({ data: message } as MessageEvent<unknown>);
    }
  }

  close() {
    this.closed = true;
  }
}

function installFakeBrowser() {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  const body = {
    inert: false,
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
  };
  let reloads = 0;
  const windowRef = Object.assign(windowTarget, {
    location: {
      reload() {
        reloads += 1;
      },
    },
  });
  const documentRef = Object.assign(documentTarget, {
    visibilityState: "visible",
    body,
  });
  const previousWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowRef,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentRef,
  });
  return {
    windowRef,
    documentRef,
    body,
    reloads: () => reloads,
    restore() {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (previousDocument) {
        Object.defineProperty(
          globalThis,
          "document",
          previousDocument,
        );
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    },
  };
}

test("an initial bootstrap attempt can release and retry without document invalidation", () => {
  const browser = installFakeBrowser();
  let subscriptions = 0;
  let unsubscriptions = 0;
  let profileClears = 0;
  let sentryClears = 0;
  const options = {
    readCurrentUserId: async () => null,
    subscribeAuthChanges: () => {
      subscriptions += 1;
      return () => {
        unsubscriptions += 1;
      };
    },
    clearProfileCache: () => {
      profileClears += 1;
    },
    clearSentryIdentity: () => {
      sentryClears += 1;
    },
    windowRef: browser.windowRef,
    documentRef: browser.documentRef,
    createBroadcastChannel: () => new FakeBroadcastChannel(),
  };

  try {
    const failedAttempt = acquireSessionReconciliation(options);
    failedAttempt.release();
    assert.equal(browser.reloads(), 0);
    assert.equal(browser.body.inert, false);
    assert.equal(
      browser.body.attributes.has("aria-busy"),
      false,
    );
    assert.equal(profileClears, 0);
    assert.equal(sentryClears, 0);
    assert.equal(subscriptions, 1);
    assert.equal(unsubscriptions, 1);

    // SessionBootstrap's scheduled local retry must be able to acquire a
    // completely fresh owner instead of retaining the failed observer.
    const retryAttempt = acquireSessionReconciliation(options);
    assert.equal(subscriptions, 2);
    retryAttempt.release();
    assert.equal(unsubscriptions, 2);
    assert.equal(browser.reloads(), 0);
    assert.equal(browser.body.inert, false);
  } finally {
    browser.restore();
  }
});

test("StrictMode-style duplicate owners share one token-free cross-tab subscription", async () => {
  const browser = installFakeBrowser();
  const deferred = createManualDeferred();
  const channels: FakeBroadcastChannel[] = [];
  const currentUserId: string | null = USER_A;
  let authListener:
    | ((event: string, userId: string | null) => void)
    | undefined;
  let subscriptions = 0;
  let unsubscriptions = 0;
  let reads = 0;
  const common = {
    readCurrentUserId: async () => {
      reads += 1;
      return currentUserId;
    },
    subscribeAuthChanges(
      listener: (event: string, userId: string | null) => void,
    ) {
      subscriptions += 1;
      authListener = listener;
      return () => {
        unsubscriptions += 1;
      };
    },
    clearProfileCache() {},
    clearSentryIdentity() {},
    windowRef: browser.windowRef,
    documentRef: browser.documentRef,
    createBroadcastChannel(name: string) {
      assert.equal(name, SESSION_RECONCILIATION_CHANNEL);
      const channel = new FakeBroadcastChannel();
      channels.push(channel);
      return channel;
    },
    defer: deferred.defer,
  };

  try {
    const first = acquireSessionReconciliation(common);
    const second = acquireSessionReconciliation(common);
    assert.equal(subscriptions, 1);
    assert.equal(channels.length, 1);

    first.completeBootstrap(USER_A);
    await deferred.flush();
    assert.equal(reads, 1);
    assert.equal(channels[0]?.posts.length, 1);

    authListener?.("TOKEN_REFRESHED", USER_A);
    await deferred.flush();
    assert.equal(reads, 1);
    assert.equal(channels[0]?.posts.length, 1);

    authListener?.("SIGNED_IN", USER_B);
    await deferred.flush();
    assert.equal(reads, 2);
    assert.equal(channels[0]?.posts.length, 2);
    assert.deepEqual(
      Object.keys(
        channels[0]?.posts[1] as Record<string, unknown>,
      ).sort(),
      ["senderTabId", "type", "version"],
    );
    const serializedHint = JSON.stringify(channels[0]?.posts[1]);
    assert.doesNotMatch(
      serializedHint,
      /access_token|refresh_token|email|userId/i,
    );

    channels[0]?.emit({
      version: 1,
      type: "auth-session-changed",
      senderTabId: "other-tab",
    });
    await deferred.flush();
    assert.equal(reads, 3);

    browser.windowRef.dispatch("focus");
    await deferred.flush();
    browser.windowRef.dispatch("pageshow");
    await deferred.flush();
    browser.documentRef.dispatch("visibilitychange");
    await deferred.flush();
    assert.equal(reads, 6);

    first.release();
    assert.equal(unsubscriptions, 0);
    assert.equal(channels[0]?.closed, false);
    second.release();
    assert.equal(unsubscriptions, 1);
    assert.equal(channels[0]?.closed, true);
    assert.equal(
      browser.windowRef.listeners.get("focus")?.size ?? 0,
      0,
    );

    const afterRefresh = acquireSessionReconciliation(common);
    assert.equal(subscriptions, 2);
    assert.equal(channels.length, 2);
    afterRefresh.release();
    assert.equal(unsubscriptions, 2);
  } finally {
    browser.restore();
  }
});

test("an authoritative identity change aborts every client mutation and invalidates once", async () => {
  const browser = installFakeBrowser();
  const deferred = createManualDeferred();
  let currentUserId: string | null = USER_A;
  let authListener:
    | ((event: string, userId: string | null) => void)
    | undefined;
  let profileClears = 0;
  let sentryClears = 0;
  let attemptSignal: AbortSignal | null = null;
  const componentLifecycle = new AbortController();
  const owner = acquireSessionReconciliation({
    readCurrentUserId: async () => currentUserId,
    subscribeAuthChanges(listener) {
      authListener = listener;
      return () => {};
    },
    clearProfileCache() {
      profileClears += 1;
    },
    clearSentryIdentity() {
      sentryClears += 1;
    },
    windowRef: browser.windowRef,
    documentRef: browser.documentRef,
    createBroadcastChannel: () => new FakeBroadcastChannel(),
    defer: deferred.defer,
  });

  try {
    owner.completeBootstrap(USER_A);
    await deferred.flush();
    const pending = runClientMutation({
      attempt: (signal) => {
        attemptSignal = signal;
        return new Promise(() => {});
      },
      signal: componentLifecycle.signal,
      deadlineMs: 1_000,
      attemptMs: 500,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    currentUserId = USER_B;
    authListener?.("SIGNED_IN", USER_B);
    await deferred.flush();
    assert.deepEqual(await pending, { kind: "aborted" });
    assert.equal((attemptSignal as AbortSignal | null)?.aborted, true);
    assert.equal(componentLifecycle.signal.aborted, false);
    assert.equal(browser.body.inert, true);
    assert.equal(browser.body.attributes.get("aria-busy"), "true");
    assert.equal(profileClears, 1);
    assert.equal(sentryClears, 1);
    assert.equal(browser.reloads(), 1);

    authListener?.("SIGNED_OUT", null);
    owner.failBootstrap("duplicate");
    await deferred.flush();
    assert.equal(profileClears, 1);
    assert.equal(sentryClears, 1);
    assert.equal(browser.reloads(), 1);

    let lateAttemptCalls = 0;
    assert.deepEqual(
      await runClientMutation({
        attempt: async () => {
          lateAttemptCalls += 1;
          return { kind: "confirmed", value: "must-not-run" };
        },
        deadlineMs: 1_000,
        attemptMs: 500,
      }),
      { kind: "aborted" },
    );
    assert.equal(lateAttemptCalls, 0);
  } finally {
    owner.release();
    browser.restore();
  }
});
