import assert from "node:assert/strict";
import test from "node:test";
import { eventExposure } from "../../lib/events/types.ts";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");

test("발행 글의 노출 수명주기는 목록/상세 쿼리와 같은 경계를 쓴다", () => {
  // starts_at 포함 — 정확히 시작 시각이면 이미 노출중.
  assert.equal(
    eventExposure(
      { status: "published", starts_at: "2026-08-01T00:00:00.000Z", ends_at: null },
      NOW,
    ),
    "live",
  );
  assert.equal(
    eventExposure(
      { status: "published", starts_at: "2026-08-01T00:00:00.001Z", ends_at: null },
      NOW,
    ),
    "scheduled",
  );
  // ends_at 배타 — 정확히 종료 시각이면 이미 종료.
  assert.equal(
    eventExposure(
      { status: "published", starts_at: null, ends_at: "2026-08-01T00:00:00.000Z" },
      NOW,
    ),
    "ended",
  );
  assert.equal(
    eventExposure(
      { status: "published", starts_at: null, ends_at: "2026-08-01T00:00:00.001Z" },
      NOW,
    ),
    "live",
  );
  // 무기한(윈도우 없음) = 노출중.
  assert.equal(
    eventExposure({ status: "published", starts_at: null, ends_at: null }, NOW),
    "live",
  );
  // 초안은 수명주기 없음.
  assert.equal(
    eventExposure({ status: "draft", starts_at: null, ends_at: null }, NOW),
    null,
  );
});
