import test from "node:test";
import assert from "node:assert/strict";
import { removeModerationPurgeTargets } from "../../lib/moderation-purge.ts";

test("purge groups paths by bucket and deduplicates", async () => {
  const calls: Array<{ bucket: string; paths: string[] }> = [];
  const failed = await removeModerationPurgeTargets(
    [
      { bucket: "dolls", path: "owner/a" },
      { bucket: "dolls", path: "owner/a" },
      { bucket: "highlights", path: "score/b" },
    ],
    {
      remove: async (bucket, paths) => {
        calls.push({ bucket, paths });
        return {
          data: paths.map((name) => ({ name })),
          error: null,
        };
      },
      exists: async () => ({ data: false, error: null }),
    },
  );
  assert.deepEqual(failed, []);
  assert.deepEqual(calls, [
    { bucket: "dolls", paths: ["owner/a"] },
    { bucket: "highlights", paths: ["score/b"] },
  ]);
});

test("purge exposes resolved and thrown failures without skipping later buckets", async () => {
  const calls: string[] = [];
  const failed = await removeModerationPurgeTargets(
    [
      { bucket: "dolls", path: "owner/a" },
      { bucket: "highlights", path: "score/b" },
      { bucket: "avatars", path: "owner/c" },
    ],
    {
      remove: async (bucket) => {
        calls.push(bucket);
        if (bucket === "dolls") {
          return { data: null, error: new Error("resolved") };
        }
        if (bucket === "highlights") throw new Error("thrown");
        return { data: [{ name: "owner/c" }], error: null };
      },
      exists: async () => ({ data: false, error: null }),
    },
  );
  assert.deepEqual(calls, ["dolls", "highlights", "avatars"]);
  assert.deepEqual(failed, [
    { bucket: "dolls", path: "owner/a" },
    { bucket: "highlights", path: "score/b" },
  ]);
});
