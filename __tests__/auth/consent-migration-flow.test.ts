import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  );
}

test("consent page accepts exactly one valid migration flow and fails closed otherwise", () => {
  const page = source("app/consent/page.tsx");

  assert.match(
    page,
    /migrationFlow\?: string \| string\[\]/,
  );
  assert.match(
    page,
    /function parseExactMigrationFlow\([\s\S]*?value === undefined[\s\S]*?typeof value !== "string" \|\| !isOAuthFlowId\(value\)[\s\S]*?return \{ ok: false \}/,
  );
  assert.match(
    page,
    /if \(!migrationFlowRead\.ok\) \{[\s\S]*?readUnavailable\(\s*dest,\s*null,\s*"migration_flow",\s*new Error\("migration_flow_invalid"\)/,
  );
  assert.doesNotMatch(
    page,
    /INVALID_MIGRATION_FLOW_RETRY/,
  );
});

test("consent retries and submissions preserve a validated migration flow", () => {
  const page = source("app/consent/page.tsx");
  const form = source("app/consent/ConsentForm.tsx");

  assert.match(
    page,
    /name="migrationFlow"\s+value=\{migrationFlow\}/,
  );
  assert.match(
    page,
    /readUnavailable\(dest, migrationFlow, source, error, userId\)/,
  );
  assert.match(
    page,
    /<ConsentForm[\s\S]*?migrationFlow=\{migrationFlow\}/,
  );
  assert.match(
    form,
    /if \(migrationFlow !== null\) \{\s*payload\.migrationFlow = migrationFlow;/,
  );
});

test("an empty consent set still submits idempotently when migration recovery is pending", () => {
  const page = source("app/consent/page.tsx");
  const form = source("app/consent/ConsentForm.tsx");

  assert.match(
    page,
    /if \(items\.length === 0 && migrationFlow === null\) \{\s*redirect\(dest\)/,
  );
  assert.match(
    form,
    /const all = items\.every\(\(i\) => checked\[i\]\)/,
  );
  assert.match(
    form,
    /const payload:[\s\S]*?= \{\};\s*items\.forEach[\s\S]*?payload\.migrationFlow = migrationFlow/,
  );
});

test("finalize scopes migration recovery destinations to anonymous-source flows", () => {
  const finalize = source(
    "app/api/auth/oauth-flow/finalize/route.ts",
  );

  assert.match(
    finalize,
    /const consentDestination =\s*`\/consent\?next=\$\{encodeURIComponent\(input\.next\)\}`;\s*destination = authority\.proof\.sourceIsAnonymous\s*\? consentDestination \+\s*`&migrationFlow=\$\{encodeURIComponent\(input\.flowId\)\}`\s*: consentDestination;/,
  );
});

test("consent migration accepts only a normally released, never-revoked continue flow", () => {
  const consent = source("app/api/account/consent/route.ts");
  const authority = consent.slice(
    consent.indexOf(
      "recovered.status.state !== \"completed\"",
    ),
    consent.indexOf("migrationAuthority = {"),
  );
  assert.match(
    authority,
    /recovered\.status\.action !== "continue"[\s\S]*?recovered\.status\.releasedAt === null[\s\S]*?recovered\.status\.revokeConfirmedAt !== null[\s\S]*?!recovered\.status\.sourceIsAnonymous/,
  );
  assert.match(
    source("lib/account-onboard.ts"),
    /consume_oauth_flow_intent_migration/,
  );
  assert.match(
    authority,
    /recovered\.status\.targetSessionId !==[\s\S]*?targetSession\.session\.sessionId[\s\S]*?recovered\.status\.migrationConsumedAt === null/,
  );
  assert.match(
    consent,
    /targetSessionId: recovered\.status\.targetSessionId/,
  );
});

test("query stripping discovers an unconsumed flow while an explicit flow bypasses global ambiguity", () => {
  const consent = source("app/api/account/consent/route.ts");
  const noHintBranch = consent.indexOf(
    "if (migrationFlow === null)",
  );
  const discovery = consent.indexOf(
    '"recover_active_oauth_flow_by_observed_session"',
    noHintBranch,
  );
  const resolved = consent.indexOf(
    "resolvedMigrationFlow = discovered.status.flowId",
    discovery,
  );
  const exact = consent.indexOf(
    '"recover_oauth_flow_intent_authority"',
    resolved,
  );
  const migrate = consent.indexOf(
    "const migration = await prepareAnonMigration",
    exact,
  );
  const mutation = consent.indexOf(
    "const mutation = await resolveConsentMutation",
    migrate,
  );

  assert.ok(noHintBranch >= 0);
  assert.ok(discovery > noHintBranch);
  assert.ok(resolved > discovery);
  assert.ok(exact > resolved);
  assert.ok(migrate > exact);
  assert.ok(mutation > migrate);
  assert.match(
    consent.slice(noHintBranch, exact),
    /migrationFlow === null[\s\S]*?recover_active_oauth_flow_by_observed_session[\s\S]*?resolvedMigrationFlow = discovered\.status\.flowId/,
  );
  assert.doesNotMatch(
    consent.slice(noHintBranch, exact),
    /migrationFlow !== discovered\.status\.flowId/,
  );
  assert.match(
    consent.slice(exact, migrate),
    /recover_oauth_flow_intent_authority[\s\S]*?p_flow_id: resolvedMigrationFlow[\s\S]*?parseOAuthFlowRecoveredAuthority/,
  );
  assert.match(
    consent.slice(migrate, mutation),
    /migrationAuthority !== null/,
  );
});

test("flow migration consumes the serializable DB receipt before any legacy policy pre-read", () => {
  const onboard = source("lib/account-onboard.ts");
  const flowConsume = onboard.indexOf(
    '"consume_oauth_flow_intent_migration"',
  );
  const genericRunner = onboard.indexOf(
    "const outcome = await runAnonDataMigration",
  );

  assert.ok(flowConsume >= 0);
  assert.ok(genericRunner > flowConsume);
  assert.match(
    onboard.slice(flowConsume, genericRunner),
    /parseOAuthMigrationReceipt[\s\S]*?receipt\.skipReason !== null[\s\S]*?return "skipped"[\s\S]*?deleteUser\(anonId\)/,
  );
  // 삭제 판정은 오류로만 — GoTrue 성공 응답에는 user 가 없어(auth-js `{ user: {} }`)
  // 응답 형태 재검증은 성공을 실패로 오판한다(user_not_found 는 멱등 성공).
  assert.match(
    onboard.slice(flowConsume, genericRunner),
    /deleteUser\(anonId\)[\s\S]*?deleted\.error !== null &&[\s\S]*?!isMissingAuthUserError\(deleted\.error\)[\s\S]*?throw deleted\.error/,
  );
  assert.doesNotMatch(
    onboard.slice(flowConsume, genericRunner),
    /deleted\.data\.user/,
  );
  assert.match(
    source("lib/anon-data-migration.ts"),
    /reassignmentSkipReason[\s\S]*?if \(reassignedSkip !== null\)[\s\S]*?result: "skipped"/,
  );
});

test("status recovery accepts a verified newer target session only after a terminal migration receipt", () => {
  const status = source("app/api/auth/oauth-flow/status/route.ts");
  const recoveryStart = status.indexOf("const observedIsSource");
  const recovery = status.slice(
    recoveryStart,
    status.indexOf(
      "const auth = await readServerAuthUser",
      recoveryStart,
    ),
  );

  assert.match(
    recovery,
    /const observedIsBoundTarget[\s\S]*?raw\.session\.sessionId === status\.targetSessionId/,
  );
  assert.match(
    recovery,
    /const observedIsTerminalTargetRecovery =[\s\S]*?status\.state === "completed"[\s\S]*?status\.action === "continue"[\s\S]*?status\.sourceIsAnonymous[\s\S]*?status\.releasedAt !== null[\s\S]*?status\.revokeConfirmedAt === null[\s\S]*?status\.migrationConsumedAt !== null/,
  );
  assert.match(
    recovery,
    /const observedIsTarget =\s*observedIsBoundTarget \|\|\s*observedIsTerminalTargetRecovery/,
  );
});

test("pre-ledger HMAC migration is available only when no flow authority exists", () => {
  const consent = source("app/api/account/consent/route.ts");
  const onboard = source("lib/account-onboard.ts");
  const legacy = onboard.indexOf("const legacyCapability");
  const flow = onboard.indexOf(
    '"consume_oauth_flow_intent_migration"',
    legacy,
  );
  const bridge = onboard.indexOf(
    '"consume_legacy_signup_migration"',
    flow,
  );
  const terminalSkip = onboard.indexOf(
    'if (outcome.result === "skipped")',
    bridge,
  );

  assert.match(
    consent,
    /migrateAnonData\([\s\S]*?migrationAuthority,[\s\S]*?req\.cookies\.get\(MIGRATE_COOKIE\)\?\.value,[\s\S]*?targetSession\.session\.sessionId/,
  );
  assert.match(consent, /export const maxDuration = 300;/);
  assert.ok(legacy >= 0);
  assert.ok(flow > legacy);
  assert.ok(bridge > flow);
  assert.ok(terminalSkip > bridge);
  assert.match(
    onboard.slice(legacy, flow),
    /authority === null[\s\S]*?verifyLegacyMigrateValue\(legacyCookieValue\)/,
  );
  assert.match(
    onboard.slice(flow, bridge),
    /consume_oauth_flow_intent_migration[\s\S]*?parseOAuthMigrationReceipt/,
  );
  assert.match(
    onboard.slice(bridge, terminalSkip),
    /consume_legacy_signup_migration[\s\S]*?parseLegacyMigrationReceipt/,
  );
  assert.doesNotMatch(
    onboard.slice(legacy, terminalSkip),
    /"reassign_anon_data"/,
  );
  assert.match(
    onboard.slice(terminalSkip),
    /outcome\.reason === "unexpected_data"[\s\S]*?return "skipped"/,
  );
});
