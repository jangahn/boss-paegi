// build-cache-config.test.ts — Turbopack 빌드 파일 캐시는 꺼 둔다(v1.52): 캐시가 복원된 빌드가 낡은 CSS 를 내보낸 프로드 사고(2026-09-21) 재발 방지.
//   캐시 없는 빌드(CI)는 항상 정상이라 동작 테스트로는 잡을 수 없다 — 설정과 그 근거 주석을 고정한다.
//   실행: node --experimental-strip-types --test __tests__/qa/build-cache-config.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("next.config: turbopackFileSystemCacheForBuild 는 false — 다시 켜려면 v1.50→v1.51 순서 빌드로 CSS 가 새로 나오는지 먼저 확인", () => {
  const config = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /experimental: \{[\s\S]*?turbopackFileSystemCacheForBuild: false,\s*\},/);
  assert.match(config, /낡은 CSS 가 배포되는 사고 방지/);
  assert.doesNotMatch(config, /turbopackFileSystemCacheForBuild: true/);
});
