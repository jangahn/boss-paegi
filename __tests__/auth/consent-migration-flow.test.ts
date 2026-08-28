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

test("flow migration consumes the serializable DB receipt before the anon auth delete", () => {
  const onboard = source("lib/account-onboard.ts");
  const consent = source("app/api/account/consent/route.ts");
  const flowConsume = onboard.indexOf(
    '"consume_oauth_flow_intent_migration"',
  );
  assert.ok(flowConsume >= 0);
  assert.match(
    onboard.slice(flowConsume),
    /parseOAuthMigrationReceipt[\s\S]*?receipt\.skipReason !== null[\s\S]*?return "skipped"[\s\S]*?deleteAuthUserAcceptingMissing\(admin, anonId\)/,
  );
  // 삭제 판정은 공용 계약(deleteAuthUserAcceptingMissing) 단일 경로 — GoTrue 성공 응답에는
  // user 가 없어 응답 형태 재검증은 성공을 실패로 오판한다(v1.00). 직접 deleteUser 호출 금지.
  assert.doesNotMatch(onboard, /auth\.admin\.deleteUser/);
  // pre-ledger(legacy 쿠키) 경로는 v1.03 에서 소멸 — flow 권위 3-인자 호출이 유일 경로.
  assert.match(
    consent,
    /migrateAnonData\(\s*admin,\s*user\.id,\s*migrationAuthority,\s*\)/,
  );
  assert.match(consent, /export const maxDuration = 300;/);
  // 식별자 단위 소멸 핀(이력 설명 주석의 'legacy' 단어는 허용).
  assert.doesNotMatch(
    onboard,
    /legacyCookieValue|legacyCapability|runAnonDataMigration|parseLegacyMigrationReceipt|verifyLegacyMigrateValue/,
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

