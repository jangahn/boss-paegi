import assert from "node:assert/strict";
import test from "node:test";
import { parseLegacyUploadOrphanSweep } from "../../lib/legacy-upload-orphan-sweep.ts";

test("legacy upload sweep accepts only an exact correlated acknowledgement", () => {
  assert.deepEqual(
    parseLegacyUploadOrphanSweep(
      {
        ok: true,
        enabled: true,
        examined: 10,
        enqueued: 7,
        protected: 3,
      },
      10,
    ),
    {
      enabled: true,
      examined: 10,
      enqueued: 7,
      protected: 3,
    },
  );
  assert.deepEqual(
    parseLegacyUploadOrphanSweep(
      {
        ok: true,
        enabled: false,
        examined: 0,
        enqueued: 0,
        protected: 0,
      },
      10,
    ),
    {
      enabled: false,
      examined: 0,
      enqueued: 0,
      protected: 0,
    },
  );
});

test("legacy upload sweep rejects malformed, impossible, and false-green results", () => {
  for (const value of [
    null,
    {},
    {
      ok: false,
      enabled: true,
      examined: 1,
      enqueued: 1,
      protected: 0,
    },
    {
      ok: true,
      enabled: "true",
      examined: 1,
      enqueued: 1,
      protected: 0,
    },
    {
      ok: true,
      enabled: true,
      examined: 11,
      enqueued: 11,
      protected: 0,
    },
    {
      ok: true,
      enabled: true,
      examined: 1,
      enqueued: 2,
      protected: 0,
    },
    {
      ok: true,
      enabled: true,
      examined: 1,
      enqueued: 1,
      protected: 1,
    },
    {
      ok: true,
      enabled: false,
      examined: 1,
      enqueued: 0,
      protected: 1,
    },
    {
      ok: true,
      enabled: true,
      examined: 1,
      enqueued: 1,
      protected: 0,
      extra: true,
    },
  ]) {
    assert.equal(parseLegacyUploadOrphanSweep(value, 10), null);
  }
});
