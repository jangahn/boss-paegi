import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  InvalidStrictConfigError,
  resolveStrictSettingResult,
} from "../../lib/config/strict.ts";
import {
  InvalidConfigWriteResultError,
  parseConfigWriteHttpAck,
  parseConfigWriteResult,
} from "../../lib/config/write-result.ts";
import { SupabaseOperationError } from "../../lib/supabase-operation.ts";
import { readFileSync } from "node:fs";

const schema = z.object({
  signupBonusCredits: z.number().int().min(0).max(100),
});
const fallback = { signupBonusCredits: 3 };

test("strict config falls back only for an authoritative successful no-row", () => {
  assert.equal(
    resolveStrictSettingResult(
      "growth_levers",
      schema,
      fallback,
      { data: null, error: null },
    ),
    fallback,
  );
  assert.deepEqual(
    resolveStrictSettingResult(
      "growth_levers",
      schema,
      fallback,
      {
        data: { value: { signupBonusCredits: 8 }, version: 4 },
        error: null,
      },
    ),
    { signupBonusCredits: 8 },
  );
});

test("resolved config dependency errors cannot mint a fallback-priced result", () => {
  const injected = new Error("injected app_settings read failure");
  assert.throws(
    () =>
      resolveStrictSettingResult(
        "growth_levers",
        schema,
        fallback,
        { data: null, error: injected },
      ),
    (error) =>
      error instanceof SupabaseOperationError &&
      error.operation === "config.strict.growth_levers" &&
      error.operationError === injected,
  );
});

test("invalid persisted config cannot be silently replaced by code defaults", () => {
  assert.throws(
    () =>
      resolveStrictSettingResult(
        "growth_levers",
        schema,
        fallback,
        {
          data: {
            value: { signupBonusCredits: "not-a-number" },
            version: 9,
          },
          error: null,
        },
      ),
    (error) =>
      error instanceof InvalidStrictConfigError &&
      error.key === "growth_levers",
  );
});

test("config writes accept only an exact positive safe-integer RPC result", () => {
  assert.deepEqual(
    parseConfigWriteResult(
      { ok: true, key: "growth_levers", version: 12 },
      "growth_levers",
    ),
    { version: 12 },
  );

  for (const invalid of [
    null,
    "12",
    {},
    { ok: false, key: "growth_levers", version: 12 },
    { ok: true, key: "other_domain", version: 12 },
    { ok: true, key: "growth_levers", version: null },
    { ok: true, key: "growth_levers", version: "12" },
    { ok: true, key: "growth_levers", version: -1 },
    { ok: true, key: "growth_levers", version: 0 },
    { ok: true, key: "growth_levers", version: 1.5 },
    {
      ok: true,
      key: "growth_levers",
      version: 12,
      error: "late_failure",
    },
    {
      ok: true,
      key: "growth_levers",
      version: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    assert.throws(
      () => parseConfigWriteResult(invalid, "growth_levers"),
      InvalidConfigWriteResultError,
    );
  }
});

test("config browser success is bound to the exact next CAS version", () => {
  assert.deepEqual(parseConfigWriteHttpAck({ ok: true, version: 8 }, 7), {
    ok: true,
    version: 8,
  });
  for (const invalid of [
    null,
    {},
    { ok: false, version: 8 },
    { ok: true },
    { ok: true, version: 7 },
    { ok: true, version: 9 },
    { ok: true, version: 8.5 },
    { ok: true, version: 8, error: "late_failure" },
  ]) {
    assert.equal(parseConfigWriteHttpAck(invalid, 7), null);
  }
  assert.equal(
    parseConfigWriteHttpAck({ ok: true, version: 1 }, -1),
    null,
  );

  const editorPaths = [
    "BusinessInfoEditor.tsx",
    "BadgeCatalogEditor.tsx",
    "RestoreButton.tsx",
    "ScoreConfigEditor.tsx",
    "SessionLimitsEditor.tsx",
    "MediaConfigEditor.tsx",
    "RoleContentEditor.tsx",
    "SiteContentEditor.tsx",
    "MarketingCopyEditor.tsx",
    "GenerationConfigEditor.tsx",
    "GrowthLeversEditor.tsx",
  ] as const;
  for (const relative of editorPaths) {
    const editor = readFileSync(
      new URL(
        `../../components/admin/content/${relative}`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(editor, /submitAdminConfigMutation/);
    if (relative === "MediaConfigEditor.tsx") {
      assert.match(
        editor,
        /submitAdminConfigMutation\(\{[\s\S]*baseVersion,[\s\S]*signal,/,
      );
    } else {
      assert.match(editor, /useAdminConfigMutation\(\)/);
    }
    assert.doesNotMatch(editor, /res\.ok && out\.ok/);
    assert.doesNotMatch(editor, /out\.version \?\? .*Version \+ 1/);
  }
  const sharedClient = readFileSync(
    new URL("../../lib/admin-config-client.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    sharedClient,
    /parseConfigWriteHttpAck\(body, options\.baseVersion\)/,
  );
  assert.match(sharedClient, /runReplayedJsonMutation\(\{/);
  assert.match(
    sharedClient,
    /if \(outcome\.kind === "confirmed"\)[\s\S]*ack: outcome\.value\.ack/,
  );
});

test("consent and generation routes read strict config before mutations/side effects", () => {
  const consent = readFileSync(
    new URL("../../app/api/account/consent/route.ts", import.meta.url),
    "utf8",
  );
  const growth = consent.indexOf("getGrowthLeversStrict");
  const memberWrite = consent.indexOf(
    '"create_or_update_member_consent_with_profile"',
  );
  assert.ok(growth >= 0 && memberWrite > growth);
  assert.match(
    consent,
    /account\.consent_growth_config_fail[\s\S]*?status: 503/,
  );

  const generation = readFileSync(
    new URL("../../app/api/fal/route.ts", import.meta.url),
    "utf8",
  );
  const configRead = generation.indexOf(
    "getGenerationConfigWithMetaStrict()",
  );
  const reservationClaim = generation.indexOf(
    '"claim_generation_preflight"',
  );
  assert.ok(
    reservationClaim >= 0 && reservationClaim < configRead,
    "the DB-authoritative reservation must be claimed before reading a snapshot",
  );
  for (const sideEffect of [
    "checkFalBalance()",
    "uploadFaceTmp(",
    '"prepare_generation_face_checks"',
    "submitFaceCheckOnce(",
  ]) {
    const effect = generation.indexOf(sideEffect);
    assert.ok(
      configRead >= 0 && effect > configRead,
      `${sideEffect} must occur only after strict generation config`,
    );
  }
  assert.match(generation, /gen\.config_read_fail[\s\S]*?status: 503/);
});
