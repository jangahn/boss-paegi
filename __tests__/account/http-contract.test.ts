import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAccountConsentHttpAck,
  parseAccountDeletionHttpAck,
} from "../../lib/account-http-contract.ts";

test("consent success requires the exact acknowledgement", () => {
  assert.deepEqual(parseAccountConsentHttpAck({ ok: true }), { ok: true });
  for (const malformed of [
    null,
    {},
    { ok: false },
    { ok: 1 },
    { ok: true, error: "late_failure" },
  ]) {
    assert.equal(parseAccountConsentHttpAck(malformed), null);
  }
});

test("account deletion accepts only exact committed and durable-pending states", () => {
  assert.deepEqual(
    parseAccountDeletionHttpAck({ ok: true, cleanup: "completed" }),
    { ok: true, cleanup: "completed" },
  );
  assert.deepEqual(
    parseAccountDeletionHttpAck({ accepted: true, cleanup: "pending" }),
    { accepted: true, cleanup: "pending" },
  );
  for (const malformed of [
    null,
    { ok: true },
    { accepted: true },
    { ok: true, cleanup: "pending" },
    { accepted: true, cleanup: "completed" },
    { ok: true, cleanup: "completed", error: "late_failure" },
  ]) {
    assert.equal(parseAccountDeletionHttpAck(malformed), null);
  }
});

test("consent and withdrawal clients validate 2xx bodies before navigation", () => {
  const consent = readFileSync(
    new URL("../../app/consent/ConsentForm.tsx", import.meta.url),
    "utf8",
  );
  const account = readFileSync(
    new URL("../../app/account/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    consent,
    /response\.ok\s*&&\s*parseAccountConsentHttpAck\(body\)/,
  );
  assert.match(account, /res\.ok && parseAccountDeletionHttpAck\(out\)/);
  assert.match(consent, /runReplayedJsonMutation\(/);
  assert.match(account, /runClientMutation\(\{/);
  assert.match(
    account,
    /if \(outcome\.kind === "confirmed"\) \{\s*try \{\s*await signOut/,
  );
});
