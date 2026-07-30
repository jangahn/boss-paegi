import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ACTIVE_EVENTS_FALLBACK_TTL_MS,
  ACTIVE_EVENTS_MAX_RESPONSE_BYTES,
  ACTIVE_EVENTS_MAX_STALE_RESPONSE_ATTEMPTS,
  ActiveEventsResponseError,
  activeEventsCacheForMs,
  fetchActiveEvents,
  parseActiveEventsResponse,
  type ActiveEvents,
} from "../../lib/active-events-response.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const VALID = {
  serverNow: "2026-07-30T00:00:00.000Z",
  nextTransitionAt: "2026-07-30T00:00:01.000Z",
  popup: {
    id: ID,
    type: "notice",
    title: "점검 안내",
    summary: "오늘 점검이 있어요.",
    popupDismissDays: 7,
  },
  banners: {
    home: { id: ID, type: "notice", summary: "홈 공지" },
    gallery: null,
    leaderboard: { id: ID, type: "event", summary: "랭킹 이벤트" },
  },
} satisfies ActiveEvents;

test("active events response accepts only the exact public DTO", () => {
  assert.deepEqual(parseActiveEventsResponse(VALID), VALID);
  for (const value of [
    null,
    {},
    { ...VALID, extra: true },
    { ...VALID, serverNow: "2026-02-30T00:00:00.000Z" },
    { ...VALID, nextTransitionAt: VALID.serverNow },
    { ...VALID, nextTransitionAt: "2026-07-30T00:00:00Z" },
    { ...VALID, popup: { ...VALID.popup, id: "invalid" } },
    { ...VALID, popup: { ...VALID.popup, popupDismissDays: 0 } },
    { ...VALID, popup: { ...VALID.popup, title: " padded " } },
    {
      ...VALID,
      banners: { home: null, gallery: null },
    },
    {
      ...VALID,
      banners: {
        ...VALID.banners,
        home: { ...VALID.banners.home, type: "unknown" },
      },
    },
    {
      ...VALID,
      banners: {
        ...VALID.banners,
        home: { ...VALID.banners.home, extra: true },
      },
    },
  ]) {
    assert.equal(parseActiveEventsResponse(value), null);
  }
});

test("active events HTTP, JSON, shape, and transport failures never become an empty success", async () => {
  const fetched = await fetchActiveEvents(async () =>
      new Response(JSON.stringify(VALID), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  assert.deepEqual(
    {
      serverNow: fetched.serverNow,
      nextTransitionAt: fetched.nextTransitionAt,
      popup: fetched.popup,
      banners: fetched.banners,
    },
    VALID,
  );
  assert.ok(fetched.cacheForMs >= 1 && fetched.cacheForMs <= 1_000);

  await assert.rejects(
    () =>
      fetchActiveEvents(async () =>
        new Response("unavailable", { status: 503 }),
      ),
    (error: unknown) =>
      error instanceof ActiveEventsResponseError &&
      error.kind === "http" &&
      error.status === 503,
  );
  await assert.rejects(
    () =>
      fetchActiveEvents(async () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    SyntaxError,
  );
  await assert.rejects(
    () =>
      fetchActiveEvents(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ActiveEventsResponseError,
  );
  await assert.rejects(
    () =>
      fetchActiveEvents(async () => {
        throw new Error("transport unavailable");
      }),
    /transport unavailable/,
  );

  await assert.rejects(
    () =>
      fetchActiveEvents(async () =>
        new Response(JSON.stringify(VALID), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    ActiveEventsResponseError,
  );
  await assert.rejects(
    () =>
      fetchActiveEvents(async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(ACTIVE_EVENTS_MAX_RESPONSE_BYTES + 1),
          },
        }),
      ),
    ActiveEventsResponseError,
  );
});

test("authoritative transition lifetime closes the inclusive/exclusive boundary at one millisecond", () => {
  assert.equal(activeEventsCacheForMs(VALID, 0), 1_000);
  assert.equal(activeEventsCacheForMs(VALID, 999), 1);
  assert.equal(activeEventsCacheForMs(VALID, 1_000), null);
  assert.equal(activeEventsCacheForMs(VALID, 1_001), null);
  assert.equal(
    activeEventsCacheForMs({ ...VALID, nextTransitionAt: null }, 12_345),
    ACTIVE_EVENTS_FALLBACK_TTL_MS,
  );
  assert.throws(
    () => activeEventsCacheForMs(VALID, Number.NaN),
    /invalid_active_events_round_trip/,
  );

  const start = Date.parse("2026-07-30T00:00:01.000Z");
  const end = Date.parse("2026-07-30T00:00:02.000Z");
  const activeAt = (instant: number) =>
    start <= instant && end > instant;
  assert.equal(activeAt(start - 1), false);
  assert.equal(activeAt(start), true);
  assert.equal(activeAt(end - 1), true);
  assert.equal(activeAt(end), false);
});

test("a snapshot whose transition passed in flight is retried and never rendered", async () => {
  let calls = 0;
  const responses = async () => {
    calls += 1;
    return new Response(JSON.stringify(VALID), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const retryClockValues = [0, 1_000, 1_000, 1_999];
  const recovered = await fetchActiveEvents(
    responses,
    undefined,
    () => retryClockValues.shift() ?? Number.NaN,
  );
  assert.equal(calls, 2);
  assert.equal(recovered.cacheForMs, 1);
  assert.equal(recovered.cacheUntilMonotonic, 2_000);

  calls = 0;
  let monotonic = 0;
  await assert.rejects(
    () =>
      fetchActiveEvents(
        responses,
        undefined,
        () => {
          const value = monotonic;
          monotonic += 1_000;
          return value;
        },
      ),
    (error: unknown) =>
      error instanceof ActiveEventsResponseError &&
      error.kind === "stale_response",
  );
  assert.equal(calls, ACTIVE_EVENTS_MAX_STALE_RESPONSE_ATTEMPTS);
});

test("active event fetch forwards abort and explicit no-store policy", async () => {
  const controller = new AbortController();
  let init: RequestInit | undefined;
  const pending = fetchActiveEvents(
    async (_input, requestInit) => {
      init = requestInit;
      return new Promise<Response>((_resolve, reject) => {
        requestInit?.signal?.addEventListener(
          "abort",
          () => reject(requestInit.signal?.reason),
          { once: true },
        );
      });
    },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort(new Error("active_events_cancelled"));
  await assert.rejects(pending, /active_events_cancelled/);
  assert.equal(init?.signal, controller.signal);
  assert.equal(init?.cache, "no-store");
});

test("client hook exposes explicit error and retry states", () => {
  const hook = readFileSync(
    new URL(
      "../../components/events/useActiveEvents.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(hook, /\.catch\(\(\) => EMPTY\)/);
  assert.match(hook, /createExpiringSharedRequest/);
  assert.match(hook, /setError\(true\)/);
  assert.match(hook, /const retry = useCallback/);

  const banner = readFileSync(
    new URL("../../components/events/EventBanner.tsx", import.meta.url),
    "utf8",
  );
  assert.match(banner, /if \(error\)/);
  assert.match(banner, /role="alert"/);
  assert.match(banner, /onClick=\{retry\}/);
});

test("scheduled active-event boundaries cannot inherit stale edge responses", () => {
  const route = readFileSync(
    new URL("../../app/api/events/active/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /"Vercel-CDN-Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /stale-while-revalidate/);
  assert.match(route, /NextResponse\.json\(\s*snapshot,/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /export const maxDuration = 20/);

  const events = readFileSync(
    new URL("../../lib/events/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(events, /unstable_cache|nowBucket|bucketIso/);
  assert.match(events, /\.or\(`starts_at\.is\.null,starts_at\.lte\.\$\{now\}`\)/);
  assert.match(events, /\.or\(`ends_at\.is\.null,ends_at\.gt\.\$\{now\}`\)/);
  const activeSection = events.slice(
    events.indexOf("// ── 팝업/배너 원자 snapshot"),
    events.indexOf("// ── sitemap"),
  );
  assert.equal(
    (activeSection.match(/\.rpc\("get_active_event_surfaces"\)/g) ?? [])
      .length,
    1,
  );
  assert.doesNotMatch(
    activeSection,
    /\.from\("events"\)|Promise\.all|readActiveEvent|readNextActiveTransition/,
  );
  assert.match(activeSection, /ACTIVE_EVENT_SNAPSHOT_ATTEMPTS = 3/);
  assert.match(
    activeSection,
    /activeEventsCacheForMs\(snapshot, elapsedMs\) === null/,
  );
  assert.match(activeSection, /AbortSignal\.timeout/);

  assert.match(
    route,
    /const snapshot = await getActiveEventSurfaces\(\)/,
  );
  assert.doesNotMatch(route, /Promise\.all/);

  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008907_atomic_active_event_snapshot.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /create or replace function public\.get_active_event_surfaces\(\)[\s\S]*?language sql\s+stable\s+security definer\s+set search_path = pg_catalog, public/,
  );
  assert.match(migration, /eligible as materialized/);
  assert.match(migration, /active_candidates as materialized/);
  assert.match(migration, /e\.starts_at <= b\.server_now/);
  assert.match(migration, /e\.ends_at > b\.server_now/);
  assert.match(migration, /e\.priority desc,[\s\S]*?e\.id desc/);
  assert.match(migration, /pg_catalog\.pg_column_size\(r\.payload\) <= 8192/);
  assert.match(
    migration,
    /revoke all on function public\.get_active_event_surfaces\(\)[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute on function public\.get_active_event_surfaces\(\)[\s\S]*?to service_role;/,
  );
});

test("news list, detail, and sitemap use uncached exact wall-clock windows", () => {
  const events = readFileSync(
    new URL("../../lib/events/index.ts", import.meta.url),
    "utf8",
  );
  for (const [startMarker, endMarker] of [
    ["export async function getPublishedEvents", "// ── 공개 단건"],
    ["export async function getEventById", "// ── 팝업/배너"],
    ["export async function getSitemapEvents", "// ── 어드민"],
  ] as const) {
    const section = events.slice(
      events.indexOf(startMarker),
      events.indexOf(endMarker),
    );
    assert.match(section, /const now = new Date\(\)\.toISOString\(\)/);
    assert.match(
      section,
      /\.or\(`starts_at\.is\.null,starts_at\.lte\.\$\{now\}`\)/,
    );
    assert.match(
      section,
      /\.or\(`ends_at\.is\.null,ends_at\.gt\.\$\{now\}`\)/,
    );
    assert.doesNotMatch(section, /unstable_cache|nowBucket|bucketIso/);
  }

  for (const path of [
    "../../app/news/page.tsx",
    "../../app/news/[id]/page.tsx",
    "../../app/sitemap.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /export const dynamic = "force-dynamic"/);
  }
});
