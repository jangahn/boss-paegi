import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function before(
  body: string,
  earlier: string,
  later: string,
  message: string,
): void {
  const first = body.indexOf(earlier);
  const second = body.indexOf(later);
  assert.notEqual(first, -1, `${message}: missing ${earlier}`);
  assert.notEqual(second, -1, `${message}: missing ${later}`);
  assert.ok(first < second, message);
}

test("every signed-upload surface creates an intent before issuing a token", () => {
  const routes = [
    {
      file: "app/api/admin/site-asset/route.ts",
      create: '"create_admin_storage_upload_intent"',
    },
    {
      file: "app/api/admin/event-image/route.ts",
      create: '"create_admin_storage_upload_intent"',
    },
    {
      file: "app/api/avatar/route.ts",
      create: '"create_avatar_upload_intent"',
    },
    {
      file: "app/api/highlight/route.ts",
      create: '"create_highlight_upload_intent"',
    },
  ];

  for (const route of routes) {
    const body = source(route.file);
    assert.equal(
      body.match(/createSignedUploadUrl\(/g)?.length,
      1,
      `${route.file} has exactly one audited signed-upload issuance`,
    );
    before(
      body,
      route.create,
      "parseCreatedUploadIntent(intent.data",
      `${route.file} must validate the durable create acknowledgement`,
    );
    before(
      body,
      "parseCreatedUploadIntent(intent.data",
      ".createSignedUploadUrl(path)",
      `${route.file} must validate the cleanup receipt before token issuance`,
    );
    assert.match(body, /resolveUploadIntentMutation\(\(\) =>/);
    assert.match(body, /isFreshSignedUpload\(info\.createdAt\)/);
  }
});

test("every uploaded-object finalize confirms ownership before attaching", () => {
  const site = source("app/api/admin/site-asset/route.ts");
  const sitePatch = site.slice(site.indexOf("export async function PATCH"));
  before(
    sitePatch,
    "isFreshSignedUpload(info.createdAt)",
    "confirmUploadIntentWithLegacyAdoption({",
    "site asset object freshness is validated before legacy adoption",
  );
  before(
    sitePatch,
    "confirmUploadIntentWithLegacyAdoption({",
    "const previewUrl =",
    "site asset confirmation is validated before returning an attachable path",
  );
  assert.match(
    sitePatch,
    /confirm:\s*\(\) =>[\s\S]*?"confirm_admin_storage_upload_intent"[\s\S]*?create:\s*\(\) =>[\s\S]*?"create_admin_storage_upload_intent"[\s\S]*?p_purpose: `site_asset_\$\{slot\}`/,
  );

  const event = source("app/api/admin/event-image/route.ts");
  const eventPatch = event.slice(event.indexOf("export async function PATCH"));
  before(
    eventPatch,
    "isFreshSignedUpload(info.createdAt)",
    "confirmUploadIntentWithLegacyAdoption({",
    "event image object freshness is validated before legacy adoption",
  );
  before(
    eventPatch,
    "confirmUploadIntentWithLegacyAdoption({",
    "const url =",
    "event image confirmation is validated before returning an attachable path",
  );
  assert.match(
    eventPatch,
    /confirm:\s*\(\) =>[\s\S]*?"confirm_admin_storage_upload_intent"[\s\S]*?create:\s*\(\) =>[\s\S]*?"create_admin_storage_upload_intent"[\s\S]*?p_purpose: "event_image"/,
  );

  const avatar = source("app/api/avatar/route.ts");
  const avatarPatch = avatar.slice(
    avatar.indexOf("export async function PATCH"),
  );
  before(
    avatarPatch,
    "isFreshSignedUpload(info.createdAt)",
    "confirmUploadIntentWithLegacyAdoption({",
    "avatar object freshness is validated before legacy adoption",
  );
  before(
    avatarPatch,
    "confirmUploadIntentWithLegacyAdoption({",
    '"request_avatar_replace"',
    "avatar ownership/freshness confirmation precedes DB reference replacement",
  );
  assert.match(
    avatarPatch,
    /confirm:\s*\(\) =>[\s\S]*?"confirm_avatar_upload_intent"[\s\S]*?create:\s*\(\) =>[\s\S]*?"create_avatar_upload_intent"/,
  );

  const highlight = source("app/api/highlight/route.ts");
  const highlightPatch = highlight.slice(
    highlight.indexOf("export async function PATCH"),
  );
  const freshnessIndex = highlightPatch.indexOf(
    "isFreshSignedUpload(info.createdAt)",
  );
  const adoptIndex = highlightPatch.indexOf(
    "confirmUploadIntentWithLegacyAdoption({",
  );
  const clipInsertIndex = highlightPatch.indexOf(
    '.from("score_highlights").insert({',
    adoptIndex,
  );
  assert.ok(
    freshnessIndex >= 0 && adoptIndex > freshnessIndex,
    "highlight object freshness is validated before legacy adoption",
  );
  assert.ok(
    clipInsertIndex > adoptIndex,
    "highlight confirmation precedes the clip DB reference insertion",
  );
  assert.match(
    highlightPatch,
    /confirm:\s*\(\) =>[\s\S]*?"confirm_highlight_upload_intent"[\s\S]*?create:\s*\(\) =>[\s\S]*?"create_highlight_upload_intent"/,
  );
  assert.match(
    highlightPatch,
    /confirmationOutcome === "already_attached"[\s\S]*?highlight_clip_path !== path/,
  );
});

test("server-side doll upload also has an intent and DB-first compensation", () => {
  const materializer = source(
    "lib/character-gen/doll-pick-materialize.ts",
  );
  before(
    materializer,
    '"create_doll_upload_intent"',
    "parseCreatedUploadIntent(intent.data",
    "doll upload intent response is validated",
  );
  before(
    materializer,
    "parseCreatedUploadIntent(intent.data",
    ".exists(path)",
    "doll validated intent precedes response-loss reconciliation",
  );
  before(
    materializer,
    ".exists(path)",
    ".upload(path, uploadBytes",
    "existing deterministic object is checked before the one-shot write",
  );
  before(
    materializer,
    ".upload(path, uploadBytes",
    '"commit_generation_pick"',
    "the confirmed deterministic object precedes the DB commit",
  );
  assert.match(materializer, /resolveUploadIntentMutation\(\(\) =>/);
  assert.match(materializer, /upsert:\s*false/);
  assert.doesNotMatch(materializer, /removeBackground\(/);

  const body = source("app/api/doll/route.ts");
  before(
    body,
    '"request_doll_delete"',
    "processStorageObjectCleanupJob(",
    "persisted-doll deletion records the DB outbox before cleanup execution",
  );
  assert.doesNotMatch(body, /\.from\("dolls"\)[\s\S]*?\.delete\(/);
  assert.match(body, /"request_doll_role_update"/);
  assert.match(body, /if \(!isUuid\(id\)\)/);
  assert.match(body, /if \(!isUuid\(body\?\.id\)\)/);
});
