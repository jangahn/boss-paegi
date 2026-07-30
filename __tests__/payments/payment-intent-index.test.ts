import assert from "node:assert/strict";
import test from "node:test";

import {
  ensurePaymentIntentIndex,
  MAX_MANAGEMENT_BODY_BYTES,
  readBoundedManagementJson,
} from "../../scripts/qa/ensure-payment-intent-index.mjs";

const env = { token: "qa-token", ref: "abcdefghijklmnopqrst" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queryFrom(init?: RequestInit) {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new TypeError("expected a JSON string request body");
  }
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), ["query"]);
  assert.equal(typeof parsed.query, "string");
  return parsed.query as string;
}

test("existing exact concurrent index is an idempotent no-op", async () => {
  const queries: string[] = [];
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "1",
        exact_indexes: "1",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    return jsonResponse(replies.shift());
  };

  const result = await ensurePaymentIntentIndex({ env, fetchImpl });
  assert.deepEqual(result, {
    changed: false,
    duplicateUsers: 0,
    exactIndexes: 1,
  });
  assert.equal(queries.length, 2);
});

test("duplicate unresolved inventory fails before any catalog mutation", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse([{ duplicate_users: "2" }]);
  };

  await assert.rejects(
    ensurePaymentIntentIndex({ env, fetchImpl }),
    /2 duplicate user inventory set/,
  );
  assert.equal(calls, 1);
});

test("same-name invalid or drifted index fails closed", async () => {
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "1",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
  ];
  const fetchImpl = async () => jsonResponse(replies.shift());

  await assert.rejects(
    ensurePaymentIntentIndex({ env, fetchImpl }),
    /invalid or drifted/,
  );
});

test("an in-progress exact concurrent build is never mistaken for stale repair debris", async () => {
  const queries: string[] = [];
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "1",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "1",
      },
    ],
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    return jsonResponse(replies.shift());
  };

  await assert.rejects(
    ensurePaymentIntentIndex({ env, fetchImpl }),
    /build is still in progress/,
  );
  assert.equal(queries.length, 2);
  assert.equal(
    queries.some((query) => /^drop index concurrently\b/i.test(query)),
    false,
  );
});

test("check-only mode reports a missing exact index without creating it", async () => {
  const queries: string[] = [];
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "0",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    return jsonResponse(replies.shift());
  };

  await assert.rejects(
    ensurePaymentIntentIndex({ env, fetchImpl, checkOnly: true }),
    /is not installed/,
  );
  assert.equal(queries.length, 2);
});

test("creation is one standalone CONCURRENTLY statement and is postflighted", async () => {
  const queries: string[] = [];
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "0",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
    [],
    [
      {
        named_indexes: "1",
        exact_indexes: "1",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    return jsonResponse(replies.shift());
  };

  const result = await ensurePaymentIntentIndex({ env, fetchImpl });
  assert.equal(result.changed, true);
  assert.equal(queries.length, 4);
  assert.match(queries[2], /^create unique index concurrently\b/i);
  assert.doesNotMatch(queries[2], /;/);
  assert.doesNotMatch(queries[2], /\b(begin|commit|set)\b/i);
});

test("an interrupted exact-definition build is dropped and rebuilt with a fresh duplicate fence", async () => {
  const queries: string[] = [];
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "1",
        exact_indexes: "0",
        repairable_indexes: "1",
        building_indexes: "0",
      },
    ],
    [],
    [
      {
        named_indexes: "0",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
    [{ duplicate_users: "0" }],
    [],
    [
      {
        named_indexes: "1",
        exact_indexes: "1",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ],
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    return jsonResponse(replies.shift());
  };

  const result = await ensurePaymentIntentIndex({ env, fetchImpl });
  assert.deepEqual(result, {
    changed: true,
    duplicateUsers: 0,
    exactIndexes: 1,
  });
  assert.equal(queries.length, 7);
  assert.match(
    queries[2],
    /^drop index concurrently public\.orders_one_unresolved_portone_intent_per_user_uidx$/i,
  );
  assert.doesNotMatch(queries[2], /;/);
  assert.match(queries[4], /duplicate_users/i);
  assert.match(queries[5], /^create unique index concurrently\b/i);
});

test("check-only mode reports an interrupted exact index without dropping it", async () => {
  const queries: string[] = [];
  const replies = [
    [{ duplicate_users: "0" }],
    [
      {
        named_indexes: "1",
        exact_indexes: "0",
        repairable_indexes: "1",
        building_indexes: "0",
      },
    ],
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    return jsonResponse(replies.shift());
  };

  await assert.rejects(
    ensurePaymentIntentIndex({ env, fetchImpl, checkOnly: true }),
    /interrupted and requires repair/,
  );
  assert.equal(queries.length, 2);
});

test("a lost CREATE response converges through an exact valid catalog reread", async () => {
  const queries: string[] = [];
  const replies = [
    jsonResponse([{ duplicate_users: "0" }]),
    jsonResponse([
      {
        named_indexes: "0",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ]),
    jsonResponse([], 504),
    jsonResponse([
      {
        named_indexes: "1",
        exact_indexes: "1",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ]),
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    const response = replies.shift();
    assert.ok(response);
    return response;
  };

  assert.deepEqual(
    await ensurePaymentIntentIndex({ env, fetchImpl }),
    {
      changed: true,
      duplicateUsers: 0,
      exactIndexes: 1,
    },
  );
  assert.equal(queries.length, 4);
  assert.match(queries[2], /^create unique index concurrently\b/i);
});

test("a lost DROP response converges only after catalog absence, then rebuilds", async () => {
  const queries: string[] = [];
  const replies = [
    jsonResponse([{ duplicate_users: "0" }]),
    jsonResponse([
      {
        named_indexes: "1",
        exact_indexes: "0",
        repairable_indexes: "1",
        building_indexes: "0",
      },
    ]),
    jsonResponse([], 504),
    jsonResponse([
      {
        named_indexes: "0",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ]),
    jsonResponse([
      {
        named_indexes: "0",
        exact_indexes: "0",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ]),
    jsonResponse([{ duplicate_users: "0" }]),
    jsonResponse([]),
    jsonResponse([
      {
        named_indexes: "1",
        exact_indexes: "1",
        repairable_indexes: "0",
        building_indexes: "0",
      },
    ]),
  ];
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    queries.push(queryFrom(init));
    const response = replies.shift();
    assert.ok(response);
    return response;
  };

  const result = await ensurePaymentIntentIndex({ env, fetchImpl });
  assert.equal(result.changed, true);
  assert.equal(queries.length, 8);
  assert.match(queries[2], /^drop index concurrently\b/i);
  assert.match(queries[6], /^create unique index concurrently\b/i);
});

test("provider error bodies are not copied into the thrown message", async () => {
  const fetchImpl = async () =>
    jsonResponse(
      { message: "duplicate key (user_id)=(sensitive-user-id)" },
      400,
    );

  await assert.rejects(
    ensurePaymentIntentIndex({ env, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\(400\)/);
      assert.doesNotMatch(error.message, /sensitive-user-id/);
      return true;
    },
  );
});

test("management response reader bounds bytes and rejects invalid UTF-8 or JSON without echoing bodies", async () => {
  const sensitive = "must-not-appear-in-errors";
  const malformedResponses = [
    new Response(
      new Uint8Array(MAX_MANAGEMENT_BODY_BYTES + 1).fill(0x20),
    ),
    new Response(new Uint8Array([0xc3, 0x28])),
    new Response(`{"secret":"${sensitive}"`),
    new Response(null),
  ];

  for (const response of malformedResponses) {
    await assert.rejects(
      readBoundedManagementJson(response),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Supabase Management API returned an invalid response",
        );
        assert.doesNotMatch(error.message, new RegExp(sensitive));
        return true;
      },
    );
  }
});
