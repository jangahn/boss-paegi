import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_BODY_BYTES,
  PORTONE_PAYMENT_API_BASE,
  REQUIRED_ENV_NAMES,
  buildBackfillConfig,
  classifyExpectedTuple,
  completeTupleMatches,
  fetchCanonicalPayment,
  main,
  parseBackfillArgs,
  readBoundedJsonObject,
  runPortoneOrderEvidenceBackfill as rawRunPortoneOrderEvidenceBackfill,
  safeWireText,
  validateBackfillReceipt,
  validateLocalOrder,
  validateProviderPayment,
} from "../../scripts/qa/backfill-portone-order-evidence.mjs";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  PORTONE_V2_API_SECRET: "portone-api-secret",
  NEXT_PUBLIC_PORTONE_STORE_ID: "store-current",
  NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD: "channel-live-card",
  NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY: "channel-live-tosspay",
  NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY: "channel-live-kakaopay",
  NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST: "channel-test-card",
  NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST: "channel-test-tosspay",
  NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST: "channel-test-kakaopay",
} as const;
const ENV_RECORD: Record<string, string> = { ...ENV };
type BackfillSummary = {
  apply: boolean;
  scanned: number;
  complete: number;
  legacy: number;
  wouldUpdate: number;
  updated: number;
  raceConverged: number;
  blockers: number;
  blockerReasons: Record<string, number>;
  remainingUnresolvedRows: number | null;
  exitCode: number;
};
const runPortoneOrderEvidenceBackfill =
  rawRunPortoneOrderEvidenceBackfill as unknown as (
    options: Record<string, unknown>,
  ) => Promise<BackfillSummary>;

function blockerCount(
  result: { blockerReasons: unknown },
  reason: string,
) {
  return (result.blockerReasons as Record<string, number>)[reason];
}

function config() {
  const result = buildBackfillConfig({ ...ENV });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("test config unexpectedly invalid");
  return result.config;
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function order(
  index: number,
  overrides: Record<string, unknown> = {},
) {
  const orderUuid = uuid(index);
  return {
    order_uuid: orderUuid,
    provider: "portone",
    payment_id: orderUuid.replaceAll("-", ""),
    amount: 3000,
    is_test: false,
    pay_channel: "card",
    expected_store_id: null,
    expected_currency: null,
    expected_channel_key: null,
    ...overrides,
  };
}

function configuredChannelKey(row: Record<string, unknown>) {
  if (
    row.pay_channel === null &&
    typeof row.provider_channel_key === "string"
  ) {
    return row.provider_channel_key;
  }
  const suffix = row.is_test === true ? "_TEST" : "";
  const method = String(row.pay_channel);
  const envName =
    method === "card"
      ? `NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD${suffix}`
      : method === "tosspay"
        ? `NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY${suffix}`
        : method === "kakaopay"
          ? `NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY${suffix}`
          : "";
  const value = ENV_RECORD[envName];
  assert.ok(value, `missing configured channel for ${method}/${suffix}`);
  return value;
}

function paymentBody(
  row: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const isTest = row.is_test === true;
  const channel =
    Object.prototype.hasOwnProperty.call(overrides, "channel")
      ? overrides.channel
      : {
          type: isTest ? "TEST" : "LIVE",
          key: configuredChannelKey(row),
        };
  return {
    id: row.payment_id,
    status: "PAID",
    transactionId: `transaction-${row.payment_id}`,
    amount: { total: row.amount, cancelled: 0 },
    currency: "KRW",
    storeId: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
    channel,
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

type Filter =
  | { op: "eq"; field: string; value: unknown }
  | { op: "not-is"; field: string; value: unknown }
  | { op: "is"; field: string; value: unknown }
  | { op: "gt"; field: string; value: unknown }
  | { op: "or-null"; fields: string[] };

class FakeSupabase {
  rows: Array<Record<string, unknown>>;
  updateAttempts = 0;
  updateCalls: Array<{
    patch: Record<string, unknown>;
    filters: Filter[];
  }> = [];
  scanCalls = 0;
  rpcAttempts = 0;
  rpcCalls: Array<{
    name: string;
    params: Record<string, unknown>;
  }> = [];
  failScan = false;
  failPostcheck = false;
  initialCountDelta = 0;
  postcheckCountOverride: number | null = null;
  afterScanPage:
    | null
    | ((
        database: FakeSupabase,
        scanCall: number,
      ) => void | Promise<void>) = null;
  beforeUpdate:
    | null
    | ((database: FakeSupabase, builder: FakeBuilder) => void | Promise<void>) =
    null;
  beforeRpc:
    | null
    | ((
        database: FakeSupabase,
        params: Record<string, unknown>,
      ) => void | Promise<void>) = null;
  updateResponse:
    | "normal"
    | "zero"
    | "error_before_apply"
    | "error_after_apply" = "normal";
  rpcResponse:
    | "normal"
    | "error_before_apply"
    | "error_after_apply"
    | "invalid_receipt"
    | "valid_without_apply" = "normal";

  constructor(rows: Array<Record<string, unknown>>) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  from(table: string) {
    assert.equal(table, "orders");
    return new FakeBuilder(this);
  }

  async rpc(name: string, params: Record<string, unknown>) {
    assert.equal(name, "backfill_portone_order_payment_evidence");
    this.rpcAttempts += 1;
    this.rpcCalls.push({ name, params: { ...params } });

    const hook = this.beforeRpc;
    this.beforeRpc = null;
    if (hook) await hook(this, params);
    if (this.rpcResponse === "error_before_apply") {
      return { data: null, error: { code: "fake" } };
    }

    const index = this.rows.findIndex(
      (row) =>
        row.order_uuid === params.p_order_uuid &&
        row.provider === "portone" &&
        row.payment_id === params.p_payment_id &&
        row.amount === params.p_amount &&
        row.is_test === params.p_is_test &&
        row.pay_channel === params.p_pay_channel,
    );
    if (index < 0) return { data: null, error: { code: "guard_mismatch" } };

    const row = this.rows[index];
    const evidence = {
      expected_store_id: params.p_expected_store_id,
      expected_currency: params.p_expected_currency,
      expected_channel_key: params.p_expected_channel_key,
    };
    const tuple = classifyExpectedTuple(row);
    let outcome: "updated" | "already_exact";
    if (tuple.kind === "legacy") {
      if (this.rpcResponse !== "valid_without_apply") {
        this.rows[index] = { ...row, ...evidence };
      }
      outcome = "updated";
    } else if (
      tuple.kind === "complete" &&
      completeTupleMatches(tuple.evidence!, evidence)
    ) {
      outcome = "already_exact";
    } else {
      return { data: null, error: { code: "tuple_mismatch" } };
    }

    if (this.rpcResponse === "error_after_apply") {
      return { data: null, error: { code: "fake" } };
    }
    const receipt = {
      outcome,
      order_uuid: params.p_order_uuid,
      payment_id: params.p_payment_id,
      amount: params.p_amount,
      is_test: params.p_is_test,
      pay_channel: params.p_pay_channel,
      ...evidence,
    };
    return {
      data:
        this.rpcResponse === "invalid_receipt"
          ? { ...receipt, payment_id: "wrong" }
          : receipt,
      error: null,
    };
  }
}

class FakeBuilder {
  database: FakeSupabase;
  operation: "select" | "update" = "select";
  patch: Record<string, unknown> = {};
  filters: Filter[] = [];
  options: { count?: string; head?: boolean } = {};
  selectedColumns: string[] | null = null;
  orderField: string | null = null;
  ascending = true;
  rowLimit: number | null = null;

  constructor(database: FakeSupabase) {
    this.database = database;
  }

  select(
    columns: string,
    options: { count?: string; head?: boolean } = {},
  ) {
    this.selectedColumns = columns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    this.options = options;
    return this;
  }

  update(patch: Record<string, unknown>) {
    this.operation = "update";
    this.patch = { ...patch };
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ op: "eq", field, value });
    return this;
  }

  not(field: string, operator: string, value: unknown) {
    assert.equal(operator, "is");
    this.filters.push({ op: "not-is", field, value });
    return this;
  }

  is(field: string, value: unknown) {
    this.filters.push({ op: "is", field, value });
    return this;
  }

  gt(field: string, value: unknown) {
    this.filters.push({ op: "gt", field, value });
    return this;
  }

  or(expression: string) {
    assert.equal(
      expression,
      "payment_id.is.null,expected_store_id.is.null,expected_currency.is.null,expected_channel_key.is.null",
    );
    this.filters.push({
      op: "or-null",
      fields: [
        "payment_id",
        "expected_store_id",
        "expected_currency",
        "expected_channel_key",
      ],
    });
    return this;
  }

  order(field: string, options: { ascending?: boolean } = {}) {
    this.orderField = field;
    this.ascending = options.ascending !== false;
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  matches(row: Record<string, unknown>) {
    return this.filters.every((filter) => {
      if (filter.op === "eq") return row[filter.field] === filter.value;
      if (filter.op === "is") return row[filter.field] === filter.value;
      if (filter.op === "not-is") return row[filter.field] !== filter.value;
      if (filter.op === "gt") {
        const rowValue = row[filter.field];
        const filterValue = filter.value;
        return (
          typeof rowValue === "string" &&
          typeof filterValue === "string" &&
          rowValue > filterValue
        );
      }
      return filter.fields.some((field) => row[field] === null);
    });
  }

  project(row: Record<string, unknown>) {
    if (this.selectedColumns === null) return { ...row };
    return Object.fromEntries(
      this.selectedColumns.map((column) => [column, row[column]]),
    );
  }

  async execute() {
    const isScan = this.operation === "select" && this.orderField !== null;
    const isPostcheck =
      this.operation === "select" && this.options.head === true;
    if (isScan) {
      this.database.scanCalls += 1;
      if (this.database.failScan) {
        return { data: null, count: null, error: { code: "fake" } };
      }
    }
    if (isPostcheck && this.database.failPostcheck) {
      return { data: null, count: null, error: { code: "fake" } };
    }

    if (this.operation === "update") {
      this.database.updateAttempts += 1;
      this.database.updateCalls.push({
        patch: { ...this.patch },
        filters: this.filters.map((filter) => ({ ...filter })) as Filter[],
      });
      const hook = this.database.beforeUpdate;
      this.database.beforeUpdate = null;
      if (hook) await hook(this.database, this);
      if (this.database.updateResponse === "error_before_apply") {
        return { data: null, count: null, error: { code: "fake" } };
      }
    }

    let indexed = this.database.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => this.matches(row));
    const countBeforeWindow = indexed.length;

    if (this.orderField) {
      const direction = this.ascending ? 1 : -1;
      const field = this.orderField;
      indexed.sort((left, right) => {
        const a = String(left.row[field]);
        const b = String(right.row[field]);
        return a === b ? 0 : a < b ? -direction : direction;
      });
    }
    if (this.rowLimit !== null) indexed = indexed.slice(0, this.rowLimit);

    if (this.operation === "update") {
      if (this.database.updateResponse === "zero") {
        return { data: [], count: null, error: null };
      }
      for (const match of indexed) {
        this.database.rows[match.index] = {
          ...this.database.rows[match.index],
          ...this.patch,
        };
      }
      const data = indexed.map(({ index }) => ({
        ...this.project(this.database.rows[index]),
      }));
      if (this.database.updateResponse === "error_after_apply") {
        return { data: null, count: null, error: { code: "fake" } };
      }
      return { data, count: null, error: null };
    }

    let count =
      this.options.count === "exact" ? countBeforeWindow : null;
    if (isScan && count !== null) {
      count += this.database.initialCountDelta;
    }
    if (
      isPostcheck &&
      this.filters.some((filter) => filter.op === "or-null") &&
      this.database.postcheckCountOverride !== null
    ) {
      count = this.database.postcheckCountOverride;
    }
    if (this.options.head) return { data: null, count, error: null };
    const response = {
      data: indexed.map(({ row }) => this.project(row)),
      count,
      error: null,
    };
    if (isScan && this.database.afterScanPage) {
      await this.database.afterScanPage(
        this.database,
        this.database.scanCalls,
      );
    }
    return response;
  }

  async maybeSingle() {
    const result = await this.execute();
    if (result.error) return result;
    if (!Array.isArray(result.data) || result.data.length === 0) {
      return { data: null, error: null };
    }
    if (result.data.length !== 1) {
      return { data: null, error: { code: "fake_cardinality" } };
    }
    return { data: result.data[0], error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function providerFetchForRows(rows: Array<Record<string, unknown>>) {
  const byPaymentId = new Map(
    rows.map((row) => [String(row.payment_id), row]),
  );
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const paymentId = decodeURIComponent(
      new URL(url).pathname.split("/").at(-1) ?? "",
    );
    const row = byPaymentId.get(paymentId);
    if (!row) return jsonResponse({}, { status: 404 });
    return jsonResponse(
      paymentBody(row, {
        channel: {
          type: row.is_test ? "TEST" : "LIVE",
          key: configuredChannelKey(row),
        },
      }),
    );
  };
  return { calls, fetchImpl };
}

test("CLI is dry-run by default and only accepts one explicit --apply", () => {
  assert.deepEqual(parseBackfillArgs([]), { ok: true, apply: false });
  assert.deepEqual(parseBackfillArgs(["--apply"]), {
    ok: true,
    apply: true,
  });
  for (const args of [
    ["--dry-run"],
    ["--apply", "--apply"],
    ["--apply", "unexpected"],
    "not-an-array",
  ]) {
    assert.equal(
      parseBackfillArgs(args as string[]).ok,
      false,
    );
  }
});

test("configuration requires credentials, store, and at least one channel without echoing values", () => {
  const valid = buildBackfillConfig({ ...ENV });
  assert.equal(valid.ok, true);

  for (const name of REQUIRED_ENV_NAMES) {
    const candidate = { ...ENV } as Record<string, string>;
    delete candidate[name];
    const result = buildBackfillConfig(candidate);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      const issues = result.issues ?? [];
      assert.ok(
        issues.some(
          (issue) => issue.name === name && issue.reason === "missing",
        ),
      );
      assert.equal(
        JSON.stringify(issues).includes(ENV_RECORD[name]),
        false,
      );
    }
  }

  for (const name of [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST",
  ]) {
    const candidate = { ...ENV } as Record<string, string>;
    delete candidate[name];
    assert.equal(
      buildBackfillConfig(candidate).ok,
      true,
      `${name} is optional when no inventoried row uses it`,
    );
  }
  const testOnly = { ...ENV } as Record<string, string>;
  delete testOnly.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD;
  delete testOnly.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY;
  delete testOnly.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY;
  const testOnlyResult = buildBackfillConfig(testOnly);
  assert.equal(testOnlyResult.ok, true);
  if (testOnlyResult.ok) {
    assert.ok(testOnlyResult.config);
    assert.deepEqual(
      [...testOnlyResult.config.channelKeyByIdentity.keys()].sort(),
      ["test:card", "test:kakaopay", "test:tosspay"],
    );
  }
  const noChannels = { ...ENV } as Record<string, string>;
  for (const name of [
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST",
    "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST",
  ]) {
    delete noChannels[name];
  }
  const noChannelResult = buildBackfillConfig(noChannels);
  assert.equal(noChannelResult.ok, false);
  if (!noChannelResult.ok) {
    assert.ok(noChannelResult.issues);
    assert.ok(
      noChannelResult.issues.some(
        (issue) =>
          issue.name === "PORTONE_CHANNEL_KEYS" &&
          issue.reason === "missing",
      ),
    );
  }

  const unsafe = buildBackfillConfig({
    ...ENV,
    NEXT_PUBLIC_PORTONE_STORE_ID: " store-current",
  });
  assert.equal(unsafe.ok, false);
  for (const [name, value] of [
    ["NEXT_PUBLIC_SUPABASE_URL", "http://untrusted.example"],
    [
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://user:password@project.supabase.co",
    ],
    [
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://project.supabase.co/?query=unexpected",
    ],
    ["SUPABASE_SERVICE_ROLE_KEY", "service\nrole"],
    ["PORTONE_V2_API_SECRET", " portone-secret"],
    ...[
      "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD",
      "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY",
      "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY",
      "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST",
      "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST",
      "NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST",
    ].map((channelName) => [channelName, "bad\nchannel"]),
  ] as Array<[string, string]>) {
    const result = buildBackfillConfig({ ...ENV, [name]: value });
    assert.equal(result.ok, false, `${name} must reject unsafe input`);
    if (!result.ok) {
      assert.ok(
        (result.issues ?? []).some(
          (issue) =>
            issue.name === name && issue.reason === "unsafe_value",
        ),
      );
    }
  }
  assert.equal(
    buildBackfillConfig({
      ...ENV,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    }).ok,
    true,
  );
  const duplicate = buildBackfillConfig({
    ...ENV,
    NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST:
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    const issues = duplicate.issues ?? [];
    assert.ok(
      issues.some(
        (issue) =>
          issue.name === "PORTONE_CHANNEL_KEYS" &&
          issue.reason === "duplicate_value",
      ),
    );
  }
});

test("safe wire text rejects empty, padded, control, and oversized identifiers", () => {
  assert.equal(safeWireText("safe-value", 10), true);
  assert.equal(safeWireText("", 10), false);
  assert.equal(safeWireText(" padded", 10), false);
  assert.equal(safeWireText("bad\nvalue", 20), false);
  assert.equal(safeWireText("x".repeat(11), 10), false);
});

test("expected tuple classifies every NULL/non-NULL combination", () => {
  const fields = [
    "expected_store_id",
    "expected_currency",
    "expected_channel_key",
  ] as const;
  const completeValues = ["store-current", "KRW", "channel-live-card"];
  for (let mask = 0; mask < 8; mask += 1) {
    const row = Object.fromEntries(
      fields.map((field, index) => [
        field,
        mask & (1 << index) ? completeValues[index] : null,
      ]),
    );
    const result = classifyExpectedTuple(row);
    if (mask === 0) assert.equal(result.kind, "legacy");
    else if (mask === 7) assert.equal(result.kind, "complete");
    else {
      assert.deepEqual(result, {
        kind: "blocker",
        reason: "tuple_partial",
      });
    }
  }

  for (const mutation of [
    { expected_store_id: undefined },
    { expected_store_id: "" },
    { expected_currency: "krw" },
    { expected_channel_key: "bad\nkey" },
  ]) {
    assert.deepEqual(
      classifyExpectedTuple({
        expected_store_id: "store-current",
        expected_currency: "KRW",
        expected_channel_key: "channel-live-card",
        ...mutation,
      }),
      { kind: "blocker", reason: "tuple_invalid" },
    );
  }
});

test("local row trust boundary rejects malformed immutable facts", () => {
  assert.equal(validateLocalOrder(order(1)).ok, true);
  assert.equal(
    validateLocalOrder(order(1, { pay_channel: null })).ok,
    true,
  );
  const mutations = [
    { provider: "payapp" },
    { order_uuid: "not-a-uuid" },
    { payment_id: null },
    { payment_id: uuid(1) },
    { payment_id: uuid(2).replaceAll("-", "") },
    { payment_id: "bad\nid" },
    { payment_id: "." },
    { payment_id: ".." },
    { amount: 0 },
    { amount: 1.5 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { is_test: "false" },
    { pay_channel: undefined },
    { pay_channel: "bank" },
  ];
  for (const mutation of mutations) {
    assert.equal(
      validateLocalOrder({ ...order(1), ...mutation }).ok,
      false,
      JSON.stringify(mutation),
    );
  }
});

test("provider evidence accepts every known status and all six configured channels", () => {
  const cfg = config();
  const statuses = [
    "READY",
    "PENDING",
    "PAY_PENDING",
    "VIRTUAL_ACCOUNT_ISSUED",
    "PAID",
    "FAILED",
    "PARTIAL_CANCELLED",
    "CANCELLED",
  ];
  const channels = [
    [false, "card", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD],
    [false, "tosspay", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY],
    [false, "kakaopay", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY],
    [true, "card", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST],
    [
      true,
      "tosspay",
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST,
    ],
    [
      true,
      "kakaopay",
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST,
    ],
  ] as const;

  for (const status of statuses) {
    for (const [isTest, payChannel, channelKey] of channels) {
      const row = order(1, {
        is_test: isTest,
        pay_channel: payChannel,
      });
      const result = validateProviderPayment(
        row,
        paymentBody(row, {
          status,
          channel: {
            type: isTest ? "TEST" : "LIVE",
            key: channelKey,
          },
        }),
        cfg,
      );
      assert.equal(result.ok, true, `${status}/${channelKey}`);
    }
  }
});

test("an order for an unconfigured mode is an evidence blocker", () => {
  const testOnlyEnv = { ...ENV } as Record<string, string>;
  delete testOnlyEnv.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD;
  delete testOnlyEnv.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY;
  delete testOnlyEnv.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY;
  const built = buildBackfillConfig(testOnlyEnv);
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("test-only config unexpectedly invalid");

  const liveOrder = order(1, { is_test: false, pay_channel: "card" });
  assert.deepEqual(
    validateProviderPayment(
      liveOrder,
      paymentBody(liveOrder, {
        channel: {
          type: "LIVE",
          key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
        },
      }),
      built.config,
    ),
    { ok: false, reason: "provider_channel_key_mismatch" },
  );
});

test("channel evidence has exactly six valid cells across the 6x6 identity matrix", () => {
  const cfg = config();
  const identities = [
    [false, "card", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD],
    [false, "tosspay", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY],
    [false, "kakaopay", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY],
    [true, "card", ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST],
    [
      true,
      "tosspay",
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST,
    ],
    [
      true,
      "kakaopay",
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST,
    ],
  ] as const;
  const allKeys = identities.map((identity) => identity[2]);
  let accepted = 0;
  for (const [isTest, payChannel, expectedKey] of identities) {
    const row = order(1, {
      is_test: isTest,
      pay_channel: payChannel,
    });
    for (const candidateKey of allKeys) {
      const result = validateProviderPayment(
        row,
        paymentBody(row, {
          channel: {
            type: isTest ? "TEST" : "LIVE",
            key: candidateKey,
          },
        }),
        cfg,
      );
      assert.equal(
        result.ok,
        candidateKey === expectedKey,
        `${isTest ? "test" : "live"}:${payChannel}/${candidateKey}`,
      );
      if (result.ok) accepted += 1;
      else {
        assert.equal(result.reason, "provider_channel_key_mismatch");
      }
    }
  }
  assert.equal(accepted, 6);
});

test("legacy NULL pay_channel accepts one exact configured key in its immutable mode only", () => {
  const cfg = config();
  const identities = [
    [false, ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD],
    [false, ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY],
    [false, ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY],
    [true, ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST],
    [true, ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST],
    [true, ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST],
  ] as const;
  const allKeys = identities.map((identity) => identity[1]);
  let accepted = 0;
  for (const isTest of [false, true]) {
    const row = order(isTest ? 2 : 1, {
      is_test: isTest,
      pay_channel: null,
    });
    for (const candidateKey of allKeys) {
      const result = validateProviderPayment(
        row,
        paymentBody(row, {
          channel: {
            type: isTest ? "TEST" : "LIVE",
            key: candidateKey,
          },
        }),
        cfg,
      );
      const expected = identities.some(
        ([candidateIsTest, key]) =>
          candidateIsTest === isTest && key === candidateKey,
      );
      assert.equal(result.ok, expected, `${isTest}/${candidateKey}`);
      if (result.ok) accepted += 1;
      else assert.equal(result.reason, "provider_channel_key_mismatch");
    }
  }
  assert.equal(accepted, 6);
});

test("legacy NULL pay_channel rejects an unknown or ambiguously configured provider key", () => {
  const row = order(1, { pay_channel: null });
  const body = paymentBody(row, {
    channel: {
      type: "LIVE",
      key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
    },
  });
  const unknown = validateProviderPayment(
    row,
    {
      ...body,
      channel: { type: "LIVE", key: "channel-not-configured" },
    },
    config(),
  );
  assert.deepEqual(unknown, {
    ok: false,
    reason: "provider_channel_key_mismatch",
  });

  const duplicate = config();
  assert.ok(duplicate);
  duplicate.channelKeyByIdentity.set(
    "live:tosspay",
    ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
  );
  assert.deepEqual(validateProviderPayment(row, body, duplicate), {
    ok: false,
    reason: "provider_channel_key_mismatch",
  });
});

test("provider evidence fails closed for every economic mismatch/boundary", () => {
  const cfg = config();
  const row = order(1);
  const base = paymentBody(row);
  const cases: Array<[unknown, string]> = [
    [null, "provider_body_invalid"],
    [[base], "provider_body_invalid"],
    [{ ...base, id: "bad\nid" }, "provider_id_invalid"],
    [{ ...base, id: "other" }, "provider_id_mismatch"],
    [{ ...base, status: "FUTURE_STATUS" }, "provider_status_invalid"],
    [{ ...base, amount: null }, "provider_amount_invalid"],
    [{ ...base, amount: { total: 0 } }, "provider_amount_invalid"],
    [{ ...base, amount: { total: 1.5 } }, "provider_amount_invalid"],
    [
      { ...base, amount: { total: Number.MAX_SAFE_INTEGER + 1 } },
      "provider_amount_invalid",
    ],
    [{ ...base, amount: { total: 3001 } }, "provider_amount_mismatch"],
    [{ ...base, currency: "USD" }, "provider_currency_mismatch"],
    [{ ...base, storeId: " bad" }, "provider_store_invalid"],
    [{ ...base, storeId: "store-other" }, "provider_store_mismatch"],
    [{ ...base, channel: null }, "provider_channel_invalid"],
    [
      { ...base, channel: { key: "channel-live-card" } },
      "provider_channel_type_invalid",
    ],
    [
      { ...base, channel: { type: "LIVE" } },
      "provider_channel_key_invalid",
    ],
    [
      { ...base, channel: { type: "SANDBOX", key: "channel-live-card" } },
      "provider_channel_type_invalid",
    ],
    [
      { ...base, channel: { type: "TEST", key: "channel-test-card" } },
      "provider_channel_mode_mismatch",
    ],
    [
      { ...base, channel: { type: "LIVE", key: "bad\nkey" } },
      "provider_channel_key_invalid",
    ],
    [
      {
        ...base,
        channel: {
          type: "LIVE",
          key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
        },
      },
      "provider_channel_key_mismatch",
    ],
    [
      { ...base, channel: { type: "LIVE", key: "channel-not-configured" } },
      "provider_channel_key_mismatch",
    ],
  ];
  for (const [body, reason] of cases) {
    assert.deepEqual(validateProviderPayment(row, body, cfg), {
      ok: false,
      reason,
    });
  }
});

test("complete tuple comparison is exact across all three fields", () => {
  const evidence = {
    expected_store_id: "store-current",
    expected_currency: "KRW",
    expected_channel_key: "channel-live-card",
  };
  assert.equal(completeTupleMatches(evidence, evidence), true);
  for (const mutation of [
    { expected_store_id: "other" },
    { expected_currency: "USD" },
    { expected_channel_key: "other" },
  ]) {
    assert.equal(
      completeTupleMatches({ ...evidence, ...mutation }, evidence),
      false,
    );
  }
});

test("backfill RPC receipt is accepted only when every immutable fact is exact", () => {
  const row = order(1);
  const evidence = {
    expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
    expected_currency: "KRW",
    expected_channel_key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
  };
  const receipt = {
    outcome: "updated",
    order_uuid: row.order_uuid,
    payment_id: row.payment_id,
    amount: row.amount,
    is_test: row.is_test,
    pay_channel: row.pay_channel,
    ...evidence,
  };
  assert.deepEqual(validateBackfillReceipt(receipt, row, evidence), {
    ok: true,
    outcome: "updated",
  });
  assert.deepEqual(
    validateBackfillReceipt(
      { ...receipt, outcome: "already_exact" },
      row,
      evidence,
    ),
    { ok: true, outcome: "already_exact" },
  );

  for (const mutation of [
    { outcome: "future" },
    { order_uuid: uuid(2) },
    { payment_id: "other" },
    { amount: 3001 },
    { is_test: true },
    { pay_channel: "tosspay" },
    { expected_store_id: "other" },
    { expected_currency: "USD" },
    { expected_channel_key: "other" },
  ]) {
    assert.deepEqual(
      validateBackfillReceipt({ ...receipt, ...mutation }, row, evidence),
      { ok: false, reason: "rpc_receipt_invalid" },
    );
  }
  assert.deepEqual(validateBackfillReceipt(null, row, evidence), {
    ok: false,
    reason: "rpc_receipt_invalid",
  });
});

test("bounded JSON reader enforces media type, length, stream bytes, UTF-8, JSON, and object body", async () => {
  const validBody = { ok: true };
  const encoded = new TextEncoder().encode(JSON.stringify(validBody));
  assert.deepEqual(
    await readBoundedJsonObject(
      new Response(encoded, {
        headers: { "content-type": "application/problem+json" },
      }),
      encoded.byteLength,
    ),
    { ok: true, value: validBody },
  );

  const cases: Array<[Response, number, string]> = [
    [
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      100,
      "content_type_invalid",
    ],
    [
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "not-a-number",
        },
      }),
      100,
      "content_length_invalid",
    ],
    [
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "101",
        },
      }),
      100,
      "body_too_large",
    ],
    [
      new Response("x".repeat(101), {
        headers: { "content-type": "application/json" },
      }),
      100,
      "body_too_large",
    ],
    [
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { "content-type": "application/json" },
      }),
      100,
      "body_utf8_invalid",
    ],
    [
      new Response("{", {
        headers: { "content-type": "application/json" },
      }),
      100,
      "body_json_invalid",
    ],
    [
      new Response("[]", {
        headers: { "content-type": "application/json" },
      }),
      100,
      "provider_body_invalid",
    ],
  ];
  for (const [response, limit, reason] of cases) {
    assert.deepEqual(await readBoundedJsonObject(response, limit), {
      ok: false,
      reason,
    });
  }
  assert.deepEqual(await readBoundedJsonObject(jsonResponse({}), 0), {
    ok: false,
    reason: "body_limit_invalid",
  });
});

test("canonical fetch uses fixed HTTPS endpoint, authorization, no-store, timeout, and redirect refusal", async () => {
  const cfg = config();
  const row = order(1);
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await fetchCanonicalPayment({
    row,
    config: cfg,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(paymentBody(row));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(
    capturedUrl,
    `${PORTONE_PAYMENT_API_BASE}/payments/${row.payment_id}?storeId=${ENV.NEXT_PUBLIC_PORTONE_STORE_ID}`,
  );
  const scopedUrl = new URL(capturedUrl);
  assert.equal(
    scopedUrl.searchParams.get("storeId"),
    ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
  );
  assert.equal([...scopedUrl.searchParams.keys()].length, 1);
  assert.equal(
    (capturedInit?.headers as Record<string, string> | undefined)
      ?.Authorization,
    `PortOne ${ENV.PORTONE_V2_API_SECRET}`,
  );
  assert.equal(capturedInit?.method, "GET");
  assert.equal(capturedInit?.cache, "no-store");
  assert.equal(capturedInit?.redirect, "error");
  assert.ok(capturedInit?.signal instanceof AbortSignal);

  for (const paymentId of [".", ".."]) {
    let called = false;
    assert.deepEqual(
      await fetchCanonicalPayment({
        row: { ...row, payment_id: paymentId },
        config: cfg,
        fetchImpl: async () => {
          called = true;
          return jsonResponse({});
        },
      }),
      { ok: false, reason: "provider_endpoint_invalid" },
    );
    assert.equal(called, false);
  }

  assert.deepEqual(
    await fetchCanonicalPayment({
      row,
      config: cfg,
      fetchImpl: async () => {
        throw new Error("secret-bearing network detail");
      },
    }),
    { ok: false, reason: "provider_unreachable" },
  );
  assert.deepEqual(
    await fetchCanonicalPayment({
      row,
      config: cfg,
      fetchImpl: async () => jsonResponse({}, { status: 503 }),
    }),
    { ok: false, reason: "provider_http_error" },
  );
  const redirected = jsonResponse(paymentBody(row));
  Object.defineProperty(redirected, "redirected", { value: true });
  assert.deepEqual(
    await fetchCanonicalPayment({
      row,
      config: cfg,
      fetchImpl: async () => redirected,
    }),
    { ok: false, reason: "provider_redirect_refused" },
  );
});

test("dry-run paginates every row, audits complete tuples, and performs no write", async () => {
  const rows = [
    order(1),
    order(2, {
      is_test: true,
      pay_channel: "tosspay",
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key:
        ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY_TEST,
    }),
    order(3, {
      pay_channel: "kakaopay",
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key:
        ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY,
    }),
  ];
  const database = new FakeSupabase(rows);
  const provider = providerFetchForRows(rows);
  const logs: string[] = [];
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: provider.fetchImpl,
    config: config(),
    pageSize: 2,
    logger: (message: string) => logs.push(message),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.scanned, 3);
  assert.equal(result.legacy, 1);
  assert.equal(result.complete, 2);
  assert.equal(result.wouldUpdate, 1);
  assert.equal(result.updated, 0);
  assert.equal(database.updateAttempts, 0);
  assert.equal(database.rpcAttempts, 0);
  assert.equal(database.scanCalls, 2);
  assert.equal(provider.calls.length, 3);
  const output = logs.join("\n");
  for (const forbidden of [
    ...rows.map((row) => String(row.order_uuid)),
    ...rows.map((row) => String(row.payment_id)),
    ENV.SUPABASE_SERVICE_ROLE_KEY,
    ENV.PORTONE_V2_API_SECRET,
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test("failure logging emits fixed reason codes without provider, row, or secret details", async () => {
  const source = order(1);
  const logs: string[] = [];
  const result = await runPortoneOrderEvidenceBackfill({
    client: new FakeSupabase([source]),
    fetchImpl: async () => {
      throw new Error(
        `${source.order_uuid} ${source.payment_id} ${ENV.PORTONE_V2_API_SECRET}`,
      );
    },
    config: config(),
    logger: (message: string) => logs.push(message),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(blockerCount(result, "provider_unreachable"), 1);
  const output = logs.join("\n");
  assert.match(output, /reason=provider_unreachable/);
  for (const forbidden of [
    String(source.order_uuid),
    String(source.payment_id),
    ENV.PORTONE_V2_API_SECRET,
    ENV.SUPABASE_SERVICE_ROLE_KEY,
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test("final count detects a pagination-time insert behind the UUID cursor", async () => {
  const lateRow = order(1);
  const initialRows = [order(2), order(3)];
  const database = new FakeSupabase(initialRows);
  database.afterScanPage = (db, scanCall) => {
    if (scanCall === 1) db.rows.push({ ...lateRow });
  };
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows([
      lateRow,
      ...initialRows,
    ]).fetchImpl,
    config: config(),
    apply: true,
    pageSize: 1,
    logger: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(blockerCount(result, "dataset_changed_during_scan"), 1);
  assert.equal(database.rpcAttempts, 0);
});

test("apply sends every immutable guard to the bounded RPC and requires zero NULL rows", async () => {
  const rows = [
    order(1),
    order(2, {
      is_test: true,
      pay_channel: "tosspay",
    }),
    order(3, {
      is_test: true,
      pay_channel: null,
      provider_channel_key:
        ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_KAKAOPAY_TEST,
    }),
  ];
  const database = new FakeSupabase(rows);
  const provider = providerFetchForRows(rows);
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: provider.fetchImpl,
    config: config(),
    apply: true,
    pageSize: 1,
    logger: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.updated, 3);
  assert.equal(result.remainingUnresolvedRows, 0);
  assert.equal(database.updateAttempts, 0);
  assert.equal(database.rpcAttempts, 3);
  for (const [index, call] of database.rpcCalls.entries()) {
    const source = rows[index];
    assert.equal(
      call.name,
      "backfill_portone_order_payment_evidence",
    );
    assert.deepEqual(call.params, {
      p_order_uuid: source.order_uuid,
      p_payment_id: source.payment_id,
      p_amount: source.amount,
      p_is_test: source.is_test,
      p_pay_channel: source.pay_channel,
      p_expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      p_expected_currency: "KRW",
      p_expected_channel_key: configuredChannelKey(source),
    });
  }
});

test("NULL pay_channel is an exact legacy guard and is never rewritten", async () => {
  const source = order(1, {
    is_test: true,
    pay_channel: null,
    provider_channel_key:
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD_TEST,
  });
  const database = new FakeSupabase([source]);
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.updated, 1);
  assert.equal(database.rpcCalls[0].params.p_pay_channel, null);
  assert.equal(database.rows[0].pay_channel, null);

  const nonNullRow = order(2, { pay_channel: "card" });
  const mismatchDb = new FakeSupabase([nonNullRow]);
  const guardedParams = {
    p_order_uuid: nonNullRow.order_uuid,
    p_payment_id: nonNullRow.payment_id,
    p_amount: nonNullRow.amount,
    p_is_test: nonNullRow.is_test,
    p_pay_channel: null,
    p_expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
    p_expected_currency: "KRW",
    p_expected_channel_key:
      ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
  };
  const mismatch = await mismatchDb.rpc(
    "backfill_portone_order_payment_evidence",
    guardedParams,
  );
  assert.ok(mismatch.error);
  assert.equal(mismatchDb.rows[0].expected_store_id, null);
});

test("any audit blocker prevents every write in apply mode", async () => {
  const rows = [
    order(1),
    order(2, {
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key:
        ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
    }),
  ];
  const database = new FakeSupabase(rows);
  const provider = providerFetchForRows(rows);
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: provider.fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.blockers >= 1);
  assert.equal(blockerCount(result, "complete_tuple_mismatch"), 1);
  assert.equal(database.rpcAttempts, 0);
  assert.equal(database.rows[0].expected_store_id, null);
});

test("NULL payment ids stay visible to the full scan and unresolved postcheck", async () => {
  const source = order(1, { payment_id: null });
  const database = new FakeSupabase([source]);
  const provider = providerFetchForRows([source]);
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: provider.fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.scanned, 1);
  assert.equal(blockerCount(result, "local_payment_id_invalid"), 1);
  assert.equal(
    blockerCount(result, "unresolved_portone_rows_remaining"),
    1,
  );
  assert.equal(result.remainingUnresolvedRows, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(database.rpcAttempts, 0);
});

test("a legacy card order cannot adopt another configured live channel key", async () => {
  const source = order(1, { pay_channel: "card" });
  const database = new FakeSupabase([source]);
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: async () =>
      jsonResponse(
        paymentBody(source, {
          channel: {
            type: "LIVE",
            key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
          },
        }),
      ),
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(
    blockerCount(result, "provider_channel_key_mismatch"),
    1,
  );
  assert.equal(database.rpcAttempts, 0);
  assert.equal(database.rows[0].expected_store_id, null);
});

test("partial tuple is a blocker before provider fetch and cannot be repaired", async () => {
  const rows = [
    order(1, {
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
    }),
  ];
  const database = new FakeSupabase(rows);
  const provider = providerFetchForRows(rows);
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: provider.fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(blockerCount(result, "tuple_partial"), 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(database.rpcAttempts, 0);
  assert.equal(result.remainingUnresolvedRows, 1);
});

test("concurrent RPC converges only on the same verified tuple", async () => {
  const source = order(1);
  const database = new FakeSupabase([source]);
  const provider = providerFetchForRows([source]);
  database.beforeRpc = (db) => {
    db.rows[0] = {
      ...db.rows[0],
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
    };
  };
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: provider.fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.raceConverged, 1);
  assert.equal(result.remainingUnresolvedRows, 0);

  const mismatchDb = new FakeSupabase([source]);
  mismatchDb.beforeRpc = (db) => {
    db.rows[0] = {
      ...db.rows[0],
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key:
        ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSSPAY,
    };
  };
  const mismatch = await runPortoneOrderEvidenceBackfill({
    client: mismatchDb,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(blockerCount(mismatch, "rpc_unknown_not_converged"), 1);
});

test("RPC error cannot converge after pay_channel alone changes", async () => {
  const source = order(1, { pay_channel: "card" });
  const database = new FakeSupabase([source]);
  database.beforeRpc = (db) => {
    db.rows[0] = {
      ...db.rows[0],
      pay_channel: "tosspay",
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
    };
  };
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(
    blockerCount(result, "rpc_unknown_not_converged"),
    1,
  );
  assert.equal(result.raceConverged, 0);
});

test("lost RPC response is accepted only after an exact re-read", async () => {
  const source = order(1);
  const database = new FakeSupabase([source]);
  database.rpcResponse = "error_after_apply";
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.raceConverged, 1);
  assert.equal(result.remainingUnresolvedRows, 0);

  const failed = new FakeSupabase([source]);
  failed.rpcResponse = "error_before_apply";
  const failedResult = await runPortoneOrderEvidenceBackfill({
    client: failed,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(failedResult.exitCode, 1);
  assert.equal(
    blockerCount(failedResult, "rpc_unknown_not_converged"),
    1,
  );
  assert.equal(failedResult.remainingUnresolvedRows, 1);
});

test("RPC success still fails closed on a malformed receipt or missing postcondition", async () => {
  const source = order(1);

  const badReceipt = new FakeSupabase([source]);
  badReceipt.rpcResponse = "invalid_receipt";
  const receiptResult = await runPortoneOrderEvidenceBackfill({
    client: badReceipt,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(receiptResult.exitCode, 1);
  assert.equal(blockerCount(receiptResult, "rpc_receipt_invalid"), 1);
  assert.equal(receiptResult.remainingUnresolvedRows, 0);

  const noPostcondition = new FakeSupabase([source]);
  noPostcondition.rpcResponse = "valid_without_apply";
  const postconditionResult = await runPortoneOrderEvidenceBackfill({
    client: noPostcondition,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(postconditionResult.exitCode, 1);
  assert.equal(
    blockerCount(postconditionResult, "rpc_postcondition_mismatch"),
    1,
  );
  assert.equal(postconditionResult.remainingUnresolvedRows, 1);
});

test("apply is idempotent across retries", async () => {
  const source = order(1);
  const database = new FakeSupabase([source]);
  const first = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(first.exitCode, 0);
  assert.equal(first.updated, 1);
  const attemptsAfterFirst = database.rpcAttempts;

  const second = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows(database.rows).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(second.exitCode, 0);
  assert.equal(second.complete, 1);
  assert.equal(second.legacy, 0);
  assert.equal(second.updated, 0);
  assert.equal(database.rpcAttempts, attemptsAfterFirst);
  assert.equal(second.remainingUnresolvedRows, 0);
});

test("provider failure, scan failure, dataset drift, and postcheck failure all return nonzero", async () => {
  const source = order(1);

  const providerFailure = await runPortoneOrderEvidenceBackfill({
    client: new FakeSupabase([source]),
    fetchImpl: async () => jsonResponse({}, { status: 500 }),
    config: config(),
    logger: () => {},
  });
  assert.equal(providerFailure.exitCode, 1);
  assert.equal(blockerCount(providerFailure, "provider_http_error"), 1);

  const scanDb = new FakeSupabase([source]);
  scanDb.failScan = true;
  const scanFailure = await runPortoneOrderEvidenceBackfill({
    client: scanDb,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    logger: () => {},
  });
  assert.equal(scanFailure.exitCode, 1);
  assert.equal(blockerCount(scanFailure, "db_scan_failed"), 1);

  const driftDb = new FakeSupabase([source]);
  driftDb.initialCountDelta = 1;
  const drift = await runPortoneOrderEvidenceBackfill({
    client: driftDb,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    logger: () => {},
  });
  assert.equal(drift.exitCode, 1);
  assert.equal(blockerCount(drift, "dataset_changed_during_scan"), 1);

  const postcheckDb = new FakeSupabase([
    order(1, {
      expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
      expected_currency: "KRW",
      expected_channel_key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
    }),
  ]);
  postcheckDb.failPostcheck = true;
  const postcheck = await runPortoneOrderEvidenceBackfill({
    client: postcheckDb,
    fetchImpl: providerFetchForRows(postcheckDb.rows).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(postcheck.exitCode, 1);
  assert.ok(blockerCount(postcheck, "postcheck_failed") >= 1);
});

test("post-apply explicitly fails when any PortOne evidence field remains NULL", async () => {
  const source = order(1, {
    expected_store_id: ENV.NEXT_PUBLIC_PORTONE_STORE_ID,
    expected_currency: "KRW",
    expected_channel_key: ENV.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CARD,
  });
  const database = new FakeSupabase([source]);
  database.postcheckCountOverride = 1;
  const result = await runPortoneOrderEvidenceBackfill({
    client: database,
    fetchImpl: providerFetchForRows([source]).fetchImpl,
    config: config(),
    apply: true,
    logger: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.remainingUnresolvedRows, 1);
  assert.equal(
    blockerCount(result, "unresolved_portone_rows_remaining"),
    1,
  );
});

test("main reports only safe configuration names/reasons and never secret values", async () => {
  const logs: string[] = [];
  const badEnv = { ...ENV } as Record<string, string>;
  delete badEnv.PORTONE_V2_API_SECRET;
  const exitCode = await main(
    [],
    badEnv as NodeJS.ProcessEnv,
    {
      logger: (message: string) => logs.push(message),
    } as never,
  );
  assert.equal(exitCode, 1);
  const output = logs.join("\n");
  assert.match(
    output,
    /config_blocker name=PORTONE_V2_API_SECRET reason=missing/,
  );
  for (const value of Object.values(ENV)) {
    assert.equal(output.includes(value), false);
  }
});

test("default body limit is finite and suitable for provider payloads", () => {
  assert.equal(Number.isSafeInteger(DEFAULT_MAX_BODY_BYTES), true);
  assert.ok(DEFAULT_MAX_BODY_BYTES >= 64 * 1024);
  assert.ok(DEFAULT_MAX_BODY_BYTES <= 1024 * 1024);
});
