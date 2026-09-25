// 공지 배너 서버 HTML(v1.62) — 활성 배너를 서버 HTML 에 실어 하이드레이션 뒤 끼어들며 본문을 밀던 것을 없앤다.
// 원칙: 서버 HTML 첫 상태만 캐시(태그 events + 1시간), 활성 배너 API 는 종전대로 캐시 없는 한 번의 DB 스냅샷, 브라우저가 이어서 경계를 맞춘다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { EMPTY_EVENT_BANNER_SNAPSHOT, isBannerSnapshotStale } = await import("../../lib/events/banner-snapshot.ts");

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("스냅샷 경계: 경계 시각이 지나면(같은 시각 포함) 낡음, 경계 없음 · 읽을 수 없는 시각은 낡지 않음", () => {
  const snap = { nextTransitionAt: "2026-10-01T00:00:00.000Z" };
  assert.equal(isBannerSnapshotStale(snap, "2026-09-30T23:59:59.999Z"), false);
  assert.equal(isBannerSnapshotStale(snap, "2026-10-01T00:00:00.000Z"), true);
  assert.equal(isBannerSnapshotStale(snap, "2026-10-01T09:00:00.000Z"), true);
  assert.equal(isBannerSnapshotStale({ nextTransitionAt: null }, "2026-10-01T09:00:00.000Z"), false);
  assert.equal(isBannerSnapshotStale(snap, "not-a-date"), false);
  assert.deepEqual(EMPTY_EVENT_BANNER_SNAPSHOT, { banners: { home: null, gallery: null, leaderboard: null }, nextTransitionAt: null });
});

test("서버 캐시: 태그 events + 1시간 backstop, 실패는 캐시 없이 빈 스냅샷, 경계 지나면 즉시 만료(expire 0) — 팝업은 싣지 않는다", () => {
  const s = source("lib/events/banner-snapshot-server.ts");
  assert.match(s, /^import "server-only";/);
  assert.match(s, /export const EVENTS_CACHE_TAG = "events";/);
  assert.match(s, /\{ tags: \[EVENTS_CACHE_TAG\], revalidate: 3600 \}/);
  assert.match(s, /return \{ banners: snapshot\.banners, nextTransitionAt: snapshot\.nextTransitionAt \};/);
  assert.doesNotMatch(s, /popup/);
  assert.match(s, /catch \(error\) \{\s*log\.warn\("events\.banner_snapshot_fail", errInfo\(error\)\);\s*return EMPTY_EVENT_BANNER_SNAPSHOT;/);
  assert.match(s, /if \(isBannerSnapshotStale\(cached, nowIso\)\) \{\s*revalidateTag\(EVENTS_CACHE_TAG, \{ expire: 0 \}\);/);
  // 활성 배너 API 경로(lib/events)는 캐시를 쓰지 않는다 — 경계를 캐시 TTL 로 양자화하지 않는 원칙
  assert.doesNotMatch(source("lib/events/index.ts"), /unstable_cache|revalidateTag/);
});

test("루트 레이아웃이 스냅샷을 읽어 EventBannersProvider 로 내려 주고, 훅은 그 배너를 첫 상태로 쓴다(팝업은 비움)", () => {
  const layout = source("app/layout.tsx");
  assert.match(layout, /getEventBannerSnapshot\(\),\s*\]\);/);
  assert.match(layout, /<EventBannersProvider value=\{eventBanners\}>/);
  assert.match(layout, /import \{ getEventBannerSnapshot \} from "@\/lib\/events\/banner-snapshot-server";/);
  const hook = source("components/events/useActiveEvents.ts");
  assert.match(hook, /const initialBanners = useInitialEventBanners\(\)\.banners;/);
  assert.match(hook, /useState<ActiveEvents>\(\(\) => \(\{ \.\.\.EMPTY, banners: initialBanners \}\)\)/);
  assert.match(hook, /popup: null,/);
  // 경계에서는 종전처럼 먼저 숨긴 뒤 다시 조회
  assert.match(hook, /setState\(EMPTY\)/);
});

test("활성 배너 API: 응답은 캐시 없는 스냅샷 그대로, 부수로 낡은 서버 HTML 스냅샷을 재검증(실패해도 응답 유지)", () => {
  const route = source("app/api/events/active/route.ts");
  assert.match(route, /const snapshot = await getActiveEventSurfaces\(\);/);
  assert.match(
    route,
    /try \{\s*await revalidateStaleEventBannerSnapshot\(snapshot\.serverNow\);\s*\} catch \(error\) \{\s*log\.warn\("events\.banner_snapshot_revalidate_fail", errInfo\(error\)\);\s*\}/,
  );
  assert.match(route, /NextResponse\.json\(\s*snapshot,/);
  const admin = source("app/api/admin/events/route.ts");
  assert.match(admin, /revalidateTag\(EVENTS_CACHE_TAG, "max"\);/);
  assert.doesNotMatch(admin, /revalidateTag\("events"/);
});
