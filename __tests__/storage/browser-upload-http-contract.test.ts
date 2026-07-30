import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAvatarClearHttpAck,
  parseAvatarReplaceHttpAck,
  parseAvatarUploadInitAck,
} from "../../lib/avatar-http-contract.ts";
import {
  parseHighlightMutationHttpAck,
  parseHighlightUploadInitAck,
} from "../../lib/highlight-http-contract.ts";
import { videoContentTypeMatchesPath } from "../../lib/upload-write-safety.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_ID = "22222222-2222-4222-8222-222222222222";
const SCORE_ID = "33333333-3333-4333-8333-333333333333";
const STORAGE_URL = "https://project.supabase.co";

test("avatar upload initialization binds the canonical path to the requested MIME", () => {
  const value = {
    path: `${USER_ID}/${OBJECT_ID}.jpg`,
    ext: "jpg",
    token: "opaque-token",
  };
  assert.deepEqual(parseAvatarUploadInitAck(value, "image/jpeg"), value);
  assert.deepEqual(
    parseAvatarUploadInitAck(value, "image/jpeg; charset=binary"),
    value,
  );
  for (const malformed of [
    null,
    { ...value, ext: "png" },
    { ...value, path: `${USER_ID}/../${OBJECT_ID}.jpg` },
    { ...value, path: `${USER_ID}/${OBJECT_ID}.png` },
    { ...value, token: "" },
    { ...value, error: "late_failure" },
  ]) {
    assert.equal(
      parseAvatarUploadInitAck(malformed, "image/jpeg"),
      null,
    );
  }
  assert.equal(parseAvatarUploadInitAck(value, "image/jpegx"), null);
});

test("avatar replace requires an exact committed or durable-pending receipt and bucket URL", () => {
  const path = `${USER_ID}/${OBJECT_ID}.jpg`;
  const avatarUrl =
    `${STORAGE_URL}/storage/v1/object/public/avatars/${path}`;
  assert.deepEqual(
    parseAvatarReplaceHttpAck(
      { ok: true, avatarUrl },
      { path, storageUrl: STORAGE_URL },
    ),
    { ok: true, avatarUrl, cleanup: "completed" },
  );
  assert.deepEqual(
    parseAvatarReplaceHttpAck(
      { accepted: true, avatarUrl, cleanup: "pending" },
      { path, storageUrl: STORAGE_URL },
    ),
    { accepted: true, avatarUrl, cleanup: "pending" },
  );
  for (const malformed of [
    null,
    { ok: true },
    { ok: true, avatarUrl, error: "late_failure" },
    { accepted: true, avatarUrl, cleanup: "completed" },
    {
      ok: true,
      avatarUrl: `https://evil.example/storage/v1/object/public/avatars/${path}`,
    },
    {
      ok: true,
      avatarUrl:
        `${STORAGE_URL}/storage/v1/object/public/dolls/${path}`,
    },
    {
      ok: true,
      avatarUrl:
        `${STORAGE_URL}/storage/v1/object/public/avatars/${path}?download=1`,
    },
  ]) {
    assert.equal(
      parseAvatarReplaceHttpAck(malformed, {
        path,
        storageUrl: STORAGE_URL,
      }),
      null,
    );
  }
});

test("avatar clear accepts only completed or durable-pending exact receipts", () => {
  assert.deepEqual(
    parseAvatarClearHttpAck({ ok: true, cleanup: "completed" }),
    { ok: true, cleanup: "completed" },
  );
  assert.deepEqual(
    parseAvatarClearHttpAck({ accepted: true, cleanup: "pending" }),
    { accepted: true, cleanup: "pending" },
  );
  for (const malformed of [
    null,
    { ok: true },
    { ok: true, cleanup: "pending" },
    { accepted: true, cleanup: "completed" },
    { accepted: true, cleanup: "pending", error: "late_failure" },
  ]) {
    assert.equal(parseAvatarClearHttpAck(malformed), null);
  }
});

test("highlight upload initialization binds score, upload UUID, MIME, path, and token", () => {
  const value = {
    uploadId: OBJECT_ID,
    ext: "webm",
    path: `${SCORE_ID}/${OBJECT_ID}.webm`,
    token: "opaque-token",
  };
  assert.deepEqual(
    parseHighlightUploadInitAck(value, {
      scoreId: SCORE_ID,
      mime: "video/webm",
    }),
    value,
  );
  for (const malformed of [
    null,
    { ...value, ext: "mp4" },
    { ...value, path: `${USER_ID}/${OBJECT_ID}.webm` },
    { ...value, path: `${SCORE_ID}/../${OBJECT_ID}.webm` },
    { ...value, token: " " },
    { ...value, error: "late_failure" },
  ]) {
    assert.equal(
      parseHighlightUploadInitAck(malformed, {
        scoreId: SCORE_ID,
        mime: "video/webm",
      }),
      null,
    );
  }
  assert.equal(
    parseHighlightUploadInitAck(value, {
      scoreId: SCORE_ID,
      mime: "video/webmevil",
    }),
    null,
  );
});

test("highlight mutation requires an exact first-commit or response-loss receipt", () => {
  assert.deepEqual(parseHighlightMutationHttpAck({ ok: true }), {
    ok: true,
    alreadyAttached: false,
  });
  assert.deepEqual(
    parseHighlightMutationHttpAck({
      ok: true,
      alreadyAttached: true,
    }),
    { ok: true, alreadyAttached: true },
  );
  for (const malformed of [
    null,
    {},
    { ok: false },
    { ok: true, alreadyAttached: false },
    { ok: true, error: "late_failure" },
  ]) {
    assert.equal(parseHighlightMutationHttpAck(malformed), null);
  }
});

test("public highlight MIME is exactly bound to the signed path extension", () => {
  assert.equal(
    videoContentTypeMatchesPath("score/clip.mp4", "video/mp4", [
      "mp4",
      "webm",
    ]),
    true,
  );
  assert.equal(
    videoContentTypeMatchesPath(
      "score/clip.webm",
      "video/webm; codecs=vp9",
      ["mp4", "webm"],
    ),
    true,
  );
  for (const [path, mime] of [
    ["score/clip.mp4", "text/mp4"],
    ["score/clip.mp4", "video/mp4evil"],
    ["score/clip.webm", "video/mp4"],
    ["score/clip.exe", "video/mp4"],
  ]) {
    assert.equal(
      videoContentTypeMatchesPath(path, mime, ["mp4", "webm"]),
      false,
    );
  }
});

test("avatar and highlight clients reject malformed 2xx acknowledgements", () => {
  const avatar = readFileSync(
    new URL("../../lib/avatar.ts", import.meta.url),
    "utf8",
  );
  assert.match(avatar, /parseAvatarUploadInitAck\(/);
  assert.match(avatar, /parseAvatarReplaceHttpAck\(/);
  assert.match(avatar, /parseAvatarClearHttpAck\(/);
  assert.doesNotMatch(avatar, /const \{ path, token \} = .*\\.json/);

  const share = readFileSync(
    new URL("../../lib/share.ts", import.meta.url),
    "utf8",
  );
  assert.match(share, /parseHighlightUploadInitAck\(/);
  assert.equal(
    (share.match(/parseHighlightMutationHttpAck\(/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(share, /return patch\\.ok \\?/);
  assert.doesNotMatch(share, /return r\\.ok \\? "card"/);
});

test("card highlight response-loss retry postreads the exact existing receipt", () => {
  const route = readFileSync(
    new URL("../../app/api/highlight/route.ts", import.meta.url),
    "utf8",
  );
  const card = route.slice(
    route.indexOf('if (mode === "card")'),
    route.indexOf("// ── clip 모드"),
  );
  assert.match(card, /insErr\.code === "23505"/);
  assert.match(
    card,
    /highlight_status === "card"[\s\S]*?highlight_delta === meta\.delta[\s\S]*?highlight_window_ms === meta\.windowMs/,
  );
  assert.match(card, /alreadyAttached: true/);
});
