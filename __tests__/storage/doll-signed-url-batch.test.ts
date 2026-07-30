import test from "node:test";
import assert from "node:assert/strict";
import { signDollPaths } from "../../lib/doll-signed-url-batch.ts";
import {
  InvalidDollSignedUrlResponseError,
  parseDollSignedUrlResponse,
} from "../../lib/doll-signed-url-response.ts";
import {
  galleryCursorFilter,
  mergeUniqueGalleryRows,
  nextGalleryCursor,
  parseGalleryDollRows,
} from "../../lib/gallery-pagination.ts";
import { readFileSync } from "node:fs";

test("batch doll signing maps every unique path", async () => {
  const result = await signDollPaths({
    paths: ["a.png", "a.png", "b.png"],
    thumb: false,
    signOne: async () => ({ data: null, error: null }),
    signMany: async (paths) => ({
      data: paths.map((path) => ({
        path,
        signedUrl: `signed:${path}`,
        error: null,
      })),
      error: null,
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual([...result.byPath], [
      ["a.png", "signed:a.png"],
      ["b.png", "signed:b.png"],
    ]);
  }
});

test("batch doll signing fails closed on resolved error or partial response", async () => {
  const resolved = new Error("storage unavailable");
  const errorResult = await signDollPaths({
    paths: ["a.png", "b.png"],
    thumb: false,
    signOne: async () => ({ data: null, error: null }),
    signMany: async () => ({ data: null, error: resolved }),
  });
  assert.deepEqual(errorResult, {
    ok: false,
    error: resolved,
    failedPaths: ["a.png", "b.png"],
  });

  const partial = await signDollPaths({
    paths: ["a.png", "b.png"],
    thumb: false,
    signOne: async () => ({ data: null, error: null }),
    signMany: async () => ({
      data: [{ path: "a.png", signedUrl: "signed:a.png", error: null }],
      error: null,
    }),
  });
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.deepEqual(partial.failedPaths, ["b.png"]);
});

test("thumbnail doll signing fails closed if any per-path call fails", async () => {
  const resolved = new Error("thumb failed");
  const result = await signDollPaths({
    paths: ["a.png", "b.png"],
    thumb: true,
    signOne: async (path) =>
      path === "a.png"
        ? { data: { signedUrl: "signed:a.png" }, error: null }
        : { data: null, error: resolved },
    signMany: async () => ({ data: [], error: null }),
  });
  assert.deepEqual(result, {
    ok: false,
    error: resolved,
    failedPaths: ["b.png"],
  });
});

test("gallery signed-url acknowledgement exactly partitions signed and deleted-race ids", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const removed = "22222222-2222-4222-8222-222222222222";
  const parsed = parseDollSignedUrlResponse(
    [first, removed],
    {
      urls: { [first]: "https://storage.example.test/signed" },
      missingIds: [removed],
    },
  );
  assert.deepEqual([...parsed.urls], [
    [first, "https://storage.example.test/signed"],
  ]);
  assert.deepEqual([...parsed.missingIds], [removed]);

  for (const malformed of [
    null,
    {},
    { urls: {}, missingIds: [] },
    {
      urls: { [first]: "https://storage.example.test/signed" },
      missingIds: [],
    },
    {
      urls: { [first]: "javascript:alert(1)" },
      missingIds: [removed],
    },
    {
      urls: { [first]: "https://storage.example.test/signed" },
      missingIds: [first, removed],
    },
    {
      urls: {
        [first]: "https://storage.example.test/signed",
        unknown: "https://storage.example.test/unknown",
      },
      missingIds: [removed],
    },
  ]) {
    assert.throws(
      () => parseDollSignedUrlResponse([first, removed], malformed),
      InvalidDollSignedUrlResponseError,
    );
  }
});

test("gallery never converts signing outages or malformed acks to the default boss image", () => {
  const gallery = readFileSync(
    new URL("../../app/gallery/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gallery, /if \(!r\.ok\)/);
  assert.match(gallery, /parseDollSignedUrlResponse/);
  assert.match(gallery, /\.filter\(\(d\) => !missingIds\.has\(d\.id\)\)/);
  assert.doesNotMatch(
    gallery,
    /signedUrlCache\.get\(d\.id\)\?\.url \?\? "\/sprites\/boss-default\.png"/,
  );
});

test("gallery continuation uses the raw page cursor even when a signing race removes a card", () => {
  const raw = Array.from({ length: 12 }, (_, index) => ({
    id: `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    image_url: `owner/${index}.png`,
    created_at: `2026-07-29T00:00:${(59 - index)
      .toString()
      .padStart(2, "0")}.123456+00:00`,
    role: "boss",
  }));
  const parsed = parseGalleryDollRows(raw);
  const rendered = parsed.filter((_, index) => index !== 5);
  const cursor = nextGalleryCursor(parsed, 12);

  assert.deepEqual(cursor, {
    createdAt: raw[11]!.created_at,
    id: raw[11]!.id,
  });
  assert.equal(rendered.length, 11);
  assert.equal(
    galleryCursorFilter(cursor!),
    `created_at.lt.${raw[11]!.created_at},and(created_at.eq.${raw[11]!.created_at},id.lt.${raw[11]!.id})`,
  );
});

test("gallery page merge is duplicate-safe under deletion and inter-page overlap", () => {
  const first = [
    { id: "a", value: 1 },
    { id: "b", value: 2 },
    { id: "c", value: 3 },
  ];
  // "b" was locally deleted while a stale next response overlaps "c".
  const afterDelete = first.filter((row) => row.id !== "b");
  const merged = mergeUniqueGalleryRows(afterDelete, [
    { id: "c", value: 30 },
    { id: "d", value: 4 },
  ]);
  assert.deepEqual(merged, [
    { id: "a", value: 1 },
    { id: "c", value: 3 },
    { id: "d", value: 4 },
  ]);
  assert.equal(new Set(merged.map((row) => row.id)).size, merged.length);
});

test("gallery page rows and cursor fail closed on malformed authority data", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const valid = {
    id,
    image_url: "owner/doll.png",
    created_at: "2026-07-29T00:00:00.123456+00:00",
    role: "boss",
  };
  for (const malformed of [
    null,
    [valid, valid],
    [{ ...valid, id: "not-a-uuid" }],
    [{ ...valid, created_at: "2026-07-29,or(id.not.is.null)" }],
    [{ ...valid, image_url: "" }],
    [{ ...valid, role: null }],
  ]) {
    assert.throws(() => parseGalleryDollRows(malformed));
  }
  assert.throws(() =>
    galleryCursorFilter({
      createdAt: "2026-07-29,or(id.not.is.null)",
      id,
    }),
  );
});

test("gallery source uses stable keyset pagination and never adjusts by rendered row count", () => {
  const gallery = readFileSync(
    new URL("../../app/gallery/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gallery, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(gallery, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(gallery, /\.or\(galleryCursorFilter\(cursor\)\)/);
  assert.match(gallery, /nextGalleryCursor\(rawRows, GALLERY_PAGE\)/);
  assert.match(gallery, /mergeUniqueGalleryRows\(prev, page\.rows\)/);
  assert.doesNotMatch(gallery, /offsetRef|\.range\(/);
});
