import assert from "node:assert/strict";
import test from "node:test";
import {
  createExpiringSharedRequest,
  type ExpiringSharedRequest,
} from "../../lib/expiring-shared-request.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  const runDue = () => {
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.at - right.at || leftId - rightId,
        )[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };

  return {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
    advance: (milliseconds: number, runTimers = true) => {
      now += milliseconds;
      if (runTimers) runDue();
    },
    pendingTimers: () => timers.size,
  };
}

test("active-event consumers share one request until the exact TTL boundary", async () => {
  const clock = fakeClock();
  let loads = 0;
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: async () => {
      loads += 1;
      return `events-${loads}`;
    },
  });
  let refreshes = 0;
  const unsubscribe = cache.subscribe(() => {
    refreshes += 1;
    void cache.load();
  });

  const [first, shared] = await Promise.all([cache.load(), cache.load()]);
  assert.equal(first, "events-1");
  assert.equal(shared, "events-1");
  assert.equal(loads, 1);
  assert.equal(clock.pendingTimers(), 1);

  clock.advance(29_999);
  assert.equal(refreshes, 0);
  assert.equal(await cache.load(), "events-1");

  clock.advance(1);
  await Promise.resolve();
  assert.equal(refreshes, 1);
  assert.equal(loads, 2);
  assert.equal(await cache.load(), "events-2");

  unsubscribe();
  cache.dispose();
});

test("focus or visible recovery refreshes an expired cache after throttled timers", async () => {
  const clock = fakeClock();
  let loads = 0;
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: async () => ++loads,
  });
  let refreshes = 0;
  cache.subscribe(() => {
    refreshes += 1;
  });

  assert.equal(await cache.load(), 1);
  clock.advance(30_000, false);
  assert.equal(refreshes, 0, "hidden-tab timer is intentionally throttled");
  assert.equal(cache.refreshIfExpired(), true);
  assert.equal(refreshes, 1);
  assert.equal(await cache.load(), 2);
  assert.equal(cache.refreshIfExpired(), false);

  cache.dispose();
});

test("a stale response cannot replace or re-arm the next cache generation", async () => {
  const clock = fakeClock();
  const first = deferred<string>();
  const second = deferred<string>();
  let loads = 0;
  const cache: ExpiringSharedRequest<string> =
    createExpiringSharedRequest({
      ttlMs: 30_000,
      now: clock.now,
      schedule: clock.schedule,
      load: () => {
        loads += 1;
        return loads === 1 ? first.promise : second.promise;
      },
    });

  const stalePromise = cache.load();
  await Promise.resolve();
  cache.refresh();
  const currentPromise = cache.load();
  await Promise.resolve();

  second.resolve("current");
  assert.equal(await currentPromise, "current");
  const currentSnapshot = cache.snapshot();

  clock.advance(5_000);
  first.resolve("stale");
  assert.equal(await stalePromise, "stale");
  assert.deepEqual(cache.snapshot(), currentSnapshot);
  assert.equal(await cache.load(), "current");
  assert.equal(loads, 2);

  cache.dispose();
});

test("a rejected request is not cached as a successful empty event set", async () => {
  const clock = fakeClock();
  let loads = 0;
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: async () => {
      loads += 1;
      if (loads === 1) throw new Error("temporary outage");
      return "recovered";
    },
  });

  await assert.rejects(cache.load(), /temporary outage/);
  assert.equal(cache.snapshot().hasRequest, false);
  assert.equal(await cache.load(), "recovered");
  assert.equal(loads, 2);

  cache.dispose();
});

test("a synchronous loader throw is evicted immediately", async () => {
  const clock = fakeClock();
  let loads = 0;
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: () => {
      loads += 1;
      if (loads === 1) throw new Error("synchronous_loader_failure");
      return Promise.resolve("recovered");
    },
  });

  await assert.rejects(cache.load(), /synchronous_loader_failure/);
  assert.equal(cache.snapshot().hasRequest, false);
  assert.equal(await cache.load(), "recovered");
  cache.dispose();
});

test("refresh and dispose abort superseded pending network work", async () => {
  const clock = fakeClock();
  const signals: AbortSignal[] = [];
  const cache = createExpiringSharedRequest<string>({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: (signal) => {
      signals.push(signal);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });
    },
  });

  const first = cache.load();
  await Promise.resolve();
  cache.refresh();
  await assert.rejects(first, /shared_request_generation_invalidated/);
  assert.equal(signals[0]?.aborted, true);

  const second = cache.load();
  await Promise.resolve();
  cache.dispose();
  await assert.rejects(second, /shared_request_disposed/);
  assert.equal(signals[1]?.aborted, true);
  assert.equal(clock.pendingTimers(), 0);
});

test("a value-derived transition caps the ordinary cache TTL at one millisecond precision", async () => {
  const clock = fakeClock();
  let loads = 0;
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: async () => ({ value: ++loads, validUntil: 1_001 }),
    expiresAt: (value) => value.validUntil,
  });
  let refreshes = 0;
  cache.subscribe(() => {
    refreshes += 1;
  });

  assert.deepEqual(await cache.load(), { value: 1, validUntil: 1_001 });
  clock.advance(1_000);
  assert.equal(refreshes, 0);
  clock.advance(1);
  assert.equal(refreshes, 1);
  assert.equal(cache.snapshot().hasRequest, false);
  cache.dispose();
});

test("a value deadline already reached before outer settlement is never extended", async () => {
  const clock = fakeClock();
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: async () => {
      clock.advance(1_001, false);
      return { validUntil: 1_001 };
    },
    expiresAt: (value) => value.validUntil,
  });

  await assert.rejects(
    cache.load(),
    /shared_request_value_already_expired/,
  );
  assert.equal(cache.snapshot().hasRequest, false);
  assert.equal(clock.pendingTimers(), 0);
  cache.dispose();
});

test("broken synchronous or throwing schedulers reject without recursion or stale cache state", async () => {
  const synchronous = createExpiringSharedRequest({
    ttlMs: 30_000,
    load: async () => "must-not-start",
    schedule: (callback) => {
      callback();
      return () => {};
    },
  });
  await assert.rejects(
    synchronous.load(),
    /invalid_shared_request_scheduler/,
  );
  assert.equal(synchronous.snapshot().hasRequest, false);
  synchronous.dispose();

  const throwing = createExpiringSharedRequest({
    ttlMs: 30_000,
    load: async () => "must-not-start",
    schedule: () => {
      throw new Error("scheduler exploded");
    },
  });
  await assert.rejects(
    throwing.load(),
    /shared_request_scheduler_failed/,
  );
  assert.equal(throwing.snapshot().hasRequest, false);
  throwing.dispose();
});

test("a throwing subscriber cannot block the remaining generation observers", async () => {
  const clock = fakeClock();
  const cache = createExpiringSharedRequest({
    ttlMs: 30_000,
    now: clock.now,
    schedule: clock.schedule,
    load: async () => "events",
  });
  let observed = 0;
  cache.subscribe(() => {
    throw new Error("consumer defect");
  });
  cache.subscribe(() => {
    observed += 1;
  });
  await cache.load();
  assert.doesNotThrow(() => cache.refresh());
  assert.equal(observed, 1);
  cache.dispose();
});

test("the shared clock clamps backwards movement and rejects non-finite readings", async () => {
  let current = 100;
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const cache = createExpiringSharedRequest({
    ttlMs: 30,
    now: () => current,
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return () => {};
    },
    load: async () => "events",
  });
  await cache.load();
  current = 90;
  assert.equal(cache.refreshIfExpired(), false);
  assert.equal(cache.snapshot().expiresAt, 130);
  current = Number.NaN;
  assert.equal(cache.refreshIfExpired(), true);
  assert.equal(cache.snapshot().hasRequest, false);
  await assert.rejects(cache.load(), /invalid_shared_request_clock/);
  assert.ok(timers.length >= 1);
  cache.dispose();
});
