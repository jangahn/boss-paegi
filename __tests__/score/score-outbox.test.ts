import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  SCORE_OUTBOX_STORAGE_KEY,
  SCORE_OUTBOX_TTL_MS,
  ScoreOutboxCorruptionError,
  ScoreOutboxStorageError,
  ScoreSubmissionHttpError,
  drainScoreSubmissionOutbox,
  persistScoreSubmission,
  readScoreSubmissionOutbox,
  submitScoreWithOutbox,
} = await import("../../lib/score-outbox.ts");

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

class InterleavingStorage extends MemoryStorage {
  beforeFirstWrite: (() => void) | null = null;

  override setItem(key: string, value: string): void {
    const interleave = this.beforeFirstWrite;
    this.beforeFirstWrite = null;
    interleave?.();
    super.setItem(key, value);
  }
}

const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";
const SUBMISSION_A = "00000000-0000-4000-8000-000000000011";
const SUBMISSION_B = "00000000-0000-4000-8000-000000000012";
const SCORE_ID = "00000000-0000-4000-8000-000000000021";
const NOW = 1_800_000_000_000;

function entry(
  ownerId = OWNER_A,
  submissionId = SUBMISSION_A,
  score = 100,
) {
  return {
    ownerId,
    submissionId,
    startedAt: 0,
    createdAt: NOW,
    body: {
      score,
      weapon: "fist",
      durationMs: 1,
      dollId: null,
      maxCombo: 1,
      gameplayStats: null,
      endReason: "normal" as const,
      telemetrySessionId: null,
      submissionId,
      trackFirstTouchPlay: false,
      acqSource: null,
    },
  };
}

test("outbox is durably written before fetch and cleared only by a valid 2xx ack", async () => {
  const storage = new MemoryStorage();
  let called = 0;
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    called += 1;
    assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 1);
    assert.equal(
      (JSON.parse(String(init?.body)) as { submissionId: string }).submissionId,
      SUBMISSION_A,
    );
    return Response.json({ scoreId: SCORE_ID, reviewStatus: "registered" });
  };
  const result = await submitScoreWithOutbox(entry(), {
    storage,
    fetcher,
    now: NOW,
  });
  assert.equal(result.scoreId, SCORE_ID);
  assert.equal(called, 1);
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 0);
});

test("storage unavailable/no-op/throw aborts before the score HTTP request", async () => {
  let fetchCalls = 0;
  const fetcher = async () => {
    fetchCalls += 1;
    return Response.json({ scoreId: SCORE_ID });
  };
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage: null,
      fetcher,
      now: NOW,
    }),
    ScoreOutboxStorageError,
  );

  const noOpStorage = new MemoryStorage();
  noOpStorage.setItem = () => {};
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage: noOpStorage,
      fetcher,
      now: NOW,
    }),
    ScoreOutboxStorageError,
  );

  const throwingStorage = new MemoryStorage();
  throwingStorage.setItem = () => {
    throw new Error("quota exceeded");
  };
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage: throwingStorage,
      fetcher,
      now: NOW,
    }),
    ScoreOutboxStorageError,
  );
  assert.equal(fetchCalls, 0);
});

test("per-submission keys preserve both writes under a forced two-tab interleaving", () => {
  const storage = new InterleavingStorage();
  const first = entry(OWNER_A, SUBMISSION_A, 100);
  const second = entry(OWNER_B, SUBMISSION_B, 200);
  storage.beforeFirstWrite = () => {
    persistScoreSubmission(second, storage, NOW);
  };
  persistScoreSubmission(first, storage, NOW);
  assert.deepEqual(
    readScoreSubmissionOutbox(storage, NOW).map((item) => [
      item.ownerId,
      item.submissionId,
      item.body.score,
    ]),
    [
      [OWNER_B, SUBMISSION_B, 200],
      [OWNER_A, SUBMISSION_A, 100],
    ],
  );
});

test("corruption is surfaced and never overwritten by a new submission", () => {
  const storage = new MemoryStorage();
  storage.setItem(SCORE_OUTBOX_STORAGE_KEY, "{");
  const before = storage.getItem(SCORE_OUTBOX_STORAGE_KEY);
  assert.throws(
    () => persistScoreSubmission(entry(), storage, NOW),
    ScoreOutboxCorruptionError,
  );
  assert.equal(storage.getItem(SCORE_OUTBOX_STORAGE_KEY), before);
});

test("HTTP/response loss retains the first body and a retry cannot replace it", async () => {
  const storage = new MemoryStorage();
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage,
      now: NOW,
      fetcher: async () =>
        Response.json(
          { error: "score_report_pending" },
          { status: 503 },
        ),
    }),
    (error: unknown) =>
      error instanceof ScoreSubmissionHttpError && error.status === 503,
  );
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 1);

  let submittedScore: unknown;
  await submitScoreWithOutbox(entry(OWNER_A, SUBMISSION_A, 999), {
    storage,
    now: NOW,
    fetcher: async (_input, init) => {
      submittedScore = (JSON.parse(String(init?.body)) as { score: unknown })
        .score;
      return Response.json({ scoreId: SCORE_ID });
    },
  });
  assert.equal(submittedScore, 100);
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 0);
});

test("malformed success acknowledgements remain durable", async () => {
  const storage = new MemoryStorage();
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage,
      now: NOW,
      fetcher: async () => Response.json({ ok: true }),
    }),
    /invalid_score_submit_ack/,
  );
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 1);
});

test("never-settling score transport is deadline-bounded and remains durable", async () => {
  const storage = new MemoryStorage();
  const startedAt = performance.now();
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage,
      now: NOW,
      deadlineMs: 30,
      attemptMs: 10,
      fetcher: async () => new Promise<Response>(() => {}),
    }),
    /score_submit_response_unconfirmed/,
  );
  assert.ok(performance.now() - startedAt < 500);
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 1);
});

test("never-ending score JSON acknowledgement is cancelled and remains durable", async () => {
  const storage = new MemoryStorage();
  let bodyCancelled = false;
  await assert.rejects(
    submitScoreWithOutbox(entry(), {
      storage,
      now: NOW,
      deadlineMs: 30,
      attemptMs: 10,
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"scoreId":"'));
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    }),
    /score_submit_response_unconfirmed/,
  );
  assert.equal(bodyCancelled, true);
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 1);
});

test("a committed acknowledgement reports a deferred clear instead of hiding remove failure", async () => {
  const storage = new MemoryStorage();
  storage.removeItem = () => {};
  const result = await submitScoreWithOutbox(entry(), {
    storage,
    now: NOW,
    fetcher: async () => Response.json({ scoreId: SCORE_ID }),
  });
  assert.equal(result.scoreId, SCORE_ID);
  assert.equal(result.outboxClearPending, true);
  assert.equal(readScoreSubmissionOutbox(storage, NOW).length, 1);
});

test("partial or type-confused 2xx acknowledgements never clear durable state", async () => {
  for (const body of [
    {
      scoreId: "00000000-0000-4000-8000-000000000010",
      reviewStatus: "unknown",
    },
    {
      scoreId: "00000000-0000-4000-8000-000000000010",
      percentile: 50.5,
    },
    {
      scoreId: "00000000-0000-4000-8000-000000000010",
      newBadges: [1],
    },
    {
      scoreId: "00000000-0000-4000-8000-000000000010",
      collectedCount: -1,
    },
  ]) {
    const storage = new MemoryStorage();
    const durableEntry = entry();
    await assert.rejects(
      submitScoreWithOutbox(durableEntry, {
        storage,
        fetcher: async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        now: durableEntry.createdAt,
      }),
      /invalid_score_submit_ack/,
    );
    assert.equal(
      readScoreSubmissionOutbox(storage, durableEntry.createdAt).length,
      1,
    );
  }
});

test("bootstrap drain retries current owner and DB-fences an unrelated owner hint", async () => {
  const storage = new MemoryStorage();
  persistScoreSubmission(entry(), storage, NOW);
  persistScoreSubmission(
    entry(OWNER_B, SUBMISSION_B, 200),
    storage,
    NOW,
  );
  let ownerAttempts = 0;
  let foreignAttempts = 0;
  const delays: number[] = [];
  const resumed: string[] = [];
  await drainScoreSubmissionOutbox(OWNER_A, {
    storage,
    now: NOW,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    onSuccess: (resumedEntry) => {
      resumed.push(resumedEntry.submissionId);
    },
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        submissionId: string;
      };
      const sourceOwner = new Headers(init?.headers).get(
        "x-boss-paegi-score-source-owner",
      );
      if (body.submissionId === SUBMISSION_A) {
        assert.equal(sourceOwner, null);
        ownerAttempts += 1;
        return ownerAttempts === 1
          ? Response.json({ error: "temporary" }, { status: 503 })
          : Response.json({ scoreId: SCORE_ID });
      }
      assert.equal(body.submissionId, SUBMISSION_B);
      assert.equal(sourceOwner, OWNER_B);
      foreignAttempts += 1;
      return Response.json(
        { error: "migrated_replay_not_authorized" },
        { status: 409 },
      );
    },
  });
  assert.equal(ownerAttempts, 2);
  assert.equal(foreignAttempts, 1);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(resumed, [SUBMISSION_A]);
  assert.deepEqual(
    readScoreSubmissionOutbox(storage, NOW).map((item) => item.ownerId),
    [OWNER_B],
  );
});

test("receipt-authorized foreign outbox replay clears the original owner entry", async () => {
  const storage = new MemoryStorage();
  persistScoreSubmission(
    entry(OWNER_B, SUBMISSION_B, 200),
    storage,
    NOW,
  );
  const resumed: string[] = [];
  await drainScoreSubmissionOutbox(OWNER_A, {
    storage,
    now: NOW,
    delay: async () => {},
    onSuccess: (resumedEntry) => {
      resumed.push(resumedEntry.submissionId);
    },
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        submissionId: string;
      };
      assert.equal(body.submissionId, SUBMISSION_B);
      assert.equal(
        new Headers(init?.headers).get(
          "x-boss-paegi-score-source-owner",
        ),
        OWNER_B,
      );
      return Response.json({ scoreId: SCORE_ID, duplicate: true });
    },
  });
  assert.deepEqual(resumed, [SUBMISSION_B]);
  assert.deepEqual(readScoreSubmissionOutbox(storage, NOW), []);
});

test("source and migrated acting owners never share an in-flight request", async () => {
  const storage = new MemoryStorage();
  const durableEntry = entry(OWNER_B, SUBMISSION_B, 200);
  const sourceHeaders: Array<string | null> = [];
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    sourceHeaders.push(
      new Headers(init?.headers).get(
        "x-boss-paegi-score-source-owner",
      ),
    );
    return Response.json({ scoreId: SCORE_ID });
  };
  await Promise.all([
    submitScoreWithOutbox(durableEntry, {
      storage,
      fetcher,
      now: NOW,
      actingOwnerId: OWNER_B,
    }),
    submitScoreWithOutbox(durableEntry, {
      storage,
      fetcher,
      now: NOW,
      actingOwnerId: OWNER_A,
    }),
  ]);
  assert.deepEqual(
    sourceHeaders.sort((left, right) =>
      String(left).localeCompare(String(right)),
    ),
    [null, OWNER_B].sort((left, right) =>
      String(left).localeCompare(String(right)),
    ),
  );
});

test("corrupt, future and expired localStorage records are never replayed", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    SCORE_OUTBOX_STORAGE_KEY,
    JSON.stringify([
      entry(),
      { ...entry(), createdAt: NOW - SCORE_OUTBOX_TTL_MS - 1 },
    ]),
  );
  assert.deepEqual(readScoreSubmissionOutbox(storage, NOW), [entry()]);

  storage.setItem(
    SCORE_OUTBOX_STORAGE_KEY,
    JSON.stringify([
      entry(),
      { ...entry(), submissionId: "not-a-uuid" },
    ]),
  );
  assert.throws(
    () => readScoreSubmissionOutbox(storage, NOW),
    /score_outbox_corrupt/,
  );
  storage.setItem(
    SCORE_OUTBOX_STORAGE_KEY,
    JSON.stringify([{ ...entry(), createdAt: NOW + 5 * 60_000 + 1 }]),
  );
  assert.throws(
    () => readScoreSubmissionOutbox(storage, NOW),
    /score_outbox_corrupt/,
  );
  storage.setItem(SCORE_OUTBOX_STORAGE_KEY, "{");
  assert.throws(
    () => readScoreSubmissionOutbox(storage, NOW),
    /score_outbox_corrupt/,
  );
});
