import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

register("../telemetry/node-loader.mjs", import.meta.url);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { useScoreSubmission } = await import(
  "../../components/useScoreSubmission.ts"
);
const { submitScoreWithOutbox } = await import("../../lib/score-outbox.ts");

class MemoryStorage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("open cycles submit once each even when both games have startedAt=0", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new MemoryStorage();
  const submissionIds = [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
  ];
  let minted = 0;
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const scoreId = "00000000-0000-4000-8000-000000000021";
  const bodies: Array<Record<string, unknown>> = [];
  const dependencies = {
    resolveOwnerId: async () => ownerId,
    mintSubmissionId: () => submissionIds[minted++]!,
    now: () => 1_800_000_000_000,
    submit: (entry: Parameters<typeof submitScoreWithOutbox>[0]) =>
      submitScoreWithOutbox(entry, {
        storage,
        now: 1_800_000_000_000,
        fetcher: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ scoreId, reviewStatus: "registered" });
        },
      }),
  };

  function Harness({ open }: { open: boolean }) {
    useScoreSubmission(
      {
        open,
        score: 100,
        startedAt: 0,
        endedAt: 1,
        weapon: "fist",
        dollId: null,
        maxCombo: 1,
        gameplayStats: null,
        telemetrySessionId: null,
      },
      dependencies,
    );
    return null;
  }

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { open: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.submissionId, submissionIds[0]);
  assert.equal(bodies[0]?.durationMs, 1);

  await act(async () => {
    renderer.update(createElement(Harness, { open: false }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    renderer.update(createElement(Harness, { open: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]?.submissionId, submissionIds[1]);
  assert.equal(minted, 2);

  await act(async () => {
    renderer.unmount();
  });
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

test("a late previous-game success cannot overwrite or finish the current submission", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const submissions = [
    deferred<{ scoreId: string; reviewStatus: string }>(),
    deferred<{ scoreId: string; reviewStatus: string }>(),
  ];
  const submissionIds = [
    "00000000-0000-4000-8000-000000000031",
    "00000000-0000-4000-8000-000000000032",
  ];
  const entries: Array<{ submissionId: string }> = [];
  let minted = 0;
  let submitted = 0;
  let latest:
    | {
        scoreId: string | null;
        submitting: boolean;
        submitError: string | null;
        reviewStatus: string | null;
      }
    | undefined;
  const dependencies = {
    resolveOwnerId: async () => "00000000-0000-4000-8000-000000000001",
    mintSubmissionId: () => submissionIds[minted++]!,
    now: () => 1_800_000_000_000,
    submit: (entry: { submissionId: string }) => {
      entries.push(entry);
      return submissions[submitted++]!.promise;
    },
  };

  function Harness({ open }: { open: boolean }) {
    latest = useScoreSubmission(
      {
        open,
        score: 100,
        startedAt: 0,
        endedAt: 1,
        weapon: "fist",
        dollId: null,
        maxCombo: 1,
        gameplayStats: null,
      },
      dependencies,
    );
    return null;
  }

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { open: true }));
    await flushPromises();
  });
  await act(async () => {
    renderer.update(createElement(Harness, { open: false }));
    await flushPromises();
  });
  await act(async () => {
    renderer.update(createElement(Harness, { open: true }));
    await flushPromises();
  });

  assert.deepEqual(
    entries.map((entry) => entry.submissionId),
    submissionIds,
  );
  assert.equal(latest?.submitting, true);

  await act(async () => {
    submissions[0]!.resolve({
      scoreId: "00000000-0000-4000-8000-000000000041",
      reviewStatus: "voided",
    });
    await flushPromises();
  });
  assert.equal(latest?.scoreId, null);
  assert.equal(latest?.reviewStatus, null);
  assert.equal(latest?.submitting, true);

  await act(async () => {
    submissions[1]!.resolve({
      scoreId: "00000000-0000-4000-8000-000000000042",
      reviewStatus: "registered",
    });
    await flushPromises();
  });
  assert.equal(
    latest?.scoreId,
    "00000000-0000-4000-8000-000000000042",
  );
  assert.equal(latest?.reviewStatus, "registered");
  assert.equal(latest?.submitting, false);

  await act(async () => {
    renderer.unmount();
  });
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

test("a late previous-game failure cannot expose an error or schedule its retry", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const submissions = [
    deferred<{ scoreId: string; reviewStatus: string }>(),
    deferred<{ scoreId: string; reviewStatus: string }>(),
  ];
  const submissionIds = [
    "00000000-0000-4000-8000-000000000051",
    "00000000-0000-4000-8000-000000000052",
  ];
  let minted = 0;
  let submitted = 0;
  let latest:
    | {
        scoreId: string | null;
        submitting: boolean;
        submitError: string | null;
      }
    | undefined;
  const dependencies = {
    resolveOwnerId: async () => "00000000-0000-4000-8000-000000000001",
    mintSubmissionId: () => submissionIds[minted++]!,
    now: () => 1_800_000_000_000,
    submit: () => submissions[submitted++]!.promise,
  };

  function Harness({ open }: { open: boolean }) {
    latest = useScoreSubmission(
      {
        open,
        score: 100,
        startedAt: 0,
        endedAt: 1,
        weapon: "fist",
        dollId: null,
        maxCombo: 1,
        gameplayStats: null,
      },
      dependencies,
    );
    return null;
  }

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { open: true }));
    await flushPromises();
  });
  await act(async () => {
    renderer.update(createElement(Harness, { open: false }));
    await flushPromises();
  });
  await act(async () => {
    renderer.update(createElement(Harness, { open: true }));
    await flushPromises();
  });

  await act(async () => {
    submissions[0]!.reject(new Error("old_game_failed"));
    await flushPromises();
  });
  assert.equal(latest?.submitError, null);
  assert.equal(latest?.submitting, true);
  assert.equal(submitted, 2);

  await act(async () => {
    submissions[1]!.resolve({
      scoreId: "00000000-0000-4000-8000-000000000062",
      reviewStatus: "registered",
    });
    await flushPromises();
  });
  assert.equal(
    latest?.scoreId,
    "00000000-0000-4000-8000-000000000062",
  );
  assert.equal(latest?.submitError, null);
  assert.equal(latest?.submitting, false);

  await act(async () => {
    renderer.unmount();
  });
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});
