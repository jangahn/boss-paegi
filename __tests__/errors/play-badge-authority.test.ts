import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("in-game badge ownership failure disables the challenge and is visible", () => {
  const hook = readFileSync(
    new URL("../../app/play/useBadgeChallenge.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("../../app/play/page.tsx", import.meta.url),
    "utf8",
  );
  const component = readFileSync(
    new URL("../../components/play/BadgeChallenge.tsx", import.meta.url),
    "utf8",
  );

  assert.match(hook, /resolveOwnedBadgeRead\(result\)/);
  assert.match(hook, /loaded = false/);
  assert.match(hook, /setLoadError\("배지 도전을 불러오지 못했어요\."\)/);
  assert.doesNotMatch(hook, /data \?\? \[\]|빈 owned 로 진행/);
  assert.match(page, /error=\{badgeLoadError\}/);
  assert.match(component, /role="status"/);
});
