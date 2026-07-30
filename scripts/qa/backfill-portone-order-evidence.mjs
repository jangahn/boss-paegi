#!/usr/bin/env node

/**
 * One-time immutable PortOne checkout-evidence backfill.
 *
 * The command is deliberately read-only unless `--apply` is present:
 *
 *   node --env-file=.env.local scripts/qa/backfill-portone-order-evidence.mjs
 *   node --env-file=.env.local scripts/qa/backfill-portone-order-evidence.mjs --apply
 *
 * Safety properties:
 * - every PortOne order is paginated and audited first;
 * - no write starts when any audit blocker exists;
 * - only a complete NULL tuple may transition to a complete verified tuple;
 * - a bounded SECURITY DEFINER RPC repeats every immutable fact as a guard;
 * - its immutable receipt and the row postcondition are both exact-checked;
 * - an unknown RPC result is re-read for concurrent convergence;
 * - logs contain only counters and fixed reason codes, never row ids or secrets.
 */

import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

export const PORTONE_PAYMENT_API_BASE = "https://api.portone.io";
export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export const REQUIRED_ENV_NAMES = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PORTONE_V2_API_SECRET",
  "NEXT_PUBLIC_PORTONE_STORE_ID",
]);

const LIVE_CHANNEL_ENV_NAMES = Object.freeze([
  "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD",
  "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY",
  "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY",
]);

const TEST_CHANNEL_ENV_NAMES = Object.freeze([
  "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST",
  "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST",
  "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST",
]);

const PAY_CHANNELS = new Set(["card", "tosspay", "kakaopay"]);
const CHANNEL_ENV_BY_IDENTITY = Object.freeze([
  ["live:card", "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD"],
  ["live:tosspay", "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY"],
  ["live:kakaopay", "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY"],
  ["test:card", "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST"],
  ["test:tosspay", "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST"],
  ["test:kakaopay", "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST"],
]);

const ORDER_SELECT = [
  "order_uuid",
  "provider",
  "payment_id",
  "amount",
  "is_test",
  "pay_channel",
  "expected_store_id",
  "expected_currency",
  "expected_channel_key",
].join(",");

const PORTONE_STATUSES = new Set([
  "READY",
  "PENDING",
  "PAY_PENDING",
  "VIRTUAL_ACCOUNT_ISSUED",
  "PAID",
  "FAILED",
  "PARTIAL_CANCELLED",
  "CANCELLED",
]);

const SAFE_WIRE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_MEDIA_TYPE_RE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

export function safeWireText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    SAFE_WIRE_TEXT_RE.test(value)
  );
}

function safeSecret(value, maxLength = 8192) {
  return safeWireText(value, maxLength);
}

function safeSupabaseUrl(value) {
  if (!safeWireText(value, 2048)) return false;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && loopback)) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

export function parseBackfillArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, reason: "invalid_arguments" };
  }
  if (argv.length === 0) return { ok: true, apply: false };
  if (argv.length === 1 && argv[0] === "--apply") {
    return { ok: true, apply: true };
  }
  return { ok: false, reason: "unsupported_argument" };
}

/**
 * Convert environment variables into a validated runtime configuration.
 * Returned issues contain names and fixed reason codes only; values are never
 * echoed.
 */
export function buildBackfillConfig(env) {
  const source = record(env) ?? {};
  const issues = [];

  for (const name of REQUIRED_ENV_NAMES) {
    if (typeof source[name] !== "string" || source[name].length === 0) {
      issues.push({ name, reason: "missing" });
    }
  }

  if (
    typeof source.NEXT_PUBLIC_SUPABASE_URL === "string" &&
    source.NEXT_PUBLIC_SUPABASE_URL.length > 0 &&
    !safeSupabaseUrl(source.NEXT_PUBLIC_SUPABASE_URL)
  ) {
    issues.push({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      reason: "unsafe_value",
    });
  }
  if (
    typeof source.SUPABASE_SERVICE_ROLE_KEY === "string" &&
    source.SUPABASE_SERVICE_ROLE_KEY.length > 0 &&
    !safeSecret(source.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    issues.push({
      name: "SUPABASE_SERVICE_ROLE_KEY",
      reason: "unsafe_value",
    });
  }
  if (
    typeof source.PORTONE_V2_API_SECRET === "string" &&
    source.PORTONE_V2_API_SECRET.length > 0 &&
    !safeSecret(source.PORTONE_V2_API_SECRET)
  ) {
    issues.push({
      name: "PORTONE_V2_API_SECRET",
      reason: "unsafe_value",
    });
  }
  if (
    typeof source.NEXT_PUBLIC_PORTONE_STORE_ID === "string" &&
    source.NEXT_PUBLIC_PORTONE_STORE_ID.length > 0 &&
    !safeWireText(source.NEXT_PUBLIC_PORTONE_STORE_ID, 128)
  ) {
    issues.push({
      name: "NEXT_PUBLIC_PORTONE_STORE_ID",
      reason: "unsafe_value",
    });
  }

  const allChannelNames = [
    ...LIVE_CHANNEL_ENV_NAMES,
    ...TEST_CHANNEL_ENV_NAMES,
  ];
  for (const name of allChannelNames) {
    if (
      typeof source[name] === "string" &&
      source[name].length > 0 &&
      !safeWireText(source[name], 256)
    ) {
      issues.push({ name, reason: "unsafe_value" });
    }
  }

  const channelValues = allChannelNames
    .map((name) => source[name])
    .filter((value) => safeWireText(value, 256));
  if (channelValues.length === 0) {
    issues.push({ name: "PORTONE_CHANNEL_KEYS", reason: "missing" });
  }
  if (new Set(channelValues).size !== channelValues.length) {
    issues.push({ name: "PORTONE_CHANNEL_KEYS", reason: "duplicate_value" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const channelKeyByIdentity = new Map(
    CHANNEL_ENV_BY_IDENTITY.flatMap(([identity, name]) =>
      safeWireText(source[name], 256) ? [[identity, source[name]]] : [],
    ),
  );

  return {
    ok: true,
    config: {
      supabaseUrl: source.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: source.SUPABASE_SERVICE_ROLE_KEY,
      portoneApiSecret: source.PORTONE_V2_API_SECRET,
      storeId: source.NEXT_PUBLIC_PORTONE_STORE_ID,
      channelKeyByIdentity,
    },
  };
}

export function validateLocalOrder(row) {
  const value = record(row);
  if (!value) return { ok: false, reason: "local_row_invalid" };
  if (value.provider !== "portone") {
    return { ok: false, reason: "local_provider_invalid" };
  }
  if (typeof value.order_uuid !== "string" || !UUID_RE.test(value.order_uuid)) {
    return { ok: false, reason: "local_order_uuid_invalid" };
  }
  if (
    !safeWireText(value.payment_id, 500) ||
    value.payment_id !==
      value.order_uuid.toLowerCase().replaceAll("-", "")
  ) {
    return { ok: false, reason: "local_payment_id_invalid" };
  }
  if (!Number.isSafeInteger(value.amount) || value.amount <= 0) {
    return { ok: false, reason: "local_amount_invalid" };
  }
  if (typeof value.is_test !== "boolean") {
    return { ok: false, reason: "local_mode_invalid" };
  }
  if (
    value.pay_channel !== null &&
    (typeof value.pay_channel !== "string" ||
      !PAY_CHANNELS.has(value.pay_channel))
  ) {
    return { ok: false, reason: "local_pay_channel_invalid" };
  }
  return { ok: true, row: value };
}

/**
 * Truth table for the immutable expected tuple.
 *
 * Only NULL/NULL/NULL is legacy and only three valid strings is complete.
 * Every other combination is a blocker, including undefined and malformed
 * values.
 */
export function classifyExpectedTuple(row) {
  const value = record(row);
  if (!value) return { kind: "blocker", reason: "tuple_invalid" };
  const tuple = [
    value.expected_store_id,
    value.expected_currency,
    value.expected_channel_key,
  ];
  if (tuple.every((entry) => entry === null)) {
    return { kind: "legacy" };
  }
  if (tuple.some((entry) => entry === null)) {
    return { kind: "blocker", reason: "tuple_partial" };
  }
  if (
    !safeWireText(value.expected_store_id, 128) ||
    typeof value.expected_currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.expected_currency) ||
    !safeWireText(value.expected_channel_key, 256)
  ) {
    return { kind: "blocker", reason: "tuple_invalid" };
  }
  return {
    kind: "complete",
    evidence: {
      expected_store_id: value.expected_store_id,
      expected_currency: value.expected_currency,
      expected_channel_key: value.expected_channel_key,
    },
  };
}

/**
 * Validate the exact economic identity needed to derive/audit an immutable
 * checkout tuple. Additive provider fields are ignored.
 */
export function validateProviderPayment(row, body, config) {
  const raw = record(body);
  if (!raw) return { ok: false, reason: "provider_body_invalid" };

  if (!safeWireText(raw.id, 500)) {
    return { ok: false, reason: "provider_id_invalid" };
  }
  if (raw.id !== row.payment_id) {
    return { ok: false, reason: "provider_id_mismatch" };
  }
  if (typeof raw.status !== "string" || !PORTONE_STATUSES.has(raw.status)) {
    return { ok: false, reason: "provider_status_invalid" };
  }

  const amount = record(raw.amount);
  if (
    !amount ||
    !Number.isSafeInteger(amount.total) ||
    amount.total <= 0
  ) {
    return { ok: false, reason: "provider_amount_invalid" };
  }
  if (amount.total !== row.amount) {
    return { ok: false, reason: "provider_amount_mismatch" };
  }
  if (raw.currency !== "KRW") {
    return { ok: false, reason: "provider_currency_mismatch" };
  }
  if (!safeWireText(raw.storeId, 128)) {
    return { ok: false, reason: "provider_store_invalid" };
  }
  if (raw.storeId !== config.storeId) {
    return { ok: false, reason: "provider_store_mismatch" };
  }

  const channel = record(raw.channel);
  if (!channel) {
    return { ok: false, reason: "provider_channel_invalid" };
  }
  if (channel.type !== "LIVE" && channel.type !== "TEST") {
    return { ok: false, reason: "provider_channel_type_invalid" };
  }
  const expectedType = row.is_test ? "TEST" : "LIVE";
  if (channel.type !== expectedType) {
    return { ok: false, reason: "provider_channel_mode_mismatch" };
  }
  if (!safeWireText(channel.key, 256)) {
    return { ok: false, reason: "provider_channel_key_invalid" };
  }
  const configuredMatches =
    config?.channelKeyByIdentity instanceof Map
      ? [...config.channelKeyByIdentity.entries()].filter(
          ([, configuredKey]) => configuredKey === channel.key,
        )
      : [];
  const expectedPrefix = row.is_test ? "test:" : "live:";
  const expectedIdentity =
    row.pay_channel === null
      ? null
      : `${expectedPrefix}${row.pay_channel}`;
  if (
    configuredMatches.length !== 1 ||
    !configuredMatches[0][0].startsWith(expectedPrefix) ||
    (expectedIdentity !== null &&
      configuredMatches[0][0] !== expectedIdentity)
  ) {
    return { ok: false, reason: "provider_channel_key_mismatch" };
  }

  return {
    ok: true,
    evidence: {
      expected_store_id: raw.storeId,
      expected_currency: "KRW",
      expected_channel_key: channel.key,
    },
  };
}

export function completeTupleMatches(tuple, evidence) {
  return (
    tuple.expected_store_id === evidence.expected_store_id &&
    tuple.expected_currency === evidence.expected_currency &&
    tuple.expected_channel_key === evidence.expected_channel_key
  );
}

/**
 * Read a JSON response through a decompressed byte ceiling. Content-Length is
 * an early rejection only; the stream ceiling remains authoritative.
 */
export async function readBoundedJsonObject(
  response,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    return { ok: false, reason: "body_limit_invalid" };
  }

  const contentType = response?.headers?.get?.("content-type");
  const mediaType =
    typeof contentType === "string"
      ? contentType.split(";", 1)[0].trim()
      : "";
  if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
    return { ok: false, reason: "content_type_invalid" };
  }

  const contentLength = response?.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      return { ok: false, reason: "content_length_invalid" };
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared)) {
      return { ok: false, reason: "content_length_invalid" };
    }
    if (declared > maxBodyBytes) {
      return { ok: false, reason: "body_too_large" };
    }
  }

  const reader = response?.body?.getReader?.();
  if (!reader) return { ok: false, reason: "body_missing" };

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        return { ok: false, reason: "body_read_failed" };
      }
      total += part.value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size verdict is already final.
        }
        return { ok: false, reason: "body_too_large" };
      }
      chunks.push(part.value);
    }
  } catch {
    return { ok: false, reason: "body_read_failed" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "body_utf8_invalid" };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "body_json_invalid" };
  }
  if (!record(parsed)) {
    return { ok: false, reason: "provider_body_invalid" };
  }
  return { ok: true, value: parsed };
}

export async function fetchCanonicalPayment({
  row,
  config,
  fetchImpl,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "fetch_unavailable" };
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return { ok: false, reason: "request_timeout_invalid" };
  }

  let response;
  try {
    const encodedPaymentId = encodeURIComponent(row.payment_id);
    const expectedPath = `/payments/${encodedPaymentId}`;
    const endpoint = new URL(
      expectedPath,
      PORTONE_PAYMENT_API_BASE,
    );
    if (
      endpoint.origin !== PORTONE_PAYMENT_API_BASE ||
      endpoint.pathname !== expectedPath
    ) {
      return { ok: false, reason: "provider_endpoint_invalid" };
    }
    endpoint.searchParams.set("storeId", config.storeId);
    response = await fetchImpl(
      endpoint,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `PortOne ${config.portoneApiSecret}`,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
        cache: "no-store",
        redirect: "error",
      },
    );
  } catch {
    return { ok: false, reason: "provider_unreachable" };
  }

  if (!response || typeof response.ok !== "boolean") {
    return { ok: false, reason: "provider_response_invalid" };
  }
  if (response.redirected === true) {
    return { ok: false, reason: "provider_redirect_refused" };
  }
  if (!response.ok) {
    return { ok: false, reason: "provider_http_error" };
  }

  const decoded = await readBoundedJsonObject(response, maxBodyBytes);
  if (!decoded.ok) return decoded;
  return validateProviderPayment(row, decoded.value, config);
}

async function readOrderPage(client, afterOrderUuid, pageSize) {
  try {
    const table = client.from("orders");
    let query =
      afterOrderUuid === null
        ? table.select(ORDER_SELECT, { count: "exact" })
        : table.select(ORDER_SELECT);
    query = query
      .eq("provider", "portone")
      .order("order_uuid", { ascending: true })
      .limit(pageSize);
    if (afterOrderUuid !== null) {
      query = query.gt("order_uuid", afterOrderUuid);
    }
    const result = await query;
    if (result?.error || !Array.isArray(result?.data)) {
      return { ok: false, reason: "db_scan_failed" };
    }
    return {
      ok: true,
      rows: result.data,
      count: afterOrderUuid === null ? result.count : null,
    };
  } catch {
    return { ok: false, reason: "db_scan_failed" };
  }
}

function sameGuardedOrder(actual, expected) {
  return (
    actual?.order_uuid === expected.order_uuid &&
    actual?.provider === "portone" &&
    actual?.payment_id === expected.payment_id &&
    actual?.amount === expected.amount &&
    actual?.is_test === expected.is_test &&
    actual?.pay_channel === expected.pay_channel
  );
}

function rowConverged(actual, expected, evidence) {
  if (!sameGuardedOrder(actual, expected)) return false;
  const tuple = classifyExpectedTuple(actual);
  return (
    tuple.kind === "complete" &&
    completeTupleMatches(tuple.evidence, evidence)
  );
}

export function validateBackfillReceipt(value, expected, evidence) {
  const receipt = record(value);
  const expectedRow = record(expected);
  const expectedEvidence = record(evidence);
  if (
    !receipt ||
    !expectedRow ||
    !expectedEvidence ||
    (receipt.outcome !== "updated" &&
      receipt.outcome !== "already_exact") ||
    receipt.order_uuid !== expectedRow.order_uuid ||
    receipt.payment_id !== expectedRow.payment_id ||
    receipt.amount !== expectedRow.amount ||
    receipt.is_test !== expectedRow.is_test ||
    receipt.pay_channel !== expectedRow.pay_channel ||
    receipt.expected_store_id !== expectedEvidence.expected_store_id ||
    receipt.expected_currency !== expectedEvidence.expected_currency ||
    receipt.expected_channel_key !== expectedEvidence.expected_channel_key
  ) {
    return { ok: false, reason: "rpc_receipt_invalid" };
  }
  return { ok: true, outcome: receipt.outcome };
}

async function rereadOrder(client, orderUuid) {
  try {
    const result = await client
      .from("orders")
      .select(ORDER_SELECT)
      .eq("order_uuid", orderUuid)
      .maybeSingle();
    if (result?.error) {
      return { ok: false, reason: "db_reread_failed" };
    }
    if (!result?.data) {
      return { ok: false, reason: "race_row_missing" };
    }
    return { ok: true, row: result.data };
  } catch {
    return { ok: false, reason: "db_reread_failed" };
  }
}

async function backfillEvidenceViaRpc(client, row, evidence) {
  let result;
  try {
    result = await client.rpc("backfill_portone_order_payment_evidence", {
      p_order_uuid: row.order_uuid,
      p_payment_id: row.payment_id,
      p_amount: row.amount,
      p_is_test: row.is_test,
      p_pay_channel: row.pay_channel,
      p_expected_store_id: evidence.expected_store_id,
      p_expected_currency: evidence.expected_currency,
      p_expected_channel_key: evidence.expected_channel_key,
    });
  } catch {
    result = { data: null, error: true };
  }

  if (!result?.error) {
    const receipt = validateBackfillReceipt(result?.data, row, evidence);
    if (!receipt.ok) {
      // Still perform the postcondition read for diagnosis, but a malformed
      // SECURITY DEFINER receipt is itself a contract blocker.
      await rereadOrder(client, row.order_uuid);
      return receipt;
    }
    const postcondition = await rereadOrder(client, row.order_uuid);
    if (
      !postcondition.ok ||
      !rowConverged(postcondition.row, row, evidence)
    ) {
      return { ok: false, reason: "rpc_postcondition_mismatch" };
    }
    return {
      ok: true,
      kind:
        receipt.outcome === "updated" ? "updated" : "race_converged",
    };
  }

  // An errored request may have committed before the HTTP response was lost.
  const reread = await rereadOrder(client, row.order_uuid);
  if (!reread.ok) return reread;
  return rowConverged(reread.row, row, evidence)
    ? { ok: true, kind: "race_converged" }
    : {
        ok: false,
        reason: "rpc_unknown_not_converged",
      };
}

async function countUnresolvedPortoneOrders(client) {
  try {
    const result = await client
      .from("orders")
      .select("order_uuid", { head: true, count: "exact" })
      .eq("provider", "portone")
      .or(
        "payment_id.is.null,expected_store_id.is.null,expected_currency.is.null,expected_channel_key.is.null",
      );
    if (
      result?.error ||
      !Number.isSafeInteger(result?.count) ||
      result.count < 0
    ) {
      return { ok: false, reason: "postcheck_failed" };
    }
    return { ok: true, count: result.count };
  } catch {
    return { ok: false, reason: "postcheck_failed" };
  }
}

async function countAllPortoneOrders(client) {
  try {
    const result = await client
      .from("orders")
      .select("order_uuid", { head: true, count: "exact" })
      .eq("provider", "portone");
    if (
      result?.error ||
      !Number.isSafeInteger(result?.count) ||
      result.count < 0
    ) {
      return { ok: false, reason: "db_count_verify_failed" };
    }
    return { ok: true, count: result.count };
  } catch {
    return { ok: false, reason: "db_count_verify_failed" };
  }
}

function validRunConfig(config) {
  const value = record(config);
  const validIdentities = new Set(
    CHANNEL_ENV_BY_IDENTITY.map(([identity]) => identity),
  );
  return (
    value !== null &&
    safeSupabaseUrl(value.supabaseUrl) &&
    safeSecret(value.serviceRoleKey) &&
    safeSecret(value.portoneApiSecret) &&
    safeWireText(value.storeId, 128) &&
    value.channelKeyByIdentity instanceof Map &&
    value.channelKeyByIdentity.size > 0 &&
    value.channelKeyByIdentity.size <= CHANNEL_ENV_BY_IDENTITY.length &&
    [...value.channelKeyByIdentity.entries()].every(
      ([identity, channelKey]) =>
        validIdentities.has(identity) &&
        safeWireText(channelKey, 256),
    ) &&
    new Set(value.channelKeyByIdentity.values()).size ===
      value.channelKeyByIdentity.size
  );
}

/**
 * Full two-phase audit/backfill. `client` and `fetchImpl` are injected so the
 * same orchestration is exhaustively unit-testable without production access.
 */
export async function runPortoneOrderEvidenceBackfill({
  client,
  fetchImpl = globalThis.fetch,
  config,
  apply = false,
  pageSize = DEFAULT_PAGE_SIZE,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  logger = console.log,
} = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  const summary = {
    apply: apply === true,
    scanned: 0,
    complete: 0,
    legacy: 0,
    wouldUpdate: 0,
    updated: 0,
    raceConverged: 0,
    blockers: 0,
    blockerReasons: {},
    remainingUnresolvedRows: null,
    exitCode: 1,
  };

  const addBlocker = (reason, rowNumber = null) => {
    summary.blockers += 1;
    summary.blockerReasons[reason] =
      (summary.blockerReasons[reason] ?? 0) + 1;
    log(
      rowNumber === null
        ? `blocker reason=${reason}`
        : `blocker row=${rowNumber} reason=${reason}`,
    );
  };

  log(`portone-evidence-backfill mode=${summary.apply ? "apply" : "dry-run"}`);

  if (
    !client ||
    typeof client.from !== "function" ||
    typeof client.rpc !== "function" ||
    !validRunConfig(config) ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > 1000 ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0
  ) {
    addBlocker("runtime_configuration_invalid");
    return summary;
  }

  const legacyActions = [];
  let expectedTotal = null;
  let afterOrderUuid = null;
  let lastOrderUuid = null;
  let scanComplete = false;

  for (;;) {
    const page = await readOrderPage(client, afterOrderUuid, pageSize);
    if (!page.ok) {
      addBlocker(page.reason);
      break;
    }

    if (expectedTotal === null) {
      if (!Number.isSafeInteger(page.count) || page.count < 0) {
        addBlocker("db_count_invalid");
        break;
      }
      expectedTotal = page.count;
    }
    if (page.rows.length > pageSize) {
      addBlocker("db_page_cardinality_invalid");
      break;
    }
    if (page.rows.length === 0) {
      scanComplete = true;
      break;
    }

    for (const candidate of page.rows) {
      summary.scanned += 1;
      const rowNumber = summary.scanned;
      const candidateRecord = record(candidate);
      const candidateOrderUuid = candidateRecord?.order_uuid;
      if (
        typeof candidateOrderUuid !== "string" ||
        !UUID_RE.test(candidateOrderUuid)
      ) {
        addBlocker("local_order_uuid_invalid", rowNumber);
        continue;
      }
      if (
        lastOrderUuid !== null &&
        candidateOrderUuid <= lastOrderUuid
      ) {
        addBlocker("pagination_order_invalid", rowNumber);
        continue;
      }
      lastOrderUuid = candidateOrderUuid;

      const local = validateLocalOrder(candidate);
      if (!local.ok) {
        addBlocker(local.reason, rowNumber);
        continue;
      }
      const row = local.row;

      const tuple = classifyExpectedTuple(row);
      if (tuple.kind === "blocker") {
        addBlocker(tuple.reason, rowNumber);
        continue;
      }

      const provider = await fetchCanonicalPayment({
        row,
        config,
        fetchImpl,
        maxBodyBytes,
        requestTimeoutMs,
      });
      if (!provider.ok) {
        addBlocker(provider.reason, rowNumber);
        continue;
      }

      if (tuple.kind === "complete") {
        if (!completeTupleMatches(tuple.evidence, provider.evidence)) {
          addBlocker("complete_tuple_mismatch", rowNumber);
          continue;
        }
        summary.complete += 1;
      } else {
        summary.legacy += 1;
        summary.wouldUpdate += 1;
        legacyActions.push({
          row: {
            order_uuid: row.order_uuid,
            provider: row.provider,
            payment_id: row.payment_id,
            amount: row.amount,
            is_test: row.is_test,
            pay_channel: row.pay_channel,
          },
          evidence: provider.evidence,
        });
      }
    }

    afterOrderUuid = page.rows.at(-1)?.order_uuid ?? null;
    if (
      !safeWireText(afterOrderUuid, 128) ||
      (lastOrderUuid !== null && afterOrderUuid !== lastOrderUuid)
    ) {
      addBlocker("pagination_cursor_invalid");
      break;
    }
    if (summary.scanned > expectedTotal) {
      addBlocker("dataset_changed_during_scan");
      break;
    }
    if (page.rows.length < pageSize) {
      scanComplete = true;
      break;
    }
  }

  if (
    scanComplete &&
    expectedTotal !== null &&
    summary.scanned !== expectedTotal
  ) {
    addBlocker("dataset_changed_during_scan");
  }
  if (scanComplete && expectedTotal !== null) {
    const finalAuditCount = await countAllPortoneOrders(client);
    if (!finalAuditCount.ok) {
      addBlocker(finalAuditCount.reason);
    } else if (
      finalAuditCount.count !== expectedTotal &&
      !summary.blockerReasons.dataset_changed_during_scan
    ) {
      // Catches inserts behind the UUID cursor as well as deletes that happen
      // after their page was read.
      addBlocker("dataset_changed_during_scan");
    }
  }

  // Writes are a separate phase. A single audit blocker prevents every write.
  if (summary.apply && summary.blockers === 0 && scanComplete) {
    for (const action of legacyActions) {
      const outcome = await backfillEvidenceViaRpc(
        client,
        action.row,
        action.evidence,
      );
      if (!outcome.ok) {
        addBlocker(outcome.reason);
        break;
      }
      if (outcome.kind === "updated") summary.updated += 1;
      else summary.raceConverged += 1;
    }
  } else if (summary.apply && summary.blockers > 0) {
    log("apply_skipped reason=audit_blockers");
  }

  if (summary.apply) {
    const postcheck = await countUnresolvedPortoneOrders(client);
    if (!postcheck.ok) {
      addBlocker(postcheck.reason);
    } else {
      summary.remainingUnresolvedRows = postcheck.count;
      if (postcheck.count !== 0) {
        addBlocker("unresolved_portone_rows_remaining");
      }
    }
    // Keep the total-count verification last. Any row inserted after the
    // unresolved-row check but before this linearization point (including a
    // complete tuple behind the UUID cursor) changes the count and forces a
    // retry.
    const finalTotal = await countAllPortoneOrders(client);
    if (!finalTotal.ok) {
      addBlocker("postcheck_failed");
    } else if (
      expectedTotal === null ||
      finalTotal.count !== expectedTotal
    ) {
      addBlocker("dataset_changed_during_apply");
    }
  }

  summary.exitCode = summary.blockers === 0 ? 0 : 1;
  log(
    [
      "summary",
      `scanned=${summary.scanned}`,
      `complete=${summary.complete}`,
      `legacy=${summary.legacy}`,
      `would_update=${summary.wouldUpdate}`,
      `updated=${summary.updated}`,
      `race_converged=${summary.raceConverged}`,
      `blockers=${summary.blockers}`,
      `remaining_unresolved=${summary.remainingUnresolvedRows ?? "not_checked"}`,
      `exit_code=${summary.exitCode}`,
    ].join(" "),
  );
  return summary;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const logger =
    typeof dependencies.logger === "function"
      ? dependencies.logger
      : console.log;
  const parsedArgs = parseBackfillArgs(argv);
  if (!parsedArgs.ok) {
    logger(`blocker reason=${parsedArgs.reason}`);
    return 1;
  }

  const built = buildBackfillConfig(env);
  if (!built.ok) {
    for (const issue of built.issues) {
      logger(`config_blocker name=${issue.name} reason=${issue.reason}`);
    }
    return 1;
  }

  let client = dependencies.client;
  if (!client) {
    client = createClient(
      built.config.supabaseUrl,
      built.config.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  const result = await runPortoneOrderEvidenceBackfill({
    client,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    config: built.config,
    apply: parsedArgs.apply,
    logger,
  });
  return result.exitCode;
}

function isDirectInvocation() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isDirectInvocation()) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      // Do not print exception messages: third-party/database errors can contain
      // identifiers or request details.
      console.error("blocker reason=unexpected_failure");
      process.exitCode = 1;
    });
}
