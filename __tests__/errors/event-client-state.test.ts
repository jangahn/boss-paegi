import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("event popup visibility and dismissal choice are scoped to one popup id", () => {
  const popup = source("components/events/EventPopup.tsx");
  assert.match(popup, /visiblePopupId === popup\.id/);
  assert.match(popup, /dontShowChoice\?\.popupId === popup\.id/);
  assert.match(popup, /popupId: popup\.id/);
  assert.doesNotMatch(popup, /const \[dontShow, setDontShow\]/);
});

test("event refreshes use one expiring cache and reject stale generations", () => {
  const hook = source("components/events/useActiveEvents.ts");
  assert.match(
    hook,
    /ACTIVE_EVENTS_CACHE_TTL_MS =\s*ACTIVE_EVENTS_FALLBACK_TTL_MS/,
  );
  assert.match(hook, /createExpiringSharedRequest/);
  assert.match(
    hook,
    /now: activeEventsMonotonicNow/,
  );
  assert.match(
    hook,
    /expiresAt: \(value\) => value\.cacheUntilMonotonic/,
  );
  assert.match(hook, /activeEventsRequest\.subscribe/);
  assert.match(hook, /setState\(EMPTY\)/);
  assert.match(hook, /activeEventsRequest\.refresh\(\)/);
  assert.match(hook, /requestEpochRef\.current \+= 1/);
  assert.ok(
    (hook.match(/requestEpochRef\.current === requestEpoch/g) ?? []).length >=
      3,
  );
});

test("focus and visible-tab recovery share the cache expiry check", () => {
  const hook = source("components/events/useActiveEvents.ts");
  assert.match(hook, /window\.addEventListener\("focus", refreshIfExpired\)/);
  assert.match(
    hook,
    /document\.addEventListener\("visibilitychange", onVisibilityChange\)/,
  );
  assert.match(
    hook,
    /document\.visibilityState === "visible"/,
  );
  assert.ok(
    (hook.match(/activeEventsRequest\.refreshIfExpired\(\)/g) ?? []).length >=
      1,
  );
});
