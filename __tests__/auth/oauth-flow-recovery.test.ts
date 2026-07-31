import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseOAuthFlowEvidenceVerification,
  parseOAuthFlowFinalizeReceipt,
  parseOAuthFlowMinimalRecovery,
  parseOAuthFlowRecoveredAuthority,
  parseOAuthFlowRevokeBoundTargetReceipt,
  parseOAuthFlowRotateReceipt,
  parseOAuthFlowSignoutRevokeReceipt,
  parseOAuthFlowSourceEvidenceVerification,
  parseOAuthFlowStatus,
  parseOAuthFlowTargetEvidence,
} from "../../lib/oauth-flow-status.ts";

const FLOW_A = "11111111-1111-4111-8111-111111111111";
const FLOW_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CREATED_AT = "2026-07-31T00:00:00.000Z";
const EXPIRES_AT = "2026-07-31T00:10:00.000Z";
const RELEASED_AT = "2026-07-31T00:05:00.000Z";
const FINISHED_AT = "2026-07-31T00:06:00.000Z";
const REVOKED_AFTER_FINISH_AT = "2026-07-31T00:07:00.000Z";
const RELEASED_AFTER_REVOKE_AT = "2026-07-31T00:08:00.000Z";
const ACCESS_DIGEST = "a".repeat(64);
const REFRESH_DIGEST = "b".repeat(64);

function source(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  );
}

function statusValue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    flowId: FLOW_A,
    provider: "google",
    sourceIsAnonymous: true,
    requestedNext: "/arena?mode=ranked",
    state: "claimed",
    active: true,
    outcome: null,
    targetUserId: USER_B,
    targetSessionId: SESSION_B,
    destination: null,
    action: null,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    claimedAt: CREATED_AT,
    revokeConfirmedAt: null,
    finishedAt: null,
    releasedAt: null,
    migrationConsumedAt: null,
    ...overrides,
  };
}

function statusForState(
  state:
    | "pending"
    | "claimed"
    | "signout_required"
    | "signout_revoked"
    | "completed"
    | "failed"
    | "cancelled"
    | "abandoned"
    | "expired",
): Record<string, unknown> {
  switch (state) {
    case "pending":
      return statusValue({
        state,
        targetUserId: null,
        targetSessionId: null,
        claimedAt: null,
      });
    case "claimed":
      return statusValue({ state });
    case "signout_required":
      return statusValue({
        state,
        destination: "/",
        action: "signout",
      });
    case "signout_revoked":
      return statusValue({
        state,
        destination: "/",
        action: "signout",
        revokeConfirmedAt: RELEASED_AT,
      });
    case "completed":
      return statusValue({
        state,
        active: false,
        outcome: "completed",
        destination: "/",
        action: "continue",
        finishedAt: FINISHED_AT,
      });
    case "failed":
      return statusValue({
        state,
        active: false,
        outcome: "failed",
        targetUserId: null,
        targetSessionId: null,
        destination: "/",
        action: "continue",
        finishedAt: FINISHED_AT,
      });
    case "cancelled":
      return statusValue({
        state,
        active: false,
        outcome: "cancelled",
        targetUserId: null,
        targetSessionId: null,
        claimedAt: null,
        finishedAt: FINISHED_AT,
      });
    case "abandoned":
      return statusValue({
        state,
        active: false,
        outcome: "abandoned",
        revokeConfirmedAt: RELEASED_AT,
        finishedAt: FINISHED_AT,
      });
    case "expired":
      return statusValue({
        state,
        active: false,
        outcome: "expired",
        targetUserId: null,
        targetSessionId: null,
        claimedAt: null,
        finishedAt: EXPIRES_AT,
      });
  }
}

test("status parser accepts every state only with the exact DB shape and time order", () => {
  const states = [
    "pending",
    "claimed",
    "signout_required",
    "signout_revoked",
    "completed",
    "failed",
    "cancelled",
    "abandoned",
    "expired",
  ] as const;
  for (const state of states) {
    const value = statusForState(state);
    const parsed = parseOAuthFlowStatus(
      value,
      FLOW_A,
    );
    assert.equal(parsed?.state, state);
    assert.equal(parsed?.active, value.active);
    assert.equal(
      parseOAuthFlowStatus(
        { ...value, active: !value.active },
        FLOW_A,
      ),
      null,
    );
    assert.equal(
      parseOAuthFlowStatus(
        {
          ...value,
          outcome:
            value.outcome === null ? "completed" : null,
        },
        FLOW_A,
      ),
      null,
    );
  }

  for (const valid of [
    statusValue({
      targetUserId: null,
      targetSessionId: null,
    }),
    {
      ...statusForState("completed"),
      releasedAt: REVOKED_AFTER_FINISH_AT,
    },
    {
      ...statusForState("completed"),
      revokeConfirmedAt: REVOKED_AFTER_FINISH_AT,
      releasedAt: RELEASED_AFTER_REVOKE_AT,
    },
    {
      ...statusForState("completed"),
      migrationConsumedAt: REVOKED_AFTER_FINISH_AT,
    },
    {
      ...statusForState("completed"),
      action: "signout",
      revokeConfirmedAt: RELEASED_AT,
    },
  ]) {
    assert.notEqual(
      parseOAuthFlowStatus(valid, FLOW_A),
      null,
      JSON.stringify(valid),
    );
  }

  for (const malformed of [
    statusValue({ extra: true }),
    statusValue({ flowId: FLOW_B }),
    statusValue({ provider: "github" }),
    statusValue({ requestedNext: "https://evil.example" }),
    statusValue({ state: "claimed", active: false }),
    statusValue({ targetSessionId: null }),
    statusValue({ destination: "https://evil.example" }),
    statusValue({ action: "redirect" }),
    statusValue({ expiresAt: "not-an-iso-date" }),
    statusValue({ createdAt: "1" }),
    statusValue({ requestedNext: `/${"a".repeat(2048)}` }),
    statusValue({ expiresAt: "2026-07-31T00:09:59.999Z" }),
    statusValue({ claimedAt: EXPIRES_AT }),
    statusValue({ migrationConsumedAt: FINISHED_AT }),
    {
      ...statusForState("signout_required"),
      revokeConfirmedAt: RELEASED_AT,
    },
    {
      ...statusForState("signout_revoked"),
      finishedAt: FINISHED_AT,
    },
    {
      ...statusForState("completed"),
      revokeConfirmedAt: RELEASED_AT,
      releasedAt: null,
    },
    {
      ...statusForState("completed"),
      sourceIsAnonymous: false,
      migrationConsumedAt: "2026-07-31T00:07:00.000Z",
    },
    {
      ...statusForState("abandoned"),
      targetUserId: null,
      targetSessionId: null,
    },
    {
      ...statusForState("expired"),
      finishedAt: "2026-07-31T00:09:59.999Z",
    },
  ]) {
    assert.equal(
      parseOAuthFlowStatus(malformed, FLOW_A),
      null,
      JSON.stringify(malformed),
    );
  }
});

test("recovery, finalize, and minimal receipts are exact and actor-bound", () => {
  const recovered = {
    ...statusValue(),
    sourceUserId: USER_A,
    sourceSessionId: SESSION_A,
  };
  assert.deepEqual(
    parseOAuthFlowRecoveredAuthority(recovered, FLOW_A),
    {
      sourceUserId: USER_A,
      sourceSessionId: SESSION_A,
      status: parseOAuthFlowStatus(statusValue(), FLOW_A),
    },
  );
  for (const malformed of [
    { ...recovered, sourceUserId: "not-a-uuid" },
    { ...recovered, sourceSessionId: SESSION_B, extra: true },
    { ...recovered, flowId: FLOW_B },
    { ...recovered, sourceSessionId: SESSION_B },
    {
      ...recovered,
      sourceUserId: USER_B,
      sourceIsAnonymous: true,
    },
  ]) {
    assert.equal(
      parseOAuthFlowRecoveredAuthority(malformed, FLOW_A),
      null,
    );
  }

  const finalize = {
    ok: true,
    flowId: FLOW_A,
    outcome: "completed",
    targetUserId: USER_B,
    targetSessionId: SESSION_B,
    destination: "/results",
    action: "continue",
  };
  assert.deepEqual(
    parseOAuthFlowFinalizeReceipt(finalize, FLOW_A),
    {
      outcome: "completed",
      targetUserId: USER_B,
      targetSessionId: SESSION_B,
      destination: "/results",
      action: "continue",
    },
  );
  for (const malformed of [
    { ...finalize, extra: true },
    { ...finalize, targetSessionId: null },
    { ...finalize, destination: "https://evil.example" },
    { ...finalize, action: "redirect" },
  ]) {
    assert.equal(
      parseOAuthFlowFinalizeReceipt(malformed, FLOW_A),
      null,
    );
  }

  for (
    const state of [
      "absent",
      "completed",
      "failed",
      "cancelled",
      "abandoned",
      "expired",
    ] as const
  ) {
    assert.deepEqual(
      parseOAuthFlowMinimalRecovery(
        { ok: true, flowId: FLOW_A, state, active: false },
        FLOW_A,
      ),
      { flowId: FLOW_A, state, active: false },
    );
  }
  assert.deepEqual(
    parseOAuthFlowMinimalRecovery(
      {
        ok: true,
        flowId: FLOW_A,
        state: "signout_revoked",
        active: true,
      },
      FLOW_A,
    ),
    {
      flowId: FLOW_A,
      state: "signout_revoked",
      active: true,
    },
  );
  for (const malformed of [
    {
      ok: true,
      flowId: FLOW_A,
      state: "signout_revoked",
      active: false,
    },
    {
      ok: true,
      flowId: FLOW_A,
      state: "completed",
      active: true,
    },
    {
      ok: true,
      flowId: FLOW_A,
      state: "absent",
      active: false,
      extra: true,
    },
  ]) {
    assert.equal(
      parseOAuthFlowMinimalRecovery(malformed, FLOW_A),
      null,
    );
  }
});

test("target, rotation, release-evidence, and signout receipts reject every widened shape", () => {
  const expected = {
    flowId: FLOW_A,
    targetUserId: USER_B,
    targetSessionId: SESSION_B,
  };
  const target = {
    ok: true,
    ...expected,
    state: "claimed",
    accessTokenSha256: ACCESS_DIGEST,
    refreshTokenSha256: REFRESH_DIGEST,
    releasedAt: null,
  };
  assert.deepEqual(
    parseOAuthFlowTargetEvidence(target, expected),
    {
      ...expected,
      state: "claimed",
      accessTokenSha256: ACCESS_DIGEST,
      refreshTokenSha256: REFRESH_DIGEST,
      releasedAt: null,
    },
  );
  for (const malformed of [
    { ...target, accessTokenSha256: ACCESS_DIGEST.toUpperCase() },
    { ...target, refreshTokenSha256: "b".repeat(63) },
    { ...target, targetSessionId: SESSION_A },
    { ...target, state: "failed" },
    { ...target, extra: true },
  ]) {
    assert.equal(
      parseOAuthFlowTargetEvidence(malformed, expected),
      null,
    );
  }

  const rotate = {
    ok: true,
    ...expected,
    state: "completed",
  };
  assert.deepEqual(
    parseOAuthFlowRotateReceipt(rotate, expected),
    { state: "completed" },
  );
  assert.equal(
    parseOAuthFlowRotateReceipt(
      { ...rotate, targetSessionId: SESSION_A },
      expected,
    ),
    null,
  );
  assert.equal(
    parseOAuthFlowRotateReceipt(
      { ...rotate, extra: true },
      expected,
    ),
    null,
  );

  const verified = {
    ok: true,
    flowId: FLOW_A,
    state: "completed",
    matched: true,
    releasedAt: RELEASED_AT,
  };
  assert.deepEqual(
    parseOAuthFlowEvidenceVerification(verified, FLOW_A),
    { state: "completed", releasedAt: RELEASED_AT },
  );
  assert.equal(
    parseOAuthFlowEvidenceVerification(
      { ...verified, matched: false },
      FLOW_A,
    ),
    null,
  );
  assert.deepEqual(
    parseOAuthFlowSourceEvidenceVerification(
      {
        ok: true,
        flowId: FLOW_A,
        state: "pending",
        matched: true,
      },
      FLOW_A,
    ),
    { state: "pending" },
  );

  const signout = {
    ok: true,
    ...expected,
    state: "signout_revoked",
    revokeConfirmedAt: RELEASED_AT,
  };
  assert.deepEqual(
    parseOAuthFlowSignoutRevokeReceipt(signout, expected),
    { state: "signout_revoked" },
  );
  assert.equal(
    parseOAuthFlowSignoutRevokeReceipt(
      { ...signout, revokeConfirmedAt: null },
      expected,
    ),
    null,
  );

  for (const cleanup of [
    {
      ok: true,
      flowId: FLOW_A,
      state: "abandoned",
      outcome: "abandoned",
      destination: "/",
      revokeConfirmedAt: RELEASED_AT,
    },
    {
      ok: true,
      flowId: FLOW_A,
      state: "completed",
      outcome: "completed",
      destination: "/",
      revokeConfirmedAt: RELEASED_AT,
    },
  ] as const) {
    assert.deepEqual(
      parseOAuthFlowRevokeBoundTargetReceipt(cleanup, FLOW_A),
      cleanup,
    );
    for (const malformed of [
      { ...cleanup, flowId: FLOW_B },
      { ...cleanup, outcome: "failed" },
      { ...cleanup, destination: "/results" },
      { ...cleanup, revokeConfirmedAt: "1" },
      { ...cleanup, extra: true },
    ]) {
      assert.equal(
        parseOAuthFlowRevokeBoundTargetReceipt(
          malformed,
          FLOW_A,
        ),
        null,
      );
    }
  }
});

test("status route fences actor recovery and issues authority only after exact evidence", () => {
  const route = source("app/api/auth/oauth-flow/status/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const origin = post.indexOf("browserMutationOriginAllowed(");
  const exactBody = post.indexOf("keys.length !== 1");
  const raw = post.indexOf("readSupabaseSessionCookieHeader(");
  const authority = post.indexOf("readOAuthFlowRouteAuthority({");
  const strict = post.indexOf("readOAuthFlowStatusStrict(");
  const cookieShape = post.indexOf(
    "recoveryCookieShapeAllowed(header, flowId)",
  );
  const recover = post.lastIndexOf(
    "recoverByObservedSession({",
  );
  const recovered = post.indexOf(
    "parseOAuthFlowRecoveredAuthority(",
    recover,
  );
  const observedFence = post.indexOf(
    "if (!observedIsSource && !observedIsTarget)",
    recovered,
  );
  const evidence = post.indexOf(
    "expiredObservedEvidenceMatches({",
    observedFence,
  );
  const sign = post.lastIndexOf(
    "signOAuthFlowRecoveryProof(",
  );
  const full = post.lastIndexOf("return fullStatusResponse(");
  assert.ok(origin >= 0);
  assert.ok(exactBody > origin);
  assert.ok(raw > exactBody);
  assert.ok(authority > raw);
  assert.ok(strict > authority);
  assert.ok(cookieShape > strict);
  assert.ok(recover > cookieShape);
  assert.ok(recovered > recover);
  assert.ok(observedFence > recovered);
  assert.ok(evidence > observedFence);
  assert.ok(sign > evidence);
  assert.ok(full > sign);
  assert.match(
    post,
    /sourceMatches[\s\S]*?targetMatches[\s\S]*?observedRole = sourceMatches[\s\S]*?\? "source"[\s\S]*?: targetMatches[\s\S]*?\? "target"[\s\S]*?: null/,
  );
  assert.match(
    post,
    /observedRole !== null[\s\S]*?oauthFlowStatusNeedsRecoveryAuthority\(status\)[\s\S]*?observedSessionProvesRecoveryAuthority\(\{[\s\S]*?role: observedRole[\s\S]*?if \(proven\)[\s\S]*?signOAuthFlowRecoveryProof\(/,
  );
  assert.match(
    post,
    /observedUserId:[\s\S]*?raw\.kind === "present" \? raw\.session\.userId : null[\s\S]*?observedSessionId:[\s\S]*?raw\.kind === "present" \? raw\.session\.sessionId : null/,
  );
  assert.match(
    post,
    /absent\?\.state === "absent"[\s\S]*?return absentFlowResponse\(flowId\)[\s\S]*?absent !== null && !absent\.active[\s\S]*?return minimalFlowResponse\(absent\)/,
  );
  assert.match(
    route,
    /function minimalFlowResponse\([\s\S]*?clearOAuthFlowCookies\(result, flowId\)[\s\S]*?migrateCookieName\(flowId\)[\s\S]*?maxAge: 0/,
  );
});

test("rotate route authenticates exact token digests before idempotent or atomic rotation", () => {
  const route = source(
    "app/api/auth/oauth-flow/rotate-target/route.ts",
  );
  const post = route.slice(route.indexOf("export async function POST"));
  const parse = post.indexOf("const input = parseInput(");
  const authority = post.indexOf("readOAuthFlowRouteAuthority({");
  const raw = post.indexOf("readSupabaseSessionCookieHeader(");
  const rawFence = post.indexOf("raw.kind !== \"present\"");
  const verify = post.indexOf(
    '"auth.oauth_flow_target_evidence_verify"',
  );
  const released = post.indexOf("verified?.releasedAt !== null");
  const auth = post.indexOf("readServerAuthUser({");
  const refreshDemand = post.indexOf(
    '"auth_session_refresh_required"',
  );
  const stored = post.indexOf(
    '"auth.oauth_flow_target_evidence_read"',
  );
  const unchanged = post.indexOf(
    "stored.accessTokenSha256 === input.accessTokenDigest",
  );
  const rotate = post.indexOf(
    '"auth.oauth_flow_target_evidence_rotate"',
  );
  const receipt = post.indexOf(
    "parseOAuthFlowRotateReceipt(value, expected)",
  );
  assert.ok(parse >= 0);
  assert.ok(authority > parse);
  assert.ok(raw > authority);
  assert.ok(rawFence > raw);
  assert.ok(verify > rawFence);
  assert.ok(released > verify);
  assert.ok(auth > released);
  assert.ok(refreshDemand > auth);
  assert.ok(stored > refreshDemand);
  assert.ok(unchanged > stored);
  assert.ok(rotate > unchanged);
  assert.ok(receipt > rotate);
  assert.match(
    route,
    /keys\.length !== 5[\s\S]*?"accessTokenDigest"[\s\S]*?"refreshTokenDigest"[\s\S]*?SHA256_HEX_RE\.test/,
  );
  assert.match(
    post,
    /p_old_access_token_sha256:[\s\S]*?stored\.accessTokenSha256[\s\S]*?p_old_refresh_token_sha256:[\s\S]*?stored\.refreshTokenSha256[\s\S]*?p_new_access_token_sha256:[\s\S]*?input\.accessTokenDigest[\s\S]*?p_new_refresh_token_sha256:[\s\S]*?input\.refreshTokenDigest/,
  );
});

test("proof-bound target cleanup route accepts only an exact HMAC-authorized durable receipt", () => {
  const route = source(
    "app/api/auth/oauth-flow/revoke-bound-target/route.ts",
  );
  const post = route.slice(route.indexOf("export async function POST"));
  const origin = post.indexOf("browserMutationOriginAllowed(");
  const body = post.indexOf("keys.length !== 1");
  const authority = post.indexOf("readOAuthFlowRouteAuthority({");
  const recovery = post.indexOf("recovery: true", authority);
  const rpc = post.indexOf(
    '.rpc("revoke_bound_oauth_flow_target_session"',
  );
  const actor = post.indexOf(
    "p_source_user_id: authority.proof.sourceUserId",
  );
  const session = post.indexOf(
    "authority.proof.sourceSessionId",
    actor,
  );
  const provider = post.indexOf(
    "p_provider: authority.proof.provider",
    session,
  );
  const parse = post.indexOf(
    "parseOAuthFlowRevokeBoundTargetReceipt(",
    provider,
  );
  const clear = post.indexOf(
    "clearOAuthFlowCookies(result, flowId)",
    parse,
  );
  const migrationClear = post.indexOf(
    "migrateCookieName(flowId)",
    clear,
  );
  assert.ok(origin >= 0);
  assert.ok(body > origin);
  assert.ok(authority > body);
  assert.ok(recovery > authority);
  assert.ok(rpc > recovery);
  assert.ok(actor > rpc);
  assert.ok(session > actor);
  assert.ok(provider > session);
  assert.ok(parse > provider);
  assert.ok(clear > parse);
  assert.ok(migrationClear > clear);
  assert.doesNotMatch(post, /readSupabaseSessionCookieHeader/);
  assert.match(
    route,
    /oauth_flow_bound_target_not_revocable[\s\S]*?409/,
  );
  assert.match(
    route,
    /auth_unavailable[\s\S]*?503[\s\S]*?Retry-After/,
  );
});

test("release and expire routes clear exact flow cookies only after durable receipts", () => {
  const release = source(
    "app/api/auth/oauth-flow/release/route.ts",
  );
  const releasePost = release.slice(
    release.indexOf("export async function POST"),
  );
  const releaseAuthority = releasePost.indexOf(
    "readOAuthFlowRouteAuthority({",
  );
  const releaseStatus = releasePost.indexOf(
    "readOAuthFlowStatusStrict(",
  );
  const terminalFence = releasePost.indexOf(
    '"oauth_flow_not_terminal"',
  );
  const session = releasePost.indexOf(
    "readSupabaseSessionCookieHeader(",
  );
  const verify = releasePost.indexOf(
    '"auth.oauth_flow_release_verify"',
  );
  const activeUser = releasePost.indexOf(
    "readServerAuthUser({",
  );
  const commit = releasePost.indexOf(
    '"auth.oauth_flow_release"',
  );
  const receipt = releasePost.indexOf(
    "parseReleaseReceipt(value, flowId)",
  );
  const success = releasePost.indexOf(
    "const result = response({ ok: true, flowId }, 200)",
  );
  const clear = releasePost.indexOf(
    "clearOAuthFlowCookies(result, flowId)",
  );
  assert.ok(releaseAuthority >= 0);
  assert.ok(releaseStatus > releaseAuthority);
  assert.ok(terminalFence > releaseStatus);
  assert.ok(session > terminalFence);
  assert.ok(verify > session);
  assert.ok(activeUser > verify);
  assert.ok(commit > activeUser);
  assert.ok(receipt > commit);
  assert.ok(success > receipt);
  assert.ok(clear > success);
  assert.match(
    releasePost,
    /status\.state === "completed"[\s\S]*?status\.action === "continue"[\s\S]*?rawSession\.session\.userId !== status\.targetUserId[\s\S]*?rawSession\.session\.sessionId !==[\s\S]*?status\.targetSessionId/,
  );

  const expire = source(
    "app/api/auth/oauth-flow/expire/route.ts",
  );
  const expirePost = expire.slice(
    expire.indexOf("export async function POST"),
  );
  const expireAuthority = expirePost.indexOf(
    "readOAuthFlowRouteAuthority({",
  );
  const expireRpc = expirePost.indexOf(
    '.rpc("expire_oauth_flow_intent"',
  );
  const parseOutcome = expirePost.indexOf(
    "outcome = parseOutcome(value, flowId)",
  );
  const activeFence = expirePost.indexOf(
    '"oauth_flow_active"',
  );
  const expireSuccess = expirePost.indexOf(
    "const result = response(",
    activeFence,
  );
  const expireClear = expirePost.indexOf(
    "clearOAuthFlowCookies(result, flowId)",
  );
  assert.ok(expireAuthority >= 0);
  assert.ok(expireRpc > expireAuthority);
  assert.ok(parseOutcome > expireRpc);
  assert.ok(activeFence > parseOutcome);
  assert.ok(expireSuccess > activeFence);
  assert.ok(expireClear > expireSuccess);
  assert.match(
    expire,
    /Object\.keys\(receipt\)\.length === 3[\s\S]*?receipt\.outcome === "expired"[\s\S]*?receipt\.outcome === "absent"/,
  );
});

test("FlowPending serializes status recovery and covers every ledger branch before navigation", () => {
  const client = source(
    "app/auth/flow-pending/FlowPendingClient.tsx",
  );
  const terminal = client.slice(
    client.indexOf("function terminalNavigate("),
    client.indexOf("function clearExactTargetSession("),
  );
  assert.match(
    terminal,
    /readExactVisibleOAuthCallbackFlow\(\) !== null[\s\S]*?clearBrowserSupabaseOAuthVerifierStorage\(\)[\s\S]*?assertBrowserSupabaseOAuthVerifierStorageCleared\(\)[\s\S]*?forgetOAuthFlowLease\(flowId\)[\s\S]*?reconcileOAuthFlowBrowserBarrier\(flowId, false\)[\s\S]*?window\.location\.replace\(destination\)/,
  );

  const rotate = client.slice(
    client.indexOf("async function validateOrRotateTarget("),
    client.indexOf("async function releaseFlow("),
  );
  const firstPost = rotate.indexOf(
    '"/api/auth/oauth-flow/rotate-target"',
  );
  const exactAuthority = rotate.indexOf(
    "parseOAuthRecoveryRefreshAuthority(",
  );
  const refresh = rotate.indexOf(
    "refreshBrowserSupabaseSessionForOAuthRecovery(",
  );
  const secondPost = rotate.lastIndexOf(
    '"/api/auth/oauth-flow/rotate-target"',
  );
  const exactAck = rotate.indexOf("exactRotateAck(");
  assert.ok(firstPost >= 0);
  assert.ok(exactAuthority > firstPost);
  assert.ok(refresh > exactAuthority);
  assert.ok(secondPost > refresh);
  assert.ok(exactAck > secondPost);

  const recover = client.slice(
    client.indexOf("async function recoverFullStatus("),
    client.indexOf("async function runRecovery("),
  );
  assert.match(
    recover,
    /status\.state === "pending"[\s\S]*?"\/api\/auth\/oauth-flow\/cancel"[\s\S]*?\{ flowId, provider: status\.provider \}[\s\S]*?"cancelled"[\s\S]*?"expired"[\s\S]*?"absent"[\s\S]*?terminalNavigate/,
  );
  assert.match(
    recover,
    /status\.state === "claimed"[\s\S]*?oauth_recovery_claimed_target_unbound[\s\S]*?!snapshotMatchesStatusTarget[\s\S]*?revokeBoundTargetAndFinish[\s\S]*?validateTargetOrRevoke\([\s\S]*?finalizeClaimed\([\s\S]*?receipt\.action === "signout"[\s\S]*?releaseFlow\(flowId, signal[\s\S]*?isRecoveryRefreshTerminalError\(error\)[\s\S]*?revokeBoundTargetAndFinish/,
  );
  assert.match(
    recover,
    /status\.state === "signout_required"[\s\S]*?status\.state === "signout_revoked"[\s\S]*?complete-signout/,
  );
  assert.match(
    recover,
    /status\.state === "completed"[\s\S]*?status\.action === "continue"[\s\S]*?status\.releasedAt !== null[\s\S]*?status\.revokeConfirmedAt !== null[\s\S]*?clearExactTargetSession\(\)[\s\S]*?validateTargetOrRevoke\([\s\S]*?releaseFlow\(flowId, signal/,
  );
  assert.match(
    recover,
    /\["failed", "cancelled", "abandoned", "expired"\]\.includes\([\s\S]*?releaseFlow\(flowId, signal\)[\s\S]*?terminalNavigate/,
  );

  const run = client.slice(
    client.indexOf("async function runRecovery("),
    client.indexOf("export function FlowPendingClient("),
  );
  assert.match(
    run,
    /runAuthCrossContextExclusive\([\s\S]*?startSupabaseUnlockedSessionWriter\([\s\S]*?"\/api\/auth\/oauth-flow\/status"/,
  );
  assert.match(
    run,
    /parseOAuthFlowMinimalRecovery\([\s\S]*?minimal\.active[\s\S]*?readExactVisibleOAuthCallbackFlow\(\) !== null[\s\S]*?terminalNavigate\(recoveredFlowId, "\/"\)/,
  );
  assert.match(
    run,
    /parseOAuthFlowStatus\([\s\S]*?readExactVisibleOAuthCallbackFlow\(\) !==[\s\S]*?recoveredFlowId[\s\S]*?ensureDurableBarrier\(recoveredFlowId\)[\s\S]*?recoverFullStatus/,
  );
});

test("FlowPending cleanup policy preserves unrelated Auth and revokes only exact terminal targets", () => {
  const client = source(
    "app/auth/flow-pending/FlowPendingClient.tsx",
  );
  const matcher = client.slice(
    client.indexOf("function snapshotMatchesStatusTarget("),
    client.indexOf("async function revokeBoundTargetAndFinish("),
  );
  assert.match(
    matcher,
    /snapshot !== null[\s\S]*?status\.targetUserId !== null[\s\S]*?status\.targetSessionId !== null[\s\S]*?snapshot\.evidence\.userId === status\.targetUserId[\s\S]*?snapshot\.evidence\.sessionId === status\.targetSessionId/,
  );

  const revoke = client.slice(
    client.indexOf("async function revokeBoundTargetAndFinish("),
    client.indexOf("async function validateTargetOrRevoke("),
  );
  const unbound = revoke.indexOf(
    "oauth_recovery_claimed_target_unbound",
  );
  const durableRevoke = revoke.indexOf(
    "await revokeBoundTarget(",
  );
  const exactMatch = revoke.indexOf(
    "if (snapshotMatchesStatusTarget(snapshot, status))",
  );
  const clear = revoke.indexOf("clearExactTargetSession()");
  const navigate = revoke.indexOf("terminalNavigate(");
  assert.ok(unbound >= 0);
  assert.ok(durableRevoke > unbound);
  assert.ok(exactMatch > durableRevoke);
  assert.ok(clear > exactMatch);
  assert.ok(navigate > clear);
  assert.doesNotMatch(
    revoke.slice(durableRevoke, exactMatch),
    /clearExactTargetSession/,
  );

  const terminalErrors = client.slice(
    client.indexOf("function isRecoveryRefreshTerminalError("),
    client.indexOf("async function postJson("),
  );
  assert.match(
    terminalErrors,
    /OAuthRecoveryRefreshRejectedError[\s\S]*?OAuthRecoveryRefreshAmbiguousError[\s\S]*?error instanceof OAuthRecoveryRefreshRejectedError \|\|[\s\S]*?error instanceof OAuthRecoveryRefreshAmbiguousError/,
  );
  const validate = client.slice(
    client.indexOf("async function validateTargetOrRevoke("),
    client.indexOf("async function recoverFullStatus("),
  );
  assert.match(
    validate,
    /catch \(error\)[\s\S]*?!isRecoveryRefreshTerminalError\(error\)[\s\S]*?throw error[\s\S]*?revokeBoundTargetAndFinish\(status, snapshot, signal\)[\s\S]*?return null/,
  );

  const recover = client.slice(
    client.indexOf("async function recoverFullStatus("),
    client.indexOf("async function runRecovery("),
  );
  const released = recover.slice(
    recover.indexOf("if (status.releasedAt !== null)"),
    recover.indexOf(
      "if (!snapshotMatchesStatusTarget(snapshot, status))",
      recover.indexOf("if (status.releasedAt !== null)"),
    ),
  );
  assert.match(
    released,
    /status\.revokeConfirmedAt !== null[\s\S]*?revokeBoundTarget\([\s\S]*?if \(targetMatches\) clearExactTargetSession\(\)[\s\S]*?terminalNavigate\(flowId, receipt\.destination\)[\s\S]*?return[\s\S]*?releaseFlow\(flowId, signal\)[\s\S]*?terminalNavigate\(flowId, status\.destination\)/,
  );
  assert.equal(
    (released.match(/clearExactTargetSession\(\)/gu) ?? []).length,
    1,
    "released-normal and unrelated/absent cleanup paths have no unconditional Auth clear",
  );

  const unreleased = recover.slice(
    recover.indexOf(
      "if (!snapshotMatchesStatusTarget(snapshot, status))",
      recover.indexOf("if (status.releasedAt !== null)"),
    ),
    recover.indexOf(
      "if (\n    [\"failed\", \"cancelled\", \"abandoned\", \"expired\"]",
    ),
  );
  assert.match(
    unreleased,
    /!snapshotMatchesStatusTarget\(snapshot, status\)[\s\S]*?revokeBoundTargetAndFinish\(status, snapshot, signal\)[\s\S]*?validateTargetOrRevoke\([\s\S]*?releaseFlow\(flowId, signal[\s\S]*?isRecoveryRefreshTerminalError\(error\)[\s\S]*?revokeBoundTargetAndFinish/,
  );

  const passiveTerminal = recover.slice(
    recover.indexOf(
      "[\"failed\", \"cancelled\", \"abandoned\", \"expired\"]",
    ),
    recover.indexOf(
      'throw new Error("oauth_recovery_state_unhandled")',
    ),
  );
  assert.match(
    passiveTerminal,
    /releaseFlow\(flowId, signal\)[\s\S]*?terminalNavigate/,
  );
  assert.doesNotMatch(passiveTerminal, /clearExactTargetSession/);

  const snapshotRead = recover.slice(
    recover.indexOf(
      "snapshot = await readBrowserSupabaseSessionSnapshot()",
    ),
    recover.indexOf(
      "const targetMatches = snapshotMatchesStatusTarget(",
    ),
  );
  assert.match(
    snapshotRead,
    /catch \(error\)[\s\S]*?error instanceof BrowserSupabaseSessionCorruptError[\s\S]*?throw error[\s\S]*?clearExactTargetSession\(\)[\s\S]*?snapshot = null/,
  );
});
