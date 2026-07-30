import test from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_GENERATION_STATUS_FILTERS,
  deriveAdminGenerationStatus,
  deriveGenerationCreditNote,
  generationThumbnailMode,
} from "../../lib/character-gen/admin-generation-state.ts";

test("expired is an explicit admin status and filter", () => {
  assert.equal(deriveAdminGenerationStatus("expired", "expired"), "expired");
  assert.ok(ADMIN_GENERATION_STATUS_FILTERS.includes("expired"));
});

test("credit label follows exact consume/refund receipts, not failure inference", () => {
  const lotId = "11111111-1111-4111-8111-111111111111";
  assert.equal(deriveGenerationCreditNote(lotId, null), "consumed");
  assert.equal(
    deriveGenerationCreditNote(lotId, "2026-07-30T00:00:00.000Z"),
    "refunded",
  );
  assert.equal(deriveGenerationCreditNote(null, null), "none");
});

test("expired never receives signed candidate thumbnails", () => {
  assert.equal(generationThumbnailMode("expired"), "none");
  assert.equal(generationThumbnailMode("unpicked"), "candidates");
  assert.equal(generationThumbnailMode("picked"), "picked");
});

test("legacy and known statuses retain their prior admin mapping", () => {
  assert.equal(deriveAdminGenerationStatus("queued", null), "requested");
  assert.equal(deriveAdminGenerationStatus("done", null), "unpicked");
  assert.equal(deriveAdminGenerationStatus("picked", null), "picked");
  assert.equal(deriveAdminGenerationStatus("failed", "multiple_people"), "rejected");
  assert.equal(deriveAdminGenerationStatus("failed", "fal_error"), "failed");
  assert.equal(deriveAdminGenerationStatus("unknown", null), "requested");
});
