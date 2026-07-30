import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmUploadIntentWithLegacyAdoption,
  parseConfirmedUploadIntent,
  parseCreatedUploadIntent,
  resolveUploadIntentMutation,
  uploadIntentErrorMessage,
} from "../../lib/upload-write-safety.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-07-29T00:00:00.000Z");
const EXPIRES = "2026-07-29T02:05:00.000Z";

test("created upload intent acknowledgement is exact for signed and server-side uploads", () => {
  assert.deepEqual(
    parseCreatedUploadIntent(
      { ok: true, intent_id: ID, expires_at: EXPIRES },
      { expires: true, nowMs: NOW },
    ),
    { intentId: ID, expiresAt: EXPIRES },
  );
  assert.deepEqual(
    parseCreatedUploadIntent(
      { ok: true, intent_id: ID },
      { expires: false, nowMs: NOW },
    ),
    { intentId: ID },
  );
  for (const value of [
    null,
    {},
    { ok: false, intent_id: ID, expires_at: EXPIRES },
    { ok: true, intent_id: "not-a-uuid", expires_at: EXPIRES },
    { ok: true, intent_id: ID },
    { ok: true, intent_id: ID, expires_at: "invalid" },
    {
      ok: true,
      intent_id: ID,
      expires_at: "2026-07-29T03:00:00.000Z",
    },
    { ok: true, intent_id: ID, expires_at: EXPIRES, extra: true },
  ]) {
    assert.equal(
      parseCreatedUploadIntent(value, {
        expires: true,
        nowMs: NOW,
      }),
      null,
    );
  }
  assert.equal(
    parseCreatedUploadIntent(
      { ok: true, intent_id: ID, expires_at: EXPIRES },
      { expires: false, nowMs: NOW },
    ),
    null,
  );
});

test("confirm upload intent accepts only the two exact durable outcomes", () => {
  assert.equal(
    parseConfirmedUploadIntent({ ok: true, outcome: "confirmed" }),
    "confirmed",
  );
  assert.equal(
    parseConfirmedUploadIntent({
      ok: true,
      outcome: "already_attached",
    }),
    "already_attached",
  );
  for (const value of [
    null,
    {},
    { ok: false, outcome: "confirmed" },
    { ok: true, outcome: "unknown" },
    { ok: true, outcome: "confirmed", extra: true },
  ]) {
    assert.equal(parseConfirmedUploadIntent(value), null);
  }
});

test("upload intent mutation normalizes success, resolved error, and throw", async () => {
  assert.deepEqual(
    await resolveUploadIntentMutation(async () => ({
      data: { ok: true },
      error: null,
    })),
    { ok: true, data: { ok: true } },
  );
  const resolved = { message: "account_deleted" };
  assert.deepEqual(
    await resolveUploadIntentMutation(async () => ({
      data: { ok: true },
      error: resolved,
    })),
    { ok: false, error: resolved },
  );
  const thrown = new Error("transport failed");
  assert.deepEqual(
    await resolveUploadIntentMutation(async () => {
      throw thrown;
    }),
    { ok: false, error: thrown },
  );
  assert.equal(uploadIntentErrorMessage(resolved), "account_deleted");
  assert.equal(uploadIntentErrorMessage(null), "");
});

const LEGACY_SURFACES = [
  "avatar",
  "highlight",
  "event image",
  "site asset",
] as const;

function forbidden() {
  return { data: null, error: { message: "upload_intent_forbidden" } };
}

function confirmed(outcome: "confirmed" | "already_attached" = "confirmed") {
  return { data: { ok: true, outcome }, error: null };
}

function created() {
  return {
    data: { ok: true, intent_id: ID, expires_at: EXPIRES },
    error: null,
  };
}

for (const surface of LEGACY_SURFACES) {
  test(`${surface}: a lost create response is recovered only by an exact second confirmation`, async () => {
    let hasCompatibleIntent = false;
    let confirms = 0;
    let creates = 0;
    const result = await confirmUploadIntentWithLegacyAdoption({
      nowMs: NOW,
      confirm: async () => {
        confirms += 1;
        return hasCompatibleIntent ? confirmed() : forbidden();
      },
      create: async () => {
        creates += 1;
        hasCompatibleIntent = true;
        throw new Error("response_lost_after_commit");
      },
    });

    assert.deepEqual(result, {
      ok: true,
      outcome: "confirmed",
      adoptedLegacy: true,
    });
    assert.equal(confirms, 2);
    assert.equal(creates, 1);
  });

  test(`${surface}: a concurrent adopter can win the path race without causing a false failure`, async () => {
    let hasCompatibleIntent = false;
    let confirms = 0;
    const result = await confirmUploadIntentWithLegacyAdoption({
      nowMs: NOW,
      confirm: async () => {
        confirms += 1;
        return hasCompatibleIntent ? confirmed() : forbidden();
      },
      create: async () => {
        hasCompatibleIntent = true;
        return {
          data: null,
          error: { message: "duplicate key value violates unique constraint" },
        };
      },
    });

    assert.deepEqual(result, {
      ok: true,
      outcome: "confirmed",
      adoptedLegacy: true,
    });
    assert.equal(confirms, 2);
  });

  test(`${surface}: retry confirms an already adopted path without creating again`, async () => {
    let hasCompatibleIntent = false;
    let attached = false;
    let creates = 0;
    const callbacks = {
      nowMs: NOW,
      confirm: async () =>
        hasCompatibleIntent
          ? confirmed(attached ? "already_attached" : "confirmed")
          : forbidden(),
      create: async () => {
        creates += 1;
        hasCompatibleIntent = true;
        return created();
      },
    };

    assert.deepEqual(
      await confirmUploadIntentWithLegacyAdoption(callbacks),
      {
        ok: true,
        outcome: "confirmed",
        adoptedLegacy: true,
      },
    );
    attached = true;
    assert.deepEqual(
      await confirmUploadIntentWithLegacyAdoption(callbacks),
      {
        ok: true,
        outcome: "already_attached",
        adoptedLegacy: false,
      },
    );
    assert.equal(creates, 1);
  });

  test(`${surface}: an occupied path with mismatched authority/context stays forbidden`, async () => {
    let confirms = 0;
    const result = await confirmUploadIntentWithLegacyAdoption({
      nowMs: NOW,
      confirm: async () => {
        confirms += 1;
        return forbidden();
      },
      create: async () => ({
        data: null,
        error: { message: "duplicate key value violates unique constraint" },
      }),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "adopted_confirmation");
      assert.equal(
        uploadIntentErrorMessage(result.error),
        "upload_intent_forbidden",
      );
    }
    assert.equal(confirms, 2);
  });

  test(`${surface}: a malformed create acknowledgement is never reclassified as adoption`, async () => {
    let confirms = 0;
    const result = await confirmUploadIntentWithLegacyAdoption({
      nowMs: NOW,
      confirm: async () => {
        confirms += 1;
        return forbidden();
      },
      create: async () => ({
        data: { ok: true, intent_id: ID, expires_at: EXPIRES, extra: true },
        error: null,
      }),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "legacy_intent_creation");
      assert.equal(
        uploadIntentErrorMessage(result.error),
        "invalid_upload_intent_create_acknowledgement",
      );
    }
    assert.equal(confirms, 1);
  });
}

test("legacy adoption is attempted only for the exact forbidden-intent error", async () => {
  for (const message of [
    "upload_intent_expired",
    "upload_cleanup_in_progress",
    "account_deleted",
    "prefix upload_intent_forbidden",
    "upload_intent_forbidden suffix",
    "",
  ]) {
    let creates = 0;
    let confirms = 0;
    const result = await confirmUploadIntentWithLegacyAdoption({
      nowMs: NOW,
      confirm: async () => {
        confirms += 1;
        return { data: null, error: { message } };
      },
      create: async () => {
        creates += 1;
        return created();
      },
    });
    assert.equal(result.ok, false, message);
    assert.equal(confirms, 1, message);
    assert.equal(creates, 0, message);
  }
});

test("legacy adoption requires exact confirmation acknowledgements before and after create", async () => {
  let creates = 0;
  assert.deepEqual(
    await confirmUploadIntentWithLegacyAdoption({
      nowMs: NOW,
      confirm: async () => ({
        data: { ok: true, outcome: "confirmed", extra: true },
        error: null,
      }),
      create: async () => {
        creates += 1;
        return created();
      },
    }),
    {
      ok: false,
      error: new Error("invalid_upload_intent_confirm_acknowledgement"),
      phase: "initial_confirmation",
    },
  );
  assert.equal(creates, 0);

  let confirms = 0;
  const result = await confirmUploadIntentWithLegacyAdoption({
    nowMs: NOW,
    confirm: async () => {
      confirms += 1;
      return confirms === 1
        ? forbidden()
        : {
            data: { ok: true, outcome: "confirmed", extra: true },
            error: null,
          };
    },
    create: async () => created(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.phase, "adopted_confirmation");
    assert.equal(
      uploadIntentErrorMessage(result.error),
      "invalid_upload_intent_confirm_acknowledgement",
    );
  }
});
