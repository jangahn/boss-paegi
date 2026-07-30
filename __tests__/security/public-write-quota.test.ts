import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { publicWriteActorKey, publicWriteNetworkActorKey } =
  await import("../../lib/public-write-quota.ts");
const { ingestTelemetryBounded, isTerminalTelemetryAck, telemetryDropAck } =
  await import("../../lib/telemetry/server-ingest.ts");
const { parsePublicTrackAck, recordConversion, recordTrackEvent } =
  await import("../../lib/analytics/server.ts");
const { parsePublicWriteAttemptFailure, parsePublicWriteAttemptReservation } =
  await import("../../lib/public-write-attempt.ts");

const SECRET = "unit-test-public-write-quota-secret";
const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const ACTOR = "a".repeat(64);

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

function telemetryPayload() {
  return {
    sessionId: "00000000-0000-4000-8000-000000000010",
    deviceClass: "desktop-pointer",
    startedAt: "2026-07-30T00:00:00.000Z",
    summary: {
      seqHigh: 7,
      endedAt: null,
      endReason: null,
      durationMs: 1000,
      startMap: "office",
      startWeapon: "fist",
      totals: {
        score: 1,
        hitCount: 1,
        maxCombo: 1,
        ultFireCount: 0,
        distinctWeapons: 1,
        distinctMaps: 1,
        apm: 60,
        tapShare: 1,
        maxTouch: 1,
        dpr: 1,
        refreshHz: 60,
        avgFrameMs: 16,
        p95FrameMs: 17,
      },
      weaponSummary: {},
      mapSummary: {},
      milestones: {
        firstHitMs: 100,
        firstSwitchMs: null,
        firstUltMs: null,
        abandonAtMs: null,
      },
    },
    events: [],
  };
}

test("actor key is stable, opaque, auth-first, and never contains raw identity material", () => {
  const aFromIp1 = publicWriteActorKey(
    headers({ "x-vercel-forwarded-for": "203.0.113.10" }),
    USER_A,
    true,
    SECRET,
  );
  const aFromIp2 = publicWriteActorKey(
    headers({ "x-vercel-forwarded-for": "203.0.113.11" }),
    USER_A.toUpperCase(),
    true,
    SECRET,
  );
  const b = publicWriteActorKey(headers(), USER_B, true, SECRET);
  assert.equal(aFromIp1, aFromIp2);
  assert.notEqual(aFromIp1, b);
  assert.match(aFromIp1 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(aFromIp1?.includes(USER_A), false);
  assert.equal(aFromIp1?.includes("203.0.113.10"), false);
});

test("unauthenticated actors use trusted edge IP precedence and a shared unknown fallback", () => {
  const preferred = publicWriteActorKey(
    headers({
      "x-vercel-forwarded-for": "2001:db8::1",
      "x-forwarded-for": "203.0.113.20",
      "x-real-ip": "203.0.113.21",
    }),
    null,
    false,
    SECRET,
  );
  const samePreferred = publicWriteActorKey(
    headers({ "x-vercel-forwarded-for": "2001:DB8::1" }),
    null,
    false,
    SECRET,
  );
  const fallback = publicWriteActorKey(
    headers({ "x-forwarded-for": "203.0.113.20, 198.51.100.1" }),
    null,
    false,
    SECRET,
  );
  const invalidThenReal = publicWriteActorKey(
    headers({
      "x-vercel-forwarded-for": "not-an-ip",
      "x-real-ip": "203.0.113.20",
    }),
    null,
    false,
    SECRET,
  );
  assert.equal(preferred, samePreferred);
  assert.equal(fallback, invalidThenReal);
  assert.equal(
    publicWriteActorKey(headers(), null, false, SECRET),
    publicWriteActorKey(
      headers({ "x-forwarded-for": "bad" }),
      null,
      false,
      SECRET,
    ),
  );
  assert.equal(publicWriteActorKey(headers(), USER_A, true, ""), null);
  const anonHeaders = headers({
    "x-vercel-forwarded-for": "203.0.113.55",
  });
  assert.equal(
    publicWriteActorKey(anonHeaders, USER_A, false, SECRET),
    publicWriteActorKey(anonHeaders, USER_B, false, SECRET),
    "rotating anonymous Auth UUIDs cannot rotate the network quota actor",
  );
  assert.equal(
    publicWriteNetworkActorKey(anonHeaders, SECRET),
    publicWriteActorKey(anonHeaders, null, false, SECRET),
  );
});

test("telemetry bounded RPC forwards the opaque actor and exact five-argument shape", async () => {
  let received: Record<string, unknown> | null = null;
  const payload = telemetryPayload();
  const result = await ingestTelemetryBounded(
    {
      sessionId: payload.sessionId,
      submitterId: USER_A,
      isMember: true,
      actorKey: ACTOR,
      payload,
    },
    {
      rpc: async (args) => {
        received = args;
        return {
          data: { ok: true, mode: "full", lastSeq: 7 },
          error: null,
        };
      },
    },
  );
  assert.deepEqual(result, {
    ok: true,
    ack: { ok: true, mode: "full", lastSeq: 7 },
  });
  assert.deepEqual(received, {
    p_session_id: payload.sessionId,
    p_owner_id: USER_A,
    p_is_member: true,
    p_actor_key: ACTOR,
    p_payload: payload,
  });
});

test("telemetry resolved errors, throws, and malformed success all fail closed", async () => {
  const base = {
    sessionId: telemetryPayload().sessionId,
    submitterId: null,
    isMember: false,
    actorKey: ACTOR,
    payload: telemetryPayload(),
  };
  const dependencyError = new Error("db-down");
  const resolved = await ingestTelemetryBounded(base, {
    rpc: async () => ({ data: null, error: dependencyError }),
  });
  assert.deepEqual(resolved, {
    ok: false,
    reason: "rpc_error",
    cause: dependencyError,
  });

  const thrown = await ingestTelemetryBounded(base, {
    rpc: async () => {
      throw dependencyError;
    },
  });
  assert.deepEqual(thrown, {
    ok: false,
    reason: "rpc_throw",
    cause: dependencyError,
  });

  const malformed = await ingestTelemetryBounded(base, {
    rpc: async () => ({ data: { ok: true }, error: null }),
  });
  assert.deepEqual(malformed, {
    ok: false,
    reason: "invalid_result",
  });
});

test("terminal telemetry drop acknowledgement disables retry without pretending to persist", () => {
  assert.deepEqual(telemetryDropAck(2_147_483_647, "actor_request_quota"), {
    ok: true,
    mode: "off",
    reason: "actor_request_quota",
    lastSeq: 2_147_483_647,
  });
  assert.equal(
    isTerminalTelemetryAck({
      ok: true,
      mode: "off",
      reason: "actor_request_quota",
      lastSeq: 7,
    }),
    true,
  );
  assert.equal(
    isTerminalTelemetryAck({
      ok: false,
      mode: "off",
      reason: "owner_mismatch",
    }),
    true,
  );
  assert.equal(
    isTerminalTelemetryAck({
      ok: true,
      mode: "off",
      reason: "quota_busy",
      lastSeq: 7,
    }),
    false,
  );
  assert.equal(
    isTerminalTelemetryAck({
      ok: false,
      mode: "off",
      reason: "unknown_future_rejection",
    }),
    false,
  );
});

test("public track acknowledgement parser is exact and rejects confused success", () => {
  assert.deepEqual(parsePublicTrackAck({ accepted: true }), {
    accepted: true,
  });
  assert.deepEqual(
    parsePublicTrackAck({
      accepted: false,
      reason: "actor_request_quota",
    }),
    { accepted: false, reason: "actor_request_quota" },
  );
  assert.deepEqual(
    parsePublicTrackAck({
      accepted: false,
      reason: "quota_busy",
    }),
    { accepted: false, reason: "quota_busy" },
  );
  for (const malformed of [
    null,
    {},
    { accepted: "true" },
    { accepted: true, reason: "ignored" },
    { accepted: false },
    { accepted: false, reason: "actor_new_session_quota" },
    { accepted: false, reason: "global_request_quota", extra: true },
  ]) {
    assert.equal(parsePublicTrackAck(malformed), null);
  }
});

test("public score/report attempt parsers accept only exact reservation and failure envelopes", () => {
  assert.deepEqual(
    parsePublicWriteAttemptReservation({ ok: true, outcome: "reserved" }),
    { kind: "reserved" },
  );
  const replayResult = { ok: true, duplicate: true };
  assert.deepEqual(
    parsePublicWriteAttemptReservation({
      ok: true,
      outcome: "replay",
      result: replayResult,
    }),
    { kind: "replay", result: replayResult },
  );
  for (const outcome of ["failed", "quota", "busy"] as const) {
    assert.deepEqual(
      parsePublicWriteAttemptReservation({
        ok: false,
        outcome,
        error_code: "target_not_found",
      }),
      {
        kind: "error",
        outcome,
        errorCode: "target_not_found",
      },
    );
  }
  for (const malformed of [
    null,
    {},
    { ok: true, outcome: "reserved", extra: true },
    { ok: true, outcome: "replay" },
    { ok: false, outcome: "failed" },
    { ok: false, outcome: "unknown", error_code: "target_not_found" },
    { ok: false, outcome: "quota", error_code: "UPPER_CASE" },
    {
      ok: false,
      outcome: "busy",
      error_code: "quota_busy",
      extra: true,
    },
  ]) {
    assert.equal(parsePublicWriteAttemptReservation(malformed), null);
  }

  assert.equal(
    parsePublicWriteAttemptFailure({
      ok: false,
      writeAttemptError: "invalid_score_protocol",
    }),
    "invalid_score_protocol",
  );
  for (const malformed of [
    null,
    { ok: true, writeAttemptError: "invalid_score_protocol" },
    { ok: false, writeAttemptError: "INVALID" },
    {
      ok: false,
      writeAttemptError: "invalid_score_protocol",
      extra: true,
    },
  ]) {
    assert.equal(parsePublicWriteAttemptFailure(malformed), null);
  }
});

test("public track RPC is best-effort for quota, resolved error, throw, and malformed result", async () => {
  const row = {
    kind: "share" as const,
    surface: "game_over" as const,
    target: "score" as const,
    score_tier: 3,
    result: "attempt" as const,
  };
  let received: Record<string, unknown> | null = null;
  const accepted = await recordTrackEvent(row, "anon", ACTOR, {
    collectionEnabled: true,
    rpc: async (args) => {
      received = args;
      return { data: { accepted: true }, error: null };
    },
  });
  assert.deepEqual(accepted, { accepted: true });
  assert.deepEqual(received, {
    p_actor_key: ACTOR,
    p_member_state: "anon",
    p_event: row,
  });

  const quota = await recordTrackEvent(row, "anon", ACTOR, {
    collectionEnabled: true,
    rpc: async () => ({
      data: { accepted: false, reason: "global_request_quota" },
      error: null,
    }),
  });
  assert.deepEqual(quota, {
    accepted: false,
    reason: "global_request_quota",
  });

  assert.equal(
    await recordTrackEvent(row, "anon", ACTOR, {
      collectionEnabled: true,
      rpc: async () => ({ data: null, error: new Error("resolved") }),
    }),
    null,
  );
  assert.equal(
    await recordTrackEvent(row, "anon", ACTOR, {
      collectionEnabled: true,
      rpc: async () => {
        throw new Error("throw");
      },
    }),
    null,
  );
  assert.equal(
    await recordTrackEvent(row, "anon", ACTOR, {
      collectionEnabled: true,
      rpc: async () => ({ data: { accepted: true, extra: 1 }, error: null }),
    }),
    null,
  );
});

test("play/signup conversions use the same bounded RPC and never direct-insert analytics", async () => {
  let received: Record<string, unknown> = {};
  const ack = await recordConversion(
    "play",
    {
      source_kind: "direct",
    },
    "anon",
    ACTOR,
    {
      collectionEnabled: true,
      rpc: async (args) => {
        received = args;
        return { data: { accepted: true }, error: null };
      },
    },
  );
  assert.deepEqual(ack, { accepted: true });
  assert.equal(received.p_actor_key, ACTOR);
  assert.equal(
    (received.p_event as Record<string, unknown>)?.kind,
    "conversion",
  );
  const analyticsServer = readFileSync(
    new URL("../../lib/analytics/server.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(analyticsServer, /\.from\("analytics_events"\)/);
});

test("public route sources use only the bounded DB surfaces", () => {
  const telemetryRoute = readFileSync(
    new URL("../../app/api/telemetry/route.ts", import.meta.url),
    "utf8",
  );
  const telemetryServer = readFileSync(
    new URL("../../lib/telemetry/server-ingest.ts", import.meta.url),
    "utf8",
  );
  const trackRoute = readFileSync(
    new URL("../../app/api/track/route.ts", import.meta.url),
    "utf8",
  );
  const analyticsServer = readFileSync(
    new URL("../../lib/analytics/server.ts", import.meta.url),
    "utf8",
  );
  const scoreRoute = readFileSync(
    new URL("../../app/api/score/route.ts", import.meta.url),
    "utf8",
  );
  const reportRoute = readFileSync(
    new URL("../../app/api/report/route.ts", import.meta.url),
    "utf8",
  );
  const signedUrlRoute = readFileSync(
    new URL("../../app/api/doll/signed-urls/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(telemetryRoute, /publicWriteActorKey\(\s*req\.headers,/);
  assert.match(telemetryRoute, /ingestTelemetryBounded\(\{/);
  assert.match(
    telemetryRoute,
    /status: 503,[\s\S]*?"Retry-After":[\s\S]*?isTerminalTelemetryAck\(result\.ack\)/,
  );
  assert.doesNotMatch(
    telemetryRoute,
    /if \(!result\.ok\)[\s\S]{0,500}telemetryDropAck/,
    "dependency failures must not acknowledge or discard the queued delta",
  );
  assert.match(telemetryServer, /p_actor_key: args\.actorKey/);
  assert.match(trackRoute, /publicWriteNetworkActorKey\(req\.headers\)/);
  assert.doesNotMatch(trackRoute, /publicWriteActorKey\(/);
  assert.match(trackRoute, /recordTrackEvent\(row, memberState, actorKey\)/);
  assert.match(
    scoreRoute,
    /publicWriteActorKey\(\s*req\.headers,\s*user\.id,\s*isMember\s*\)/,
  );
  assert.ok(
    scoreRoute.indexOf('"reserve_score_write_attempt"') <
      scoreRoute.indexOf('"submit_score_with_review"'),
    "score quota reservation must commit before core submission",
  );
  assert.match(scoreRoute, /parsePublicWriteAttemptFailure\(rpcData\)/);
  assert.ok(
    reportRoute.indexOf('"reserve_report_write_attempt"') <
      reportRoute.indexOf('"submit_content_report"'),
    "report quota reservation must commit before core submission",
  );
  assert.match(reportRoute, /parsePublicWriteAttemptFailure\(rpcData\)/);
  assert.match(
    analyticsServer,
    /admin\.rpc\("record_public_analytics_event", args\)/,
  );
  assert.match(signedUrlRoute, /publicWriteNetworkActorKey\(req\.headers\)/);
  assert.match(
    signedUrlRoute,
    /"consume_doll_signed_url_quota"[\s\S]*?p_units:\s*ids\.length/,
  );
  assert.ok(
    signedUrlRoute.indexOf('"consume_doll_signed_url_quota"') <
      signedUrlRoute.indexOf('.from("dolls")'),
    "signed URL egress quota must commit before its DB lookup and Storage calls",
  );
  assert.doesNotMatch(signedUrlRoute, /rateLimit\(|x-forwarded-for/);
});

test("migration serializes global/actor/session decisions and stores no raw IP column", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008900_public_write_quotas.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /actor_key text not null/);
  assert.match(
    migration,
    /create table if not exists public\.public_write_attempts/,
  );
  assert.doesNotMatch(
    migration,
    /^\s*(?:ip|ip_address|user_id|session_id)\s+\w+/m,
  );
  assert.match(migration, /and q\.actor_key = 'global'\s+for update;/);
  assert.match(migration, /and q\.actor_key = p_actor_key\s+for update;/);
  assert.match(
    migration,
    /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(/,
  );
  assert.match(
    migration,
    /public\.ingest_telemetry_delta\([\s\S]*p_session_id,[\s\S]*p_owner_id,[\s\S]*p_is_member,[\s\S]*pg_catalog\.encode/,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_public_analytics_event\(/,
  );
  assert.match(
    migration,
    /grant execute on function public\.reserve_score_write_attempt\(/,
  );
  assert.match(
    migration,
    /grant execute on function public\.reserve_report_write_attempt\(/,
  );
  assert.match(
    migration,
    /capped network spray unbounded[\s\S]*?q\.request_count = 0[\s\S]*?capped owner[\s\S]*?q\.request_count = 0/,
  );
  assert.match(
    migration,
    /when lock_not_available[\s\S]*?or query_canceled[\s\S]*?or serialization_failure[\s\S]*?or deadlock_detected then[\s\S]*?'writeAttemptError', 'score_write_quota_busy'/,
  );
  assert.match(
    migration,
    /when lock_not_available[\s\S]*?or query_canceled[\s\S]*?or serialization_failure[\s\S]*?or deadlock_detected then[\s\S]*?'writeAttemptError', 'report_write_quota_busy'/,
  );
  assert.match(migration, /set state = 'failed',[\s\S]*?writeAttemptError/);
  assert.match(
    migration,
    /delete from public\.public_write_attempts[\s\S]*?delete from public\.public_write_quota_buckets/,
  );
});
