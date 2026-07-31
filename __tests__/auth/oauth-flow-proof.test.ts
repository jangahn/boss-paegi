import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isOAuthFlowProvider,
  parseOAuthFlowBeginAck,
  parseOAuthFlowCancelAck,
  parseOAuthFlowClaimAck,
} from "../../lib/oauth-flow-intent.ts";
import {
  OAUTH_FLOW_COOKIE_PREFIX,
  OAUTH_FLOW_MAX_AGE_SECONDS,
  OAUTH_FLOW_OWNER_KEY,
  cancelOAuthFlowLease,
  forgetOAuthFlowLease,
  matchesOAuthFlowLease,
  oauthFlowCookieName,
  readOAuthFlowLease,
  rememberOAuthFlowLease,
  type OAuthFlowLeaseEnvironment,
} from "../../lib/oauth-flow-lease.ts";
import {
  OAUTH_FLOW_PROOF_COOKIE_PREFIX,
  oauthFlowProofCookieName,
  parseOAuthFlowPrepareRequest,
  signOAuthFlowProof,
  verifyOAuthFlowProof,
  verifyOAuthFlowProofAnyProvider,
  type OAuthFlowProof,
} from "../../lib/oauth-flow-proof.ts";
import {
  parsePrepareSignupAck,
} from "../../lib/oauth-start-result.ts";

const FLOW_A = "11111111-1111-4111-8111-111111111111";
const FLOW_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOCUMENT_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECRET = "unit-test-service-role-secret";
const OTHER_SECRET = "different-unit-test-secret";
const NOW = 1_800_000_000_000;

function source(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  );
}

function validPrepareRequest() {
  return {
    flowId: FLOW_A,
    expectedUserId: USER_A,
    expectedAnonymous: true,
    provider: "google",
    next: "/",
  } as const;
}

function ownedFlowRecord(
  flowId = FLOW_A,
  documentId = DOCUMENT_A,
): string {
  return JSON.stringify({ flowId, documentId });
}

function validProofInput() {
  return {
    flowId: FLOW_A,
    sourceUserId: USER_A,
    sourceSessionId: SESSION_A,
    sourceIsAnonymous: true,
    provider: "google",
  } as const;
}

function signValid(
  expiresAt = NOW + OAUTH_FLOW_MAX_AGE_SECONDS * 1_000,
) {
  return signOAuthFlowProof(
    validProofInput(),
    SECRET,
    NOW,
    expiresAt,
  );
}

test("OAuth prepare request parser accepts only the exact actor/provider fingerprint", () => {
  assert.deepEqual(
    parseOAuthFlowPrepareRequest(validPrepareRequest()),
    validPrepareRequest(),
  );
  assert.deepEqual(
    parseOAuthFlowPrepareRequest({
      ...validPrepareRequest(),
      flowId: FLOW_A.toUpperCase(),
      expectedUserId: USER_A.toUpperCase(),
    }),
    {
      ...validPrepareRequest(),
      flowId: FLOW_A.toUpperCase(),
      expectedUserId: USER_A.toUpperCase(),
    },
  );

  for (const malformed of [
    null,
    [],
    {},
    { ...validPrepareRequest(), extra: true },
    {
      flowId: FLOW_A,
      expectedUserId: USER_A,
      expectedAnonymous: true,
    },
    { ...validPrepareRequest(), flowId: FLOW_A.slice(0, -1) },
    {
      ...validPrepareRequest(),
      flowId: "00000000-0000-0000-0000-000000000000",
    },
    { ...validPrepareRequest(), expectedUserId: "not-a-user-id" },
    { ...validPrepareRequest(), expectedAnonymous: 1 },
    { ...validPrepareRequest(), provider: "github" },
    { ...validPrepareRequest(), provider: "GOOGLE" },
    { ...validPrepareRequest(), next: "https://evil.example" },
    { ...validPrepareRequest(), next: `/${"a".repeat(2_048)}` },
  ]) {
    assert.equal(
      parseOAuthFlowPrepareRequest(malformed),
      null,
      JSON.stringify(malformed),
    );
  }
  assert.equal(isOAuthFlowProvider("google"), true);
  assert.equal(isOAuthFlowProvider("kakao"), true);
  assert.equal(isOAuthFlowProvider("github"), false);
});

test("HMAC proof round-trip binds flow, actor session, kind, provider, and expiry", () => {
  for (const provider of ["google", "kakao"] as const) {
    for (const sourceIsAnonymous of [true, false]) {
      const signed = signOAuthFlowProof(
        {
          ...validProofInput(),
          provider,
          sourceIsAnonymous,
        },
        SECRET,
        NOW,
      );
      assert.deepEqual(
        verifyOAuthFlowProof(
          signed.value,
          { flowId: FLOW_A, provider },
          SECRET,
          NOW,
        ),
        signed.proof,
      );
      assert.deepEqual(
        verifyOAuthFlowProofAnyProvider(
          signed.value,
          FLOW_A,
          SECRET,
          NOW,
        ),
        signed.proof,
      );
    }
  }

  assert.equal(
    oauthFlowProofCookieName(FLOW_A),
    `${OAUTH_FLOW_PROOF_COOKIE_PREFIX}${FLOW_A}`,
  );
  assert.throws(
    () => oauthFlowProofCookieName("not-a-flow"),
    /invalid_oauth_flow_id/,
  );
});

test("every signed proof field and signature is tamper-evident", () => {
  const { value } = signValid();
  const parts = value.split(".");
  assert.equal(parts.length, 7);
  const base64UrlAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalSignatureIndex = base64UrlAlphabet.indexOf(
    parts[6].at(-1) ?? "",
  );
  assert.notEqual(finalSignatureIndex, -1);
  const nonCanonicalSignatureAlias =
    parts[6].slice(0, -1) +
    base64UrlAlphabet[
      (finalSignatureIndex & 0b110000) |
        ((finalSignatureIndex + 1) & 0b001111)
    ];
  assert.deepEqual(
    Buffer.from(nonCanonicalSignatureAlias, "base64url"),
    Buffer.from(parts[6], "base64url"),
    "the regression fixture must decode to the same HMAC bytes",
  );
  const mutations = [
    [FLOW_B, ...parts.slice(1)],
    [parts[0], USER_B, ...parts.slice(2)],
    [parts[0], parts[1], SESSION_B, ...parts.slice(3)],
    [...parts.slice(0, 3), "0", ...parts.slice(4)],
    [...parts.slice(0, 4), "kakao", ...parts.slice(5)],
    [
      ...parts.slice(0, 5),
      String(Number(parts[5]) - 1),
      parts[6],
    ],
    [
      ...parts.slice(0, 6),
      `${parts[6][0] === "A" ? "B" : "A"}${parts[6].slice(1)}`,
    ],
    [...parts.slice(0, 6), nonCanonicalSignatureAlias],
  ];
  for (const mutation of mutations) {
    assert.equal(
      verifyOAuthFlowProof(
        mutation.join("."),
        { flowId: FLOW_A, provider: "google" },
        SECRET,
        NOW,
      ),
      null,
      mutation.join("."),
    );
  }

  for (const malformed of [
    null,
    undefined,
    "",
    value.replace(FLOW_A, "not-a-flow"),
    `${value}.extra`,
    value.split(".").slice(0, 6).join("."),
    value.replace(".1.google.", ".2.google."),
    value.replace(parts[5], "NaN"),
    value.replace(parts[6], "*not-base64url*"),
  ]) {
    assert.equal(
      verifyOAuthFlowProof(
        malformed,
        { flowId: FLOW_A, provider: "google" },
        SECRET,
        NOW,
      ),
      null,
    );
  }

  assert.equal(
    verifyOAuthFlowProof(
      value,
      { flowId: FLOW_B, provider: "google" },
      SECRET,
      NOW,
    ),
    null,
  );
  assert.equal(
    verifyOAuthFlowProof(
      value,
      { flowId: FLOW_A, provider: "kakao" },
      SECRET,
      NOW,
    ),
    null,
  );
  assert.equal(
    verifyOAuthFlowProof(
      value,
      { flowId: FLOW_A, provider: "google" },
      OTHER_SECRET,
      NOW,
    ),
    null,
  );
});

test("proof lifetime enforces exact skew and maximum-age boundaries", () => {
  const expiresAt =
    NOW + OAUTH_FLOW_MAX_AGE_SECONDS * 1_000;
  const { value } = signValid(expiresAt);
  assert.ok(
    verifyOAuthFlowProof(
      value,
      { flowId: FLOW_A, provider: "google" },
      SECRET,
      expiresAt + 5_000,
    ),
  );
  assert.equal(
    verifyOAuthFlowProof(
      value,
      { flowId: FLOW_A, provider: "google" },
      SECRET,
      expiresAt + 5_001,
    ),
    null,
  );

  assert.doesNotThrow(() =>
    signOAuthFlowProof(
      validProofInput(),
      SECRET,
      NOW,
      NOW - 5_000,
    ),
  );
  assert.throws(
    () =>
      signOAuthFlowProof(
        validProofInput(),
        SECRET,
        NOW,
        NOW - 5_001,
      ),
    /invalid_oauth_flow_proof_input/,
  );
  assert.doesNotThrow(() =>
    signOAuthFlowProof(
      validProofInput(),
      SECRET,
      NOW,
      expiresAt + 5_000,
    ),
  );
  assert.throws(
    () =>
      signOAuthFlowProof(
        validProofInput(),
        SECRET,
        NOW,
        expiresAt + 5_001,
      ),
    /invalid_oauth_flow_proof_input/,
  );

  for (const invalid of [
    () => signOAuthFlowProof(validProofInput(), "", NOW),
    () =>
      signOAuthFlowProof(
        { ...validProofInput(), flowId: "invalid" },
        SECRET,
        NOW,
      ),
    () =>
      signOAuthFlowProof(
        { ...validProofInput(), sourceUserId: "invalid" },
        SECRET,
        NOW,
      ),
    () =>
      signOAuthFlowProof(
        { ...validProofInput(), sourceSessionId: "invalid" },
        SECRET,
        NOW,
      ),
    () =>
      signOAuthFlowProof(
        {
          ...validProofInput(),
          provider: "github" as "google",
        },
        SECRET,
        NOW,
      ),
    () =>
      signOAuthFlowProof(
        validProofInput(),
        SECRET,
        Number.MAX_SAFE_INTEGER + 1,
      ),
  ]) {
    assert.throws(invalid);
  }
});

test("all DB acknowledgement parsers require exact keys, values, and types", () => {
  const expiresAt = "2027-01-15T08:00:00.000Z";
  const proof: OAuthFlowProof = signValid().proof;

  assert.deepEqual(
    parseOAuthFlowBeginAck(
      { ok: true, flowId: FLOW_A, expiresAt },
      FLOW_A,
    ),
    { flowId: FLOW_A, expiresAt },
  );
  for (const malformed of [
    null,
    [],
    {},
    { ok: true, flowId: FLOW_A },
    { ok: true, flowId: FLOW_B, expiresAt },
    { ok: 1, flowId: FLOW_A, expiresAt },
    { ok: true, flowId: FLOW_A, expiresAt: "not-a-date" },
    { ok: true, flowId: FLOW_A, expiresAt, extra: true },
  ]) {
    assert.equal(
      parseOAuthFlowBeginAck(malformed, FLOW_A),
      null,
    );
  }

  const claimAck = {
    ok: true,
    flowId: FLOW_A,
    sourceUserId: USER_A,
    sourceSessionId: SESSION_A,
    sourceIsAnonymous: true,
    provider: "google",
  };
  assert.deepEqual(parseOAuthFlowClaimAck(claimAck, proof), proof);
  for (const malformed of [
    null,
    { ...claimAck, ok: false },
    { ...claimAck, flowId: FLOW_B },
    { ...claimAck, sourceUserId: USER_B },
    { ...claimAck, sourceSessionId: SESSION_B },
    { ...claimAck, sourceIsAnonymous: false },
    { ...claimAck, provider: "kakao" },
    { ...claimAck, extra: true },
  ]) {
    assert.equal(parseOAuthFlowClaimAck(malformed, proof), null);
  }

  for (const outcome of ["cancelled", "absent"] as const) {
    assert.equal(
      parseOAuthFlowCancelAck(
        { ok: true, flowId: FLOW_A, outcome },
        FLOW_A,
      ),
      true,
    );
  }
  for (const malformed of [
    null,
    { ok: false, flowId: FLOW_A, outcome: "cancelled" },
    { ok: true, flowId: FLOW_B, outcome: "cancelled" },
    { ok: true, flowId: FLOW_A, outcome: "claimed" },
    {
      ok: true,
      flowId: FLOW_A,
      outcome: "absent",
      extra: true,
    },
  ]) {
    assert.equal(
      parseOAuthFlowCancelAck(malformed, FLOW_A),
      false,
    );
  }

  assert.equal(
    parsePrepareSignupAck(
      { ok: true, flowId: FLOW_A },
      FLOW_A,
    ),
    FLOW_A,
  );
  for (const malformed of [
    null,
    { ok: true },
    { ok: false, flowId: FLOW_A },
    { ok: true, flowId: FLOW_B },
    { ok: true, flowId: FLOW_A, extra: true },
  ]) {
    assert.equal(
      parsePrepareSignupAck(malformed, FLOW_A),
      null,
    );
  }
});

test("visible marker coordinates tabs but cannot manufacture callback authority", () => {
  const marker = {
    name: oauthFlowCookieName(FLOW_A),
    value: FLOW_A,
  };
  const { value: proofValue } = signValid();
  const proofCookie = {
    name: oauthFlowProofCookieName(FLOW_A),
    value: proofValue,
  };

  assert.equal(matchesOAuthFlowLease(FLOW_A, [marker]), true);
  assert.equal(
    verifyOAuthFlowProof(
      null,
      { flowId: FLOW_A, provider: "google" },
      SECRET,
      NOW,
    ),
    null,
  );
  assert.equal(
    matchesOAuthFlowLease(FLOW_A, [proofCookie]),
    false,
  );
  assert.deepEqual(
    verifyOAuthFlowProof(
      proofCookie.value,
      { flowId: FLOW_A, provider: "google" },
      SECRET,
      NOW,
    ),
    signValid().proof,
  );
  assert.equal(
    matchesOAuthFlowLease(FLOW_A, [
      marker,
      proofCookie,
    ]),
    true,
  );
  assert.equal(
    matchesOAuthFlowLease(FLOW_A, [
      marker,
      { ...marker },
    ]),
    false,
  );
  assert.equal(
    matchesOAuthFlowLease(FLOW_A, [
      { ...marker, value: FLOW_B },
    ]),
    false,
  );
  assert.notEqual(
    OAUTH_FLOW_COOKIE_PREFIX,
    OAUTH_FLOW_PROOF_COOKIE_PREFIX,
  );
  assert.equal(
    OAUTH_FLOW_PROOF_COOKIE_PREFIX.startsWith(
      OAUTH_FLOW_COOKIE_PREFIX,
    ),
    false,
  );
});

test("marker parser fails closed on ambiguity, malformed encoding, and cross-flow values", () => {
  const markerName = oauthFlowCookieName(FLOW_A);
  assert.equal(
    readOAuthFlowLease(
      `unrelated=1; ${markerName}=${FLOW_A}; another=2`,
    ),
    FLOW_A,
  );
  assert.equal(readOAuthFlowLease("unrelated=1"), null);
  assert.equal(
    readOAuthFlowLease(
      `unrelated=%; ${markerName}=${FLOW_A}`,
    ),
    FLOW_A,
  );
  assert.equal(
    readOAuthFlowLease(
      `unrelated%=${FLOW_B}; ${markerName}=${FLOW_A}`,
    ),
    FLOW_A,
  );
  for (const malformedUnrelated of [
    "%=1",
    "%ZZ=1",
    "bp_%ZZ=1",
  ]) {
    assert.equal(
      readOAuthFlowLease(
        `${malformedUnrelated}; ${markerName}=${FLOW_A}`,
      ),
      FLOW_A,
    );
  }

  for (const malformed of [
    `${markerName}=${FLOW_B}`,
    `${markerName}=${FLOW_A}; ${markerName}=${FLOW_A}`,
    `${markerName}=${FLOW_A}; ${oauthFlowCookieName(FLOW_B)}=${FLOW_B}`,
    `${OAUTH_FLOW_COOKIE_PREFIX}not-a-uuid=not-a-uuid`,
    `${markerName}=%E0%A4%A`,
    `${encodeURIComponent(OAUTH_FLOW_COOKIE_PREFIX)}%=${FLOW_A}`,
    `${OAUTH_FLOW_COOKIE_PREFIX}%=${FLOW_A}`,
  ]) {
    assert.throws(() => readOAuthFlowLease(malformed));
  }
});

test("same-tab ownership is recorded only after an exact server marker is visible", () => {
  let cookie = `${oauthFlowCookieName(FLOW_A)}=${FLOW_A}`;
  let owner: string | null = null;
  let ownerWrites = 0;
  const environment: OAuthFlowLeaseEnvironment = {
    readCookie: () => cookie,
    readOwner: () => owner,
    writeOwner: (value) => {
      ownerWrites += 1;
      owner = value;
    },
    removeOwner: () => {
      owner = null;
    },
    readDocumentId: () => DOCUMENT_A,
  };

  rememberOAuthFlowLease(FLOW_A, environment);
  assert.equal(owner, ownedFlowRecord());
  assert.equal(ownerWrites, 1);
  assert.equal(OAUTH_FLOW_OWNER_KEY.includes("proof"), false);

  cookie = "";
  assert.throws(
    () => rememberOAuthFlowLease(FLOW_A, environment),
    /oauth_flow_cookie_unavailable/,
  );
  assert.equal(ownerWrites, 1);
});

test("owner cleanup removes only the exact same-document flow record", () => {
  for (const [owner, documentId] of [
    [ownedFlowRecord(), FLOW_B],
    [ownedFlowRecord(FLOW_A, FLOW_B), DOCUMENT_A],
    [FLOW_A, DOCUMENT_A],
    ['{"flowId":"' + FLOW_A + '","documentId":"' + DOCUMENT_A + '","extra":true}', DOCUMENT_A],
  ] as const) {
    let removeCalls = 0;
    forgetOAuthFlowLease(FLOW_A, {
      readCookie: () => "",
      readOwner: () => owner,
      writeOwner: () => {},
      removeOwner: () => {
        removeCalls += 1;
      },
      readDocumentId: () => documentId,
    });
    assert.equal(removeCalls, 0);
  }

  let owner: string | null = ownedFlowRecord();
  let removeCalls = 0;
  const exactEnvironment: OAuthFlowLeaseEnvironment = {
    readCookie: () => "",
    readOwner: () => owner,
    writeOwner: () => {},
    removeOwner: () => {
      removeCalls += 1;
      owner = null;
    },
    readDocumentId: () => DOCUMENT_A,
  };
  forgetOAuthFlowLease(FLOW_A, exactEnvironment);
  assert.equal(owner, null);
  assert.equal(removeCalls, 1);
  forgetOAuthFlowLease(FLOW_A, exactEnvironment);
  assert.equal(removeCalls, 1);

  assert.throws(
    () => forgetOAuthFlowLease("not-a-flow", exactEnvironment),
    /oauth_flow_cookie_invalid/,
  );
  assert.throws(
    () =>
      forgetOAuthFlowLease(FLOW_A, {
        ...exactEnvironment,
        readOwner: () => ownedFlowRecord(),
        removeOwner: () => {},
      }),
    /oauth_flow_owner_unavailable/,
  );
});

test("client cancellation requires exact provider/body/receipt and delivered cookie removal", async () => {
  for (const provider of ["google", "kakao"] as const) {
    for (
      const outcome of ["cancelled", "expired", "absent"] as const
    ) {
      let cookie = `${oauthFlowCookieName(FLOW_A)}=${FLOW_A}`;
      let owner: string | null = ownedFlowRecord();
      let removeCalls = 0;
      const environment: OAuthFlowLeaseEnvironment = {
        readCookie: () => cookie,
        readOwner: () => owner,
        writeOwner: (value) => {
          owner = value;
        },
        removeOwner: () => {
          removeCalls += 1;
          owner = null;
        },
        readDocumentId: () => DOCUMENT_A,
      };
      const fetcher = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        assert.equal(input, "/api/auth/oauth-flow/cancel");
        assert.equal(init?.method, "POST");
        assert.equal(init?.credentials, "same-origin");
        assert.equal(init?.cache, "no-store");
        assert.deepEqual(init?.headers, {
          accept: "application/json",
          "content-type": "application/json",
        });
        assert.deepEqual(JSON.parse(String(init?.body)), {
          flowId: FLOW_A,
          provider,
        });
        assert.ok(init?.signal instanceof AbortSignal);
        cookie = "";
        return new Response(
          JSON.stringify({
            ok: true,
            flowId: FLOW_A,
            outcome,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
          },
        );
      }) as typeof fetch;

      assert.equal(
        await cancelOAuthFlowLease(FLOW_A, {
          provider,
          environment,
          fetcher,
          signal: new AbortController().signal,
        }),
        true,
      );
      assert.equal(owner, null);
      assert.equal(removeCalls, 1);
    }
  }

  for (const malformed of [
    { ok: true, flowId: FLOW_A },
    { ok: true, flowId: FLOW_A, outcome: "claimed" },
    { ok: true, flowId: FLOW_B, outcome: "cancelled" },
    {
      ok: true,
      flowId: FLOW_A,
      outcome: "cancelled",
      extra: true,
    },
  ]) {
    let owner: string | null = ownedFlowRecord();
    let removeCalls = 0;
    assert.equal(
      await cancelOAuthFlowLease(FLOW_A, {
        provider: "google",
        environment: {
          readCookie: () => "",
          readOwner: () => owner,
          writeOwner: () => {},
          removeOwner: () => {
            removeCalls += 1;
            owner = null;
          },
          readDocumentId: () => DOCUMENT_A,
        },
        fetcher: (async () =>
          new Response(JSON.stringify(malformed), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      }),
      false,
      JSON.stringify(malformed),
    );
    assert.equal(owner, ownedFlowRecord());
    assert.equal(removeCalls, 0);
  }

  let retainedOwner: string | null = ownedFlowRecord();
  assert.equal(
    await cancelOAuthFlowLease(FLOW_A, {
      provider: "kakao",
      environment: {
        readCookie: () =>
          `${oauthFlowCookieName(FLOW_A)}=${FLOW_A}`,
        readOwner: () => retainedOwner,
        writeOwner: () => {},
        removeOwner: () => {
          retainedOwner = null;
        },
        readDocumentId: () => DOCUMENT_A,
      },
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            flowId: FLOW_A,
            outcome: "cancelled",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
    }),
    false,
  );
  assert.equal(retainedOwner, ownedFlowRecord());
});

test("caller cancellation cannot disable the independent receipt hard deadline", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal,
    "timeout",
  );
  assert.ok(descriptor);
  const caller = new AbortController();
  let timeoutCalls = 0;
  const observedSignals: AbortSignal[] = [];
  const safety = setTimeout(
    () => caller.abort(new Error("caller_safety_abort")),
    100,
  );
  try {
    Object.defineProperty(AbortSignal, "timeout", {
      ...descriptor,
      value: (milliseconds: number) => {
        timeoutCalls += 1;
        assert.equal(milliseconds, 8_000);
        const hardDeadline = new AbortController();
        setTimeout(
          () =>
            hardDeadline.abort(
              new Error("receipt_hard_deadline"),
            ),
          5,
        );
        return hardDeadline.signal;
      },
    });
    const result = await cancelOAuthFlowLease(FLOW_A, {
      provider: "google",
      environment: {
        readCookie: () =>
          `${oauthFlowCookieName(FLOW_A)}=${FLOW_A}`,
        readOwner: () => ownedFlowRecord(),
        writeOwner: () => {},
        removeOwner: () => {},
        readDocumentId: () => DOCUMENT_A,
      },
      signal: caller.signal,
      fetcher: ((
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if (init?.signal) observedSignals.push(init.signal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }) as typeof fetch,
    });
    assert.equal(result, false);
    assert.equal(timeoutCalls, 1);
    assert.equal(observedSignals.length, 1);
    assert.notEqual(observedSignals[0], caller.signal);
    assert.equal(observedSignals[0].aborted, true);
    assert.equal(caller.signal.aborted, false);
  } finally {
    clearTimeout(safety);
    Object.defineProperty(AbortSignal, "timeout", descriptor);
  }
});

test("prepare route issues marker and HttpOnly proof only after exact actor/session-bound DB begin", () => {
  const route = source("app/api/auth/prepare-signup/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const origin = post.indexOf("browserMutationOriginAllowed(");
  const parse = post.indexOf("parseOAuthFlowPrepareRequest(");
  const cookieSession = post.indexOf(
    "readSupabaseSessionCookieHeader(",
  );
  const getUser = post.indexOf("readServerAuthUser({");
  const fingerprint = post.indexOf(
    "authResult.user.id !== input.expectedUserId",
  );
  const begin = post.indexOf('admin\n          .rpc("begin_oauth_flow_intent"');
  const beginAck = post.indexOf("parseOAuthFlowBeginAck(");
  const sign = post.indexOf("signOAuthFlowProof(");
  const response = post.indexOf(
    "const response = json({ ok: true, flowId: input.flowId })",
  );
  assert.ok(origin >= 0);
  assert.ok(parse > origin);
  assert.ok(cookieSession > parse);
  assert.ok(getUser > cookieSession);
  assert.ok(fingerprint > getUser);
  assert.ok(begin > fingerprint);
  assert.ok(beginAck > begin);
  assert.ok(sign > beginAck);
  assert.ok(response > sign);
  assert.match(
    post,
    /cookieSession\.userId !== authResult\.user\.id[\s\S]*?p_source_session_id: cookieSession\.sessionId[\s\S]*?p_provider: input\.provider[\s\S]*?p_requested_next: input\.next[\s\S]*?signOAuthFlowProof\([\s\S]*?sourceSessionId: cookieSession\.sessionId[\s\S]*?SERVER_ENV\.SUPABASE_SERVICE_ROLE_KEY[\s\S]*?Date\.parse\(begin\.expiresAt\)/,
  );
  assert.match(
    post,
    /response\.cookies\.set\(expectedMarker,[\s\S]*?httpOnly: false[\s\S]*?response\.cookies\.set\(expectedProof,[\s\S]*?httpOnly: true/,
  );
  assert.match(
    post,
    /markerCookies\.length > 1[\s\S]*?proofCookies\.length > 1/,
  );
});

test("OAuth start replays one prepare body and compensates with the exact provider", () => {
  const auth = source("lib/auth-oauth.ts");
  const start = auth.slice(
    auth.indexOf("export async function startOAuth"),
    auth.indexOf("export async function signOut"),
  );
  const body = start.indexOf("const prepareBody = JSON.stringify({");
  const prepare = start.indexOf("const prepare = async");
  const attempt = start.indexOf("attempt: prepare");
  const reconcile = start.indexOf("reconcile: prepare");
  const remember = start.indexOf("rememberOAuthFlowLease(flowId)");
  const oauthWriter = start.indexOf(
    "auth.signInWithOAuth({",
  );
  const assign = start.indexOf(
    "window.location.assign(oauthUrl)",
  );
  const cancel = start.lastIndexOf(
    "await cancelOAuthFlowLease(",
  );
  assert.ok(body >= 0);
  assert.ok(prepare > body);
  assert.ok(attempt > prepare);
  assert.ok(reconcile > attempt);
  assert.ok(remember > reconcile);
  assert.ok(oauthWriter > remember);
  assert.ok(assign > oauthWriter);
  assert.ok(cancel > assign);
  assert.match(
    start,
    /body: prepareBody,[\s\S]*?attempt: prepare,[\s\S]*?reconcile: prepare/,
  );
  assert.match(
    start,
    /cancelOAuthFlowLease\([\s\S]*?flowId,[\s\S]*?\{ provider \}[\s\S]*?\)/,
  );
});

test("cancel route binds exact provider authority and clears only after a three-key receipt", () => {
  const route = source("app/api/auth/oauth-flow/cancel/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const origin = post.indexOf("browserMutationOriginAllowed(");
  const exactBody = post.indexOf("keys.length !== 2");
  const authority = post.indexOf("readOAuthFlowRouteAuthority({");
  const session = post.indexOf(
    "readSupabaseSessionCookieHeader(",
  );
  const actorFallback = post.indexOf("readServerAuthUser({");
  const cancel = post.indexOf("cancelForProvider({");
  const success = post.indexOf(
    "const result = response({ ok: true, flowId, outcome }, 200)",
  );
  const clear = post.indexOf(
    "clearOAuthFlowCookies(result, flowId)",
  );
  assert.ok(origin >= 0);
  assert.ok(exactBody > origin);
  assert.ok(authority > exactBody);
  assert.ok(session > authority);
  assert.ok(actorFallback > session);
  assert.ok(cancel > actorFallback);
  assert.ok(success > cancel);
  assert.ok(clear > success);
  assert.match(
    post,
    /keys\.length !== 2[\s\S]*?keys\.includes\("flowId"\)[\s\S]*?keys\.includes\("provider"\)[\s\S]*?requestedProvider !== "kakao"[\s\S]*?requestedProvider !== "google"/,
  );
  assert.match(
    post,
    /readOAuthFlowRouteAuthority\(\{[\s\S]*?flowId,[\s\S]*?provider: requestedProvider,[\s\S]*?recovery: true/,
  );
  assert.match(
    route,
    /Object\.keys\(ack\)[\s\S]*?keys\.length === 3[\s\S]*?ack\.ok === true[\s\S]*?ack\.flowId === flowId[\s\S]*?ack\.outcome === "cancelled"[\s\S]*?ack\.outcome === "expired"[\s\S]*?ack\.outcome === "absent"/,
  );
  assert.match(
    post,
    /if \(authority\) \{[\s\S]*?sourceUserId = authority\.proof\.sourceUserId[\s\S]*?sourceSessionId = authority\.proof\.sourceSessionId[\s\S]*?providers = \[requestedProvider\][\s\S]*?\} else \{[\s\S]*?readSupabaseSessionCookieHeader/,
  );
  assert.match(
    post,
    /user\.kind !== "valid"[\s\S]*?user\.user\.id !== cookie\.session\.userId[\s\S]*?providers = \[requestedProvider\]/,
  );
  assert.match(
    post,
    /"oauth_flow_not_cancellable"[\s\S]*?"oauth_flow_claimed"[\s\S]*?"oauth_flow_not_found"[\s\S]*?409/,
  );
});

test("SessionBootstrap redirects every durable or visible flow before touching Auth", () => {
  const bootstrap = source("components/SessionBootstrap.tsx");
  const effect = bootstrap.slice(
    bootstrap.indexOf("useEffect(() => {"),
  );
  const pathGate = effect.indexOf(
    "isAuthSubtreePath(window.location.pathname)",
  );
  const recovery = effect.indexOf(
    "resolveOAuthFlowBrowserRecoveryPath(document.cookie)",
  );
  const redirect = effect.indexOf(
    "window.location.replace(",
    recovery,
  );
  const client = effect.indexOf("const sb = createClient()");
  const reconciliation = effect.indexOf(
    "acquireSessionReconciliation({",
  );
  const ensure = effect.indexOf(
    "await ensureAuth(controller.signal)",
  );
  assert.ok(pathGate >= 0);
  assert.ok(recovery > pathGate);
  assert.ok(redirect > recovery);
  assert.ok(client > redirect);
  assert.ok(reconciliation > client);
  assert.ok(ensure > reconciliation);
  assert.match(
    effect.slice(recovery, client),
    /resolveOAuthFlowBrowserRecoveryPath\(document\.cookie\)[\s\S]*?window\.location\.replace\(recoveryPath\)[\s\S]*?return;/,
  );
});
