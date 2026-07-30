import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAdminUploadConfirmAck,
  parseAdminUploadInitAck,
} from "../../lib/admin-upload-http-contract.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("admin upload initialization binds token, extension, surface, and slot", () => {
  const event = { path: `202607/${ID}.gif`, ext: "gif", token: "opaque" };
  const site = {
    path: `logo/202607/${ID}.webp`,
    ext: "webp",
    token: "opaque",
  };
  assert.deepEqual(
    parseAdminUploadInitAck(event, { surface: "event" }),
    event,
  );
  assert.deepEqual(
    parseAdminUploadInitAck(site, { surface: "site", slot: "logo" }),
    site,
  );
  for (const malformed of [
    null,
    { ...event, ext: "png" },
    { ...event, token: "" },
    { ...event, error: "late_failure" },
  ]) {
    assert.equal(
      parseAdminUploadInitAck(malformed, { surface: "event" }),
      null,
    );
  }
  assert.equal(
    parseAdminUploadInitAck(site, { surface: "site", slot: "og" }),
    null,
  );
  assert.equal(
    parseAdminUploadInitAck(event, { surface: "site", slot: "logo" }),
    null,
  );
});

test("admin upload confirmation requires the exact path and bucket URL", () => {
  const path = `202607/${ID}.png`;
  const value = {
    ok: true,
    path,
    url: `https://project.supabase.co/storage/v1/object/public/events/${path}`,
  };
  assert.deepEqual(
    parseAdminUploadConfirmAck(value, {
      path,
      bucket: "events",
      urlField: "url",
      storageUrl: "https://project.supabase.co",
    }),
    value,
  );
  for (const malformed of [
    null,
    { ...value, path: `202607/${ID}.jpg` },
    { ...value, url: `https://evil.example/events/${path}` },
    {
      ...value,
      url: `https://project.supabase.co/storage/v1/object/public/site-assets/${path}`,
    },
    { ...value, error: "late_failure" },
  ]) {
    assert.equal(
      parseAdminUploadConfirmAck(malformed, {
        path,
        bucket: "events",
        urlField: "url",
        storageUrl: "https://project.supabase.co",
      }),
      null,
    );
  }
});

test("both admin image clients validate each 2xx upload stage", () => {
  for (const relative of [
    "components/admin/EventEditor.tsx",
    "components/admin/content/MediaConfigEditor.tsx",
  ]) {
    const source = readFileSync(
      new URL(`../../${relative}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /parseAdminUploadInitAck\(/);
    assert.match(source, /parseAdminUploadConfirmAck\(/);
    assert.match(source, /stableClientUploadOperation\(/);
    assert.match(source, /requestId:\s*operation\.requestId/);
    assert.match(source, /month:\s*operation\.month/);
    assert.match(source, /clearClientUploadOperation\(/);
    assert.doesNotMatch(source, /!r1\.ok \|\| !d1\.path \|\| !d1\.token/);
    assert.doesNotMatch(source, /!r2\.ok \|\| !d2\.path/);
  }
});
