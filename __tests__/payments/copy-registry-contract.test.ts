// 고지 문구 registry 계약 — 코드 상수(원본)와 마이그레이션 seed 누적 상태의
// 정확 일치를 강제한다. 문구 상수만 바꾸고 `npm run gen:copy-registry-migration`
// 을 잊은 머지는 여기서 차단된다(0104 사고의 재발 방지 장치, 0105 계약).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// .mjs 생성기 모듈 — 상수→행 유도와 seed 마커 파싱 규칙의 단일 소스.
import {
  loadActiveCopyRows,
  replayRegistryState,
  renderSeedBlock,
} from "../../scripts/gen/copy-registry-migration.mjs";

const migrationsDir = path.resolve(
  import.meta.dirname,
  "../../supabase/migrations",
);

test("마이그레이션 registry 누적 상태 = 코드 상수(surface 별 active 정확 일치)", async () => {
  const state = replayRegistryState(migrationsDir) as Map<
    string,
    { copy: unknown; active: boolean }
  >;
  const activeBySurface = new Map<string, { version: string; copy: unknown }>();
  for (const [key, row] of state) {
    if (!row.active) continue;
    const [surface, version] = key.split(" ");
    assert.equal(
      activeBySurface.has(surface),
      false,
      `surface ${surface} 에 active 행이 둘 이상`,
    );
    activeBySurface.set(surface, { version, copy: row.copy });
  }

  const rows = (await loadActiveCopyRows()) as Array<{
    surface: string;
    copyVersion: string;
    copy: unknown;
  }>;
  assert.equal(rows.length, activeBySurface.size);
  for (const row of rows) {
    const seeded = activeBySurface.get(row.surface);
    assert.ok(seeded, `surface ${row.surface} 의 active seed 가 없음`);
    assert.equal(
      seeded!.version,
      row.copyVersion,
      `${row.surface}: 상수 copyVersion 이 registry seed 와 다름 — ` +
        "gen:copy-registry-migration 으로 seed 마이그레이션을 생성할 것",
    );
    assert.deepEqual(
      seeded!.copy,
      row.copy,
      `${row.surface}: 상수 문구가 registry seed 원문과 다름`,
    );
  }
});

test("seed 렌더 형식은 파서(replay)와 왕복 가능하다", () => {
  const rendered = renderSeedBlock(
    "credits_offer",
    "test-version",
    { a: "한글 'quote' 포함" },
    true,
  ) as string;
  assert.match(rendered, /-- copy-registry-seed credits_offer test-version active=true/);
  assert.match(rendered, /\$copyjson\$\{"a":"한글 'quote' 포함"\}\$copyjson\$::jsonb/);
  assert.match(rendered, /on conflict \(surface, copy_version\) do nothing;/);
});
