import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  oauthFlowStatusNeedsRecoveryAuthority,
  parseOAuthFlowStatusReadReceipt,
  type OAuthFlowStatus,
} from "../../lib/oauth-flow-status.ts";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";

function status(
  overrides: Partial<OAuthFlowStatus>,
): OAuthFlowStatus {
  return {
    flowId: FLOW_ID,
    provider: "google",
    sourceIsAnonymous: false,
    requestedNext: "/",
    state: "failed",
    active: false,
    outcome: "failed",
    targetUserId: null,
    targetSessionId: null,
    destination: "/",
    action: "continue",
    createdAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-07-31T00:10:00.000Z",
    claimedAt: "2026-07-31T00:01:00.000Z",
    revokeConfirmedAt: null,
    finishedAt: "2026-07-31T00:02:00.000Z",
    releasedAt: null,
    migrationConsumedAt: null,
    ...overrides,
  };
}

test("session fences and released unconsumed anonymous migrations may refresh recovery authority", () => {
  for (const activeState of [
    "pending",
    "claimed",
    "signout_required",
    "signout_revoked",
  ] as const) {
    assert.equal(
      oauthFlowStatusNeedsRecoveryAuthority(
        status({ state: activeState, active: true }),
      ),
      true,
    );
  }
  assert.equal(
    oauthFlowStatusNeedsRecoveryAuthority(
      status({
        state: "completed",
        outcome: "completed",
        action: "continue",
        targetUserId:
          "22222222-2222-4222-8222-222222222222",
        targetSessionId:
          "33333333-3333-4333-8333-333333333333",
        releasedAt: null,
      }),
    ),
    true,
  );
  assert.equal(
    oauthFlowStatusNeedsRecoveryAuthority(
      status({
        state: "completed",
        outcome: "completed",
        sourceIsAnonymous: true,
        action: "continue",
        targetUserId:
          "22222222-2222-4222-8222-222222222222",
        targetSessionId:
          "33333333-3333-4333-8333-333333333333",
        releasedAt: "2026-07-31T00:03:00.000Z",
        migrationConsumedAt: null,
      }),
    ),
    true,
  );
  assert.equal(
    oauthFlowStatusNeedsRecoveryAuthority(
      status({
        state: "completed",
        outcome: "completed",
        sourceIsAnonymous: true,
        action: "continue",
        targetUserId:
          "22222222-2222-4222-8222-222222222222",
        targetSessionId:
          "33333333-3333-4333-8333-333333333333",
        releasedAt: "2026-07-31T00:03:00.000Z",
        migrationConsumedAt: "2026-07-31T00:04:00.000Z",
      }),
    ),
    false,
  );
  for (const nonFenced of [
    status({
      state: "completed",
      outcome: "completed",
      action: "continue",
      targetUserId:
        "22222222-2222-4222-8222-222222222222",
      targetSessionId:
        "33333333-3333-4333-8333-333333333333",
      releasedAt: "2026-07-31T00:03:00.000Z",
    }),
    status({
      state: "completed",
      outcome: "completed",
      action: "signout",
      targetUserId:
        "22222222-2222-4222-8222-222222222222",
      targetSessionId:
        "33333333-3333-4333-8333-333333333333",
    }),
    status({ state: "failed", active: false }),
    status({
      state: "cancelled",
      active: false,
      outcome: "cancelled",
    }),
    status({
      state: "abandoned",
      active: false,
      outcome: "abandoned",
    }),
    status({
      state: "expired",
      active: false,
      outcome: "expired",
    }),
  ]) {
    assert.equal(
      oauthFlowStatusNeedsRecoveryAuthority(nonFenced),
      false,
    );
  }
});

test("status-read absence is accepted only as the exact DB receipt", () => {
  assert.deepEqual(
    parseOAuthFlowStatusReadReceipt(
      { ok: false, error: "oauth_flow_not_found" },
      FLOW_ID,
    ),
    { kind: "absent" },
  );
  for (const malformed of [
    { ok: true, error: "oauth_flow_not_found" },
    { ok: false, error: "oauth_flow_not_found", extra: true },
    { ok: false, error: "invalid_oauth_flow" },
    { error: "oauth_flow_not_found" },
    null,
  ]) {
    assert.equal(
      parseOAuthFlowStatusReadReceipt(malformed, FLOW_ID),
      null,
    );
  }
});

test("pruned proof-bound rows clear cookies instead of extending or retry-looping", async () => {
  const route = await readFile(
    new URL(
      "../../app/api/auth/oauth-flow/status/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const existingStart = route.indexOf("if (existing)");
  const existing = route.slice(
    existingStart,
    route.indexOf(
      'if (raw.kind === "invalid")',
      existingStart,
    ),
  );
  const fenced = existing.indexOf(
    "oauthFlowStatusNeedsRecoveryAuthority(status)",
  );
  const authoritative = existing.indexOf(
    "observedSessionProvesRecoveryAuthority({",
  );
  const reissue = existing.indexOf(
    "signOAuthFlowRecoveryProof(",
  );
  const missing = existing.indexOf(
    "error instanceof OAuthFlowStatusNotFoundError",
  );
  const absent = existing.indexOf(
    "return absentFlowResponse(flowId)",
  );
  const retry = existing.indexOf('"auth_unavailable"');
  assert.ok(fenced >= 0);
  assert.ok(authoritative > fenced);
  assert.ok(reissue > authoritative);
  assert.ok(missing > reissue);
  assert.ok(absent > missing);
  assert.ok(retry > absent);

  const absentHelper = route.slice(
    route.indexOf("function absentFlowResponse("),
    route.indexOf("export async function POST"),
  );
  assert.match(
    absentHelper,
    /state: "absent"[\s\S]*?clearOAuthFlowCookies\(result, flowId\)[\s\S]*?migrateCookieName\(flowId\)[\s\S]*?maxAge: 0/,
  );
  assert.match(
    route,
    /async function observedSessionProvesRecoveryAuthority[\s\S]*?readServerAuthUser\(\{[\s\S]*?auth\.kind === "valid"[\s\S]*?auth\.user\.id === options\.userId[\s\S]*?auth\.user\.is_anonymous === options\.expectedAnonymous[\s\S]*?auth\.kind === "unavailable"[\s\S]*?expiredObservedEvidenceMatches\(\{/,
  );
  const recovered = route.slice(
    route.indexOf("const absent = parseOAuthFlowMinimalRecovery"),
    route.indexOf(
      'if (raw.kind === "absent")',
      route.indexOf(
        "const absent = parseOAuthFlowMinimalRecovery",
      ),
    ),
  );
  assert.match(
    recovered,
    /absent\?\.state === "absent"[\s\S]*?absent !== null && !absent\.active[\s\S]*?minimalFlowResponse\(absent\)/,
  );
});

test("탈퇴 계정 signout 흐름의 실제 운영 영수증이 파싱된다 — /login 종착지 거부 금지", () => {
  // 2026-08-01 운영 실측 원형(flow 0ebea1a9): destination 이 게이트 경로
  // (/login?error=account_deleted)라는 이유로 파서가 서버 기록을 거부하면
  // 상태 조회가 503 루프가 되고 탈퇴 계정 로그인이 영구히 갇힌다. 재발 금지.
  const receipt = {
    ok: true,
    state: "signout_required",
    action: "signout",
    active: true,
    flowId: "0ebea1a9-774f-42fd-b4d0-66987393c3f6",
    outcome: null,
    provider: "google",
    claimedAt: "2026-07-31T18:02:51.707023+00:00",
    createdAt: "2026-07-31T18:02:42.937377+00:00",
    expiresAt: "2026-07-31T18:12:42.937377+00:00",
    finishedAt: null,
    releasedAt: null,
    destination: "/login?error=account_deleted",
    targetUserId: "319481de-6a11-41f5-853a-5551ea8ebe22",
    requestedNext: "/",
    targetSessionId: "6dbf6689-5abf-4548-a9a6-7b92c4c1183f",
    revokeConfirmedAt: null,
    sourceIsAnonymous: true,
    migrationConsumedAt: null,
  };
  const parsed = parseOAuthFlowStatusReadReceipt(
    receipt,
    receipt.flowId,
  );
  assert.ok(parsed && parsed.kind === "found");
  assert.equal(parsed.status.state, "signout_required");
  assert.equal(parsed.status.destination, "/login?error=account_deleted");
  // 종착지의 open-redirect 봉쇄는 유지된다.
  for (const bad of ["//evil.example", "https://evil.example/x", "/a#b"]) {
    assert.equal(
      parseOAuthFlowStatusReadReceipt(
        { ...receipt, destination: bad },
        receipt.flowId,
      ),
      null,
    );
  }
});

test("흐름 종착지 검증은 전 표면에서 safeFlowDestination 단일 소스다", async () => {
  // PR#203 이 파서만 고치고 complete-signout 라우트의 동일 함정을 남겨
  // ACK 409 루프가 한 단계 뒤에서 재현됐다(2026-08-01 운영 실측).
  // 종착지(destination)에 safeNext(로그인 차단목록)를 쓰는 코드가 다시
  // 생기면 탈퇴 로그인 전체가 잠긴다 — 소스 레벨로 봉인한다.
  const { safeFlowDestination } = await import(
    "../../lib/oauth-flow-status.ts"
  );
  const { safeNext } = await import("../../lib/oauth-metadata.ts");
  assert.equal(safeFlowDestination("/login?error=account_deleted"), true);
  assert.equal(safeFlowDestination("/login?error=email_required"), true);
  // safeNext 는 같은 값을 collapse 한다 — 종착지 검증에 오용 금지의 이유.
  assert.notEqual(safeNext("/login?error=account_deleted"), "/login?error=account_deleted");

  const signout = await readFile(
    new URL(
      "../../app/api/auth/oauth-flow/complete-signout/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(signout, /safeFlowDestination\(/);
  const codeOnly = signout
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codeOnly, /safeNext\(/);
});
