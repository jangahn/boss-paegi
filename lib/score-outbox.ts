"use client";

import {
  SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS,
  isScoreSubmissionId,
  scoreSubmissionRetryDelayMs,
} from "@/lib/score-retry";
import {
  runBoundedClientJsonFetch,
  unconfirmedOutcomeError,
} from "@/lib/client-mutation";

export const SCORE_OUTBOX_STORAGE_KEY = "boss-paegi:score-outbox:v1";
export const SCORE_OUTBOX_ENTRY_PREFIX = "boss-paegi:score-outbox:v2:";
export const SCORE_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SCORE_OUTBOX_MAX_ENTRIES = 20;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScoreSubmissionPayload = {
  score: number;
  weapon: string;
  durationMs: number;
  dollId: string | null;
  maxCombo: number;
  gameplayStats: unknown;
  endReason: "normal" | "time_limit" | "score_limit";
  telemetrySessionId: string | null;
  submissionId: string;
  trackFirstTouchPlay: boolean;
  acqSource: unknown;
};

export type ScoreOutboxEntry = {
  ownerId: string;
  startedAt: number;
  submissionId: string;
  createdAt: number;
  body: ScoreSubmissionPayload;
};

export type ScoreSubmissionAck = {
  scoreId: string;
  reviewStatus?: string;
  percentile?: number | null;
  newBadges?: string[];
  collectedCount?: number;
  duplicate?: boolean;
  /** Server commit succeeded, but the local replay record could not be cleared. */
  outboxClearPending?: boolean;
};

export type ScoreOutboxStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export class ScoreOutboxStorageError extends Error {
  readonly operation: string;
  readonly causeValue: unknown;

  constructor(operation: string, causeValue?: unknown) {
    super(`score_outbox_storage_${operation}`);
    this.name = "ScoreOutboxStorageError";
    this.operation = operation;
    this.causeValue = causeValue;
  }
}

export class ScoreOutboxCorruptionError extends Error {
  readonly storageKey: string;

  constructor(storageKey: string) {
    super("score_outbox_corrupt");
    this.name = "ScoreOutboxCorruptionError";
    this.storageKey = storageKey;
  }
}

export class ScoreOutboxFullError extends Error {
  constructor() {
    super("score_outbox_full");
    this.name = "ScoreOutboxFullError";
  }
}

export class ScoreSubmissionHttpError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, responseBody: unknown) {
    const message =
      responseBody &&
      typeof responseBody === "object" &&
      typeof (responseBody as { error?: unknown }).error === "string"
        ? (responseBody as { error: string }).error
        : `score_submit_http_${status}`;
    super(message);
    this.name = "ScoreSubmissionHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function browserStorage(): ScoreOutboxStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const ENTRY_KEYS = new Set([
  "ownerId",
  "startedAt",
  "submissionId",
  "createdAt",
  "body",
]);
const BODY_KEYS = new Set([
  "score",
  "weapon",
  "durationMs",
  "dollId",
  "maxCombo",
  "gameplayStats",
  "endReason",
  "telemetrySessionId",
  "submissionId",
  "trackFirstTouchPlay",
  "acqSource",
]);
const END_REASONS = new Set(["normal", "time_limit", "score_limit"]);

function isBoundedJsonValue(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  budget.nodes += 1;
  if (budget.nodes > 2_000 || depth > 12) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "string" || value.length <= 20_000;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= 500 &&
      value.every((entry) => isBoundedJsonValue(entry, depth + 1, budget))
    );
  }
  if (!isJsonObject(value) || Object.keys(value).length > 200) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key.length <= 200 &&
      isBoundedJsonValue(entry, depth + 1, budget),
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.size &&
    keys.every((key) => expected.has(key))
  );
}

function isSubmissionBody(
  value: Record<string, unknown>,
  submissionId: string,
): boolean {
  return (
    hasExactKeys(value, BODY_KEYS) &&
    Number.isSafeInteger(value.score) &&
    (value.score as number) >= 0 &&
    (value.score as number) <= 5_000_000 &&
    typeof value.weapon === "string" &&
    value.weapon.length >= 1 &&
    value.weapon.length <= 64 &&
    Number.isSafeInteger(value.durationMs) &&
    (value.durationMs as number) >= 1 &&
    (value.durationMs as number) <= 30 * 60 * 1_000 &&
    (value.dollId === null ||
      (typeof value.dollId === "string" && UUID_RE.test(value.dollId))) &&
    Number.isSafeInteger(value.maxCombo) &&
    (value.maxCombo as number) >= 0 &&
    (value.maxCombo as number) <= 99_999 &&
    isBoundedJsonValue(value.gameplayStats) &&
    typeof value.endReason === "string" &&
    END_REASONS.has(value.endReason) &&
    (value.telemetrySessionId === null ||
      (typeof value.telemetrySessionId === "string" &&
        UUID_RE.test(value.telemetrySessionId))) &&
    value.submissionId === submissionId &&
    typeof value.trackFirstTouchPlay === "boolean" &&
    isBoundedJsonValue(value.acqSource)
  );
}

function classifyOutboxEntry(
  value: unknown,
  now: number,
): "valid" | "expired" | "invalid" {
  if (!isJsonObject(value) || !isJsonObject(value.body)) return "invalid";
  const body = value.body;
  if (
    !hasExactKeys(value, ENTRY_KEYS) ||
    typeof value.ownerId !== "string" ||
    typeof value.startedAt !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.submissionId !== "string"
  ) {
    return "invalid";
  }
  if (
    !UUID_RE.test(value.ownerId as string) ||
    !Number.isFinite(value.startedAt) ||
    (value.startedAt as number) < 0 ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) <= 0 ||
    (value.createdAt as number) > now + 5 * 60_000 ||
    !isScoreSubmissionId(value.submissionId) ||
    !isSubmissionBody(body, value.submissionId as string)
  ) {
    return "invalid";
  }
  return now - (value.createdAt as number) > SCORE_OUTBOX_TTL_MS
    ? "expired"
    : "valid";
}

function storageGet(
  storage: ScoreOutboxStorage,
  key: string,
): string | null {
  try {
    return storage.getItem(key);
  } catch (error) {
    throw new ScoreOutboxStorageError("read", error);
  }
}

function storageKeys(storage: ScoreOutboxStorage): string[] {
  try {
    const keys = new Set<string>();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.add(key);
    }
    return [...keys];
  } catch (error) {
    throw new ScoreOutboxStorageError("enumerate", error);
  }
}

function parseStoredEntry(
  raw: string,
  storageKey: string,
  now: number,
): ScoreOutboxEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScoreOutboxCorruptionError(storageKey);
  }
  const classification = classifyOutboxEntry(parsed, now);
  if (classification === "invalid") {
    throw new ScoreOutboxCorruptionError(storageKey);
  }
  return classification === "expired"
    ? null
    : (parsed as ScoreOutboxEntry);
}

function entryKey(entry: Pick<ScoreOutboxEntry, "ownerId" | "submissionId">) {
  return `${SCORE_OUTBOX_ENTRY_PREFIX}${entry.ownerId.toLowerCase()}:${entry.submissionId.toLowerCase()}`;
}

function sameDurableEntry(
  left: ScoreOutboxEntry,
  right: ScoreOutboxEntry,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readScoreSubmissionOutbox(
  storage: ScoreOutboxStorage | null = browserStorage(),
  now = Date.now(),
): ScoreOutboxEntry[] {
  if (!storage) return [];
  const entries: ScoreOutboxEntry[] = [];
  const legacyRaw = storageGet(storage, SCORE_OUTBOX_STORAGE_KEY);
  if (legacyRaw !== null) {
    let legacy: unknown;
    try {
      legacy = JSON.parse(legacyRaw);
    } catch {
      throw new ScoreOutboxCorruptionError(SCORE_OUTBOX_STORAGE_KEY);
    }
    if (!Array.isArray(legacy)) {
      throw new ScoreOutboxCorruptionError(SCORE_OUTBOX_STORAGE_KEY);
    }
    for (const value of legacy) {
      const classification = classifyOutboxEntry(value, now);
      if (classification === "invalid") {
        throw new ScoreOutboxCorruptionError(SCORE_OUTBOX_STORAGE_KEY);
      }
      if (classification === "valid") {
        entries.push(value as ScoreOutboxEntry);
      }
    }
  }

  for (const key of storageKeys(storage)) {
    if (!key.startsWith(SCORE_OUTBOX_ENTRY_PREFIX)) continue;
    const raw = storageGet(storage, key);
    if (raw === null) continue;
    const entry = parseStoredEntry(raw, key, now);
    if (entry) entries.push(entry);
  }

  const unique = new Map<string, ScoreOutboxEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const existing = unique.get(key);
    if (existing && !sameDurableEntry(existing, entry)) {
      throw new ScoreOutboxCorruptionError(key);
    }
    unique.set(key, existing ?? entry);
  }
  return [...unique.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function writeEntry(
  entry: ScoreOutboxEntry,
  storage: ScoreOutboxStorage | null,
): void {
  if (!storage) throw new ScoreOutboxStorageError("unavailable");
  const key = entryKey(entry);
  let serialized: string;
  try {
    serialized = JSON.stringify(entry);
    storage.setItem(key, serialized);
  } catch (error) {
    throw new ScoreOutboxStorageError("write", error);
  }
  if (storageGet(storage, key) !== serialized) {
    throw new ScoreOutboxStorageError("verify");
  }
}

/**
 * Write-before-send. An existing key always wins, so a retry cannot replace
 * the first durable body even if live props/config drift while it is pending.
 */
export function persistScoreSubmission(
  entry: ScoreOutboxEntry,
  storage: ScoreOutboxStorage | null = browserStorage(),
  now = Date.now(),
): ScoreOutboxEntry {
  const entries = readScoreSubmissionOutbox(storage, now);
  const existing = entries.find(
    (candidate) =>
      candidate.ownerId === entry.ownerId &&
      candidate.submissionId === entry.submissionId,
  );
  if (existing) return existing;
  if (classifyOutboxEntry(entry, now) !== "valid") {
    throw new ScoreOutboxCorruptionError(entryKey(entry));
  }
  if (entries.length >= SCORE_OUTBOX_MAX_ENTRIES) {
    throw new ScoreOutboxFullError();
  }
  writeEntry(entry, storage);
  return entry;
}

export function clearScoreSubmission(
  ownerId: string,
  submissionId: string,
  storage: ScoreOutboxStorage | null = browserStorage(),
  now = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    // Corruption must be detected before any remove/set can overwrite evidence.
    readScoreSubmissionOutbox(storage, now);
    const key = entryKey({ ownerId, submissionId });
    storage.removeItem(key);
    if (storage.getItem(key) !== null) return false;

    const legacyRaw = storage.getItem(SCORE_OUTBOX_STORAGE_KEY);
    if (legacyRaw === null) return true;
    const legacy = JSON.parse(legacyRaw) as unknown;
    if (!Array.isArray(legacy)) return false;
    const next = legacy.filter(
      (value) =>
        !isJsonObject(value) ||
        value.ownerId !== ownerId ||
        value.submissionId !== submissionId,
    );
    if (next.length === 0) {
      storage.removeItem(SCORE_OUTBOX_STORAGE_KEY);
      return storage.getItem(SCORE_OUTBOX_STORAGE_KEY) === null;
    }
    const serialized = JSON.stringify(next);
    storage.setItem(SCORE_OUTBOX_STORAGE_KEY, serialized);
    return storage.getItem(SCORE_OUTBOX_STORAGE_KEY) === serialized;
  } catch {
    return false;
  }
}

const inflight = new Map<string, Promise<ScoreSubmissionAck>>();

function submissionKey(
  entry: ScoreOutboxEntry,
  actingOwnerId = entry.ownerId,
): string {
  return `${entry.ownerId.toLowerCase()}:${entry.submissionId.toLowerCase()}:${actingOwnerId.toLowerCase()}`;
}

function isValidAck(value: unknown): value is ScoreSubmissionAck {
  if (
    !isJsonObject(value) ||
    typeof value.scoreId !== "string" ||
    !UUID_RE.test(value.scoreId)
  ) {
    return false;
  }
  if (
    value.reviewStatus !== undefined &&
    (typeof value.reviewStatus !== "string" ||
      !["registered", "pending", "cleared", "voided"].includes(
        value.reviewStatus,
      ))
  ) {
    return false;
  }
  if (
    value.percentile !== undefined &&
    value.percentile !== null &&
    !(
      typeof value.percentile === "number" &&
      Number.isSafeInteger(value.percentile) &&
      value.percentile >= 1 &&
      value.percentile <= 100
    )
  ) {
    return false;
  }
  if (
    value.newBadges !== undefined &&
    (!Array.isArray(value.newBadges) ||
      value.newBadges.length > 120 ||
      value.newBadges.some(
        (badge) =>
          typeof badge !== "string" ||
          badge.length < 1 ||
          badge.length > 40,
      ) ||
      new Set(value.newBadges).size !== value.newBadges.length)
  ) {
    return false;
  }
  if (
    value.collectedCount !== undefined &&
    (!Number.isSafeInteger(value.collectedCount) ||
      (value.collectedCount as number) < 0 ||
      (value.collectedCount as number) > 120)
  ) {
    return false;
  }
  return value.duplicate === undefined || typeof value.duplicate === "boolean";
}

/**
 * Persist first, then send. Only a valid 2xx score acknowledgement removes the
 * entry; HTTP errors, network loss and malformed success responses stay
 * durable for reload/tab-close recovery.
 */
export function submitScoreWithOutbox(
  entry: ScoreOutboxEntry,
  options: {
    storage?: ScoreOutboxStorage | null;
    fetcher?: typeof fetch;
    now?: number;
    actingOwnerId?: string;
    signal?: AbortSignal;
    deadlineMs?: number;
    attemptMs?: number;
  } = {},
): Promise<ScoreSubmissionAck> {
  const storage = options.storage ?? browserStorage();
  let durable: ScoreOutboxEntry;
  try {
    durable = persistScoreSubmission(
      entry,
      storage,
      options.now ?? Date.now(),
    );
  } catch (error) {
    return Promise.reject(error);
  }
  const actingOwnerId = options.actingOwnerId ?? durable.ownerId;
  const key = submissionKey(durable, actingOwnerId);
  const active = inflight.get(key);
  if (active) return active;

  const fetcher = options.fetcher ?? fetch;
  const migratedReplay =
    actingOwnerId.toLowerCase() !== durable.ownerId.toLowerCase();
  const requestBody = JSON.stringify(durable.body);
  const request = (async () => {
    const delivery = await runBoundedClientJsonFetch({
      input: "/api/score",
      fetcher,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(migratedReplay
            ? {
                "X-Boss-Paegi-Score-Source-Owner": durable.ownerId,
              }
            : {}),
        },
        body: requestBody,
      },
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      attemptMs: options.attemptMs,
    });
    if (delivery.kind !== "confirmed") {
      // 메시지는 계약(테스트·UI 매핑) 그대로, 원인·사유는 cause/reason 으로 보존.
      // (bounded JSON fetch 는 rejected 를 만들지 않지만 타입상 분기만 유지.)
      throw delivery.kind === "rejected"
        ? new Error("score_submit_response_unconfirmed", {
            cause: delivery.error,
          })
        : unconfirmedOutcomeError(
            delivery,
            delivery.kind === "aborted"
              ? "score_submit_aborted"
              : "score_submit_response_unconfirmed",
          );
    }
    const { response, body } = delivery.value;
    if (!response.ok) {
      throw new ScoreSubmissionHttpError(response.status, body);
    }
    if (!isValidAck(body)) {
      throw new Error("invalid_score_submit_ack");
    }
    const cleared = clearScoreSubmission(
      durable.ownerId,
      durable.submissionId,
      storage,
      options.now ?? Date.now(),
    );
    return cleared ? body : { ...body, outboxClearPending: true };
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

function retryableOutboxError(error: unknown): boolean {
  return !(
    error instanceof ScoreSubmissionHttpError &&
    error.status !== 408 &&
    error.status !== 429 &&
    error.status < 500
  );
}

/**
 * Resume current-owner entries normally. A foreign-owner entry is sent only as
 * a migrated-source replay hint; the DB accepts it exclusively when a durable
 * source→current receipt and the already-moved submission fingerprint match.
 */
export async function drainScoreSubmissionOutbox(
  ownerId: string,
  options: {
    storage?: ScoreOutboxStorage | null;
    fetcher?: typeof fetch;
    delay?: (milliseconds: number) => Promise<void>;
    onSuccess?: (
      entry: ScoreOutboxEntry,
      acknowledgement: ScoreSubmissionAck,
    ) => void;
    now?: number;
    signal?: AbortSignal;
    deadlineMs?: number;
    attemptMs?: number;
  } = {},
): Promise<void> {
  if (!UUID_RE.test(ownerId) || options.signal?.aborted) return;
  const storage = options.storage ?? browserStorage();
  const entries = readScoreSubmissionOutbox(
    storage,
    options.now ?? Date.now(),
  );
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));

  await Promise.all(
    entries.map(async (entry) => {
      for (
        let attempt = 1;
        attempt <= SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS;
        attempt += 1
      ) {
        if (options.signal?.aborted) return;
        try {
          const acknowledgement = await submitScoreWithOutbox(entry, {
            storage,
            fetcher: options.fetcher,
            now: options.now,
            actingOwnerId: ownerId,
            signal: options.signal,
            deadlineMs: options.deadlineMs,
            attemptMs: options.attemptMs,
          });
          options.onSuccess?.(entry, acknowledgement);
          return;
        } catch (error) {
          if (options.signal?.aborted) return;
          const wait = scoreSubmissionRetryDelayMs(attempt);
          if (!retryableOutboxError(error) || wait === null) return;
          await delay(wait);
        }
      }
    }),
  );
}
