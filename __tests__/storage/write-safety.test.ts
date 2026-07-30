import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNED_UPLOAD_ATTACH_GRACE_MS,
  SIGNED_UPLOAD_VALID_MS,
  attemptUploadCleanup,
  imageContentTypeMatchesPath,
  isFreshSignedUpload,
  isOwnedAvatarUploadPath,
} from "../../lib/upload-write-safety.ts";

const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const UPLOAD_ID = "223e4567-e89b-42d3-a456-426614174001";

test("avatar upload path is canonical and traversal-safe", () => {
  assert.equal(
    isOwnedAvatarUploadPath(`${USER_ID}/${UPLOAD_ID}.webp`, USER_ID),
    true,
  );
  assert.equal(
    isOwnedAvatarUploadPath(`${USER_ID}/../${UPLOAD_ID}.webp`, USER_ID),
    false,
  );
  assert.equal(
    isOwnedAvatarUploadPath(`${USER_ID}/${UPLOAD_ID}.svg`, USER_ID),
    false,
  );
  assert.equal(
    isOwnedAvatarUploadPath(`${USER_ID}/not-a-uuid.jpg`, USER_ID),
    false,
  );
});

test("signed image metadata is bound to the exact safe path extension", () => {
  const allowed = ["png", "jpg", "webp"] as const;
  assert.equal(
    imageContentTypeMatchesPath("owner/photo.png", "image/png", allowed),
    true,
  );
  assert.equal(
    imageContentTypeMatchesPath(
      "owner/photo.jpg",
      "image/jpeg; charset=binary",
      allowed,
    ),
    true,
  );
  assert.equal(
    imageContentTypeMatchesPath("owner/photo.png", "image/webp", allowed),
    false,
  );
  assert.equal(
    imageContentTypeMatchesPath("owner/photo.png", "image/svg+xml", allowed),
    false,
  );
  assert.equal(
    imageContentTypeMatchesPath(
      "owner/photo.gif",
      "image/gif",
      allowed,
    ),
    false,
  );
  assert.equal(
    imageContentTypeMatchesPath(
      "owner/photo.gif",
      "image/gif",
      [...allowed, "gif"],
    ),
    true,
  );
});

test("signed upload age accepts exact lifetime+grace boundary only", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  assert.equal(isFreshSignedUpload(new Date(now).toISOString(), now), true);
  assert.equal(
    isFreshSignedUpload(
      new Date(now - SIGNED_UPLOAD_VALID_MS - SIGNED_UPLOAD_ATTACH_GRACE_MS).toISOString(),
      now,
    ),
    true,
  );
  assert.equal(
    isFreshSignedUpload(
      new Date(
        now - SIGNED_UPLOAD_VALID_MS - SIGNED_UPLOAD_ATTACH_GRACE_MS - 1,
      ).toISOString(),
      now,
    ),
    false,
  );
  assert.equal(
    isFreshSignedUpload(
      new Date(now + SIGNED_UPLOAD_ATTACH_GRACE_MS + 1).toISOString(),
      now,
    ),
    false,
  );
  assert.equal(isFreshSignedUpload("not-a-date", now), false);
});

test("upload cleanup exposes resolved and thrown Storage failures", async () => {
  const resolved = new Error("resolved remove failure");
  const resolvedResult = await attemptUploadCleanup(
    "upload.cleanup",
    ["a"],
    async () => ({ data: null, error: resolved }),
    async () => ({ data: false, error: null }),
  );
  assert.equal(resolvedResult.ok, false);
  if (!resolvedResult.ok) {
    assert.equal(
      (resolvedResult.error as { operation?: unknown }).operation,
      "upload.cleanup",
    );
    assert.equal(
      (resolvedResult.error as { operationError?: unknown }).operationError,
      resolved,
    );
  }

  const thrown = new Error("thrown remove failure");
  const thrownResult = await attemptUploadCleanup(
    "upload.cleanup",
    ["a"],
    async () => {
      throw thrown;
    },
    async () => ({ data: false, error: null }),
  );
  assert.equal(thrownResult.ok, false);
  if (!thrownResult.ok) {
    assert.equal(
      (thrownResult.error as { operationError?: unknown }).operationError,
      thrown,
    );
  }
});
