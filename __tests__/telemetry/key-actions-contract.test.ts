// key-actions-contract.test.ts — PC 키보드 사용 기록(v1.50, mig 0131): 클라 totals.keyActions ↔ 검증기 ↔ 적재 RPC ↔ 롤업 차원 ↔ 어드민.
//   0131 은 프로드 실측 본문(= 0130 적재 RPC · 0125 롤업 함수)에 더하기만 했다(+ 적재 RPC 의 무기 종류 수 상한 9→19 드리프트 수정)
//   — 바꾼 부분을 되돌리면 원본과 바이트 동일해야 한다.
//   실행: node --experimental-strip-types --test __tests__/telemetry/key-actions-contract.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";

register("./node-loader.mjs", import.meta.url);

const { sanitizePayload } = await import("../../lib/telemetry/validate.ts");
const { FORCE_END_GRACE_MS, MAX_AVG_SCORE_PER_SEC, MAX_DURATION_MS, MAX_SCORE_HARD } = await import("../../lib/score-limits.ts");
const { DEVICE_CLASSES, WEAPON_KEYS, MAP_KEYS } = await import("../../lib/telemetry/budget.ts");

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
const sql = read("supabase/migrations/0131_telemetry_key_actions.sql");

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, name);
  const open = source.indexOf("$function$", start);
  const close = source.indexOf("$function$", open + 10);
  return source.slice(start, close + "$function$".length);
}

const KEY_ACTIONS_BLOCK = `           key_actions = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,keyActions}', ''
                 )::int,
                 0
               ),
               0
             ),
             1000000
           ),
`;

test("0131: 컬럼은 additive(nullable default 0) — 구 번들·구 RPC 와 어느 순서로도 호환", () => {
  assert.match(sql, /alter table public\.telemetry_sessions add column if not exists key_actions integer default 0;/);
  assert.match(sql, /notify pgrst, 'reload schema';/);
});

test("0131 적재 RPC = 0130 본문 + key_actions 한 블록 + 무기 종류 수 상한 9→19(봉투 리터럴·의심 판정 불변)", () => {
  const next = functionBody(sql, "bp_ingest_telemetry_delta_core");
  const prev = functionBody(read("supabase/migrations/0130_telemetry_ingest_envelope_x4.sql"), "bp_ingest_telemetry_delta_core");
  assert.equal(next.split(KEY_ACTIONS_BLOCK).length, 2, "key_actions 블록 1회");
  assert.equal(
    next.replace(KEY_ACTIONS_BLOCK, "").replace("  c_weapon_count int := 19;", "  c_weapon_count int := 9;"),
    prev,
    "더한 블록과 고친 리터럴을 되돌리면 0130 과 동일",
  );
  assert.ok(next.indexOf(KEY_ACTIONS_BLOCK) > next.indexOf("max_touch = least("), "max_touch 와 같은 UPDATE 목록");
  const lit = (name: string) => Number(next.match(new RegExp(`\\n  ${name} \\w+ := (\\d+);`))![1]);
  assert.equal(lit("c_max_avg_per_sec"), MAX_AVG_SCORE_PER_SEC);
  assert.equal(lit("c_max_score"), MAX_SCORE_HARD);
  assert.equal(lit("c_max_duration"), MAX_DURATION_MS + FORCE_END_GRACE_MS);
  // 종류 수 상한 = 클라 검증기와 같은 어휘 크기(무기 19·맵 6) — 0027 시절 값(9)이 v1.35 에서 안 올라간 드리프트 재발 방지.
  assert.equal(lit("c_weapon_count"), WEAPON_KEYS.length);
  assert.equal(lit("c_map_count"), MAP_KEYS.length);
  assert.match(read("lib/telemetry/validate.ts"), /distinctWeapons: boundedInt\(\s*t\.distinctWeapons,\s*0,\s*WEAPON_KEYS\.length,?\s*\)/);
});

test("0131 롤업 함수 = 0125 본문 + sess CTE 의 key_actions + 'sess_keyboard' 차원", () => {
  const next = functionBody(sql, "telemetry_rollup_rows_for_day");
  const prev = functionBody(read("supabase/migrations/0125_weapon_roster_maps.sql"), "telemetry_rollup_rows_for_day");
  const dimStart = next.indexOf("  -- 키보드 사용(v1.50)");
  const dimEnd = next.indexOf("  -- 패기 유형 분포(v1.14)");
  assert.ok(dimStart > 0 && dimEnd > dimStart);
  const dim = next.slice(dimStart, dimEnd);
  assert.equal((next.slice(0, dimStart) + next.slice(dimEnd)).replace("      ts.key_actions,\n", ""), prev, "더한 부분을 빼면 0125 와 동일");
  assert.match(dim, /select 'sess_keyboard'::text, s\.device_class,/);
  assert.match(dim, /count\(\*\) filter \(where coalesce\(s\.key_actions, 0\) > 0\)::numeric/);
  assert.match(dim, /from sess s where s\.first_hit_ms is not null\s+group by s\.device_class\s+union all\n$/);
});

test("검증기: keyActions 는 정수 0~1e6(= RPC 클램프), 필드 없는 구 payload 는 0", () => {
  const base = () => ({
    sessionId: "11111111-1111-4111-8111-111111111111",
    deviceClass: "desktop-pointer",
    startedAt: new Date(Date.UTC(2026, 8, 21)).toISOString(),
    summary: {
      seqHigh: 1,
      endedAt: null,
      endReason: null,
      durationMs: 1000,
      startMap: "office",
      startWeapon: "fist",
      totals: { score: 10, hitCount: 1 } as Record<string, number>,
      weaponSummary: {},
      mapSummary: {},
      milestones: {},
    },
    events: [],
  });
  const nowMs = Date.UTC(2026, 8, 21, 0, 1);
  const legacy = sanitizePayload(base(), { nowMs });
  assert.ok(legacy);
  assert.equal(legacy.summary.totals.keyActions, 0);
  for (const [input, expected] of [[41.6, 42], [-5, 0], [5e9, 1e6], [Number.NaN, 0]] as const) {
    const payload = base();
    payload.summary.totals.keyActions = input;
    assert.equal(sanitizePayload(payload, { nowMs })!.summary.totals.keyActions, expected, String(input));
  }
  assert.ok((DEVICE_CLASSES as readonly string[]).includes("desktop-pointer"), "키보드 비율의 실질 분모 device_class");
});

test("수집·표시 경로: 받아들여진 공격 동작만 세고(궁극기 발동 포함), 어드민 세 곳이 같은 컬럼·차원을 읽는다", () => {
  const collector = read("lib/telemetry/collector.ts");
  assert.match(collector, /noteKeyAction\(\): void \{\s*if \(this\.sessionKeyActions < 1e6\) this\.sessionKeyActions \+= 1;/);
  assert.match(collector, /keyActions: this\.sessionKeyActions,/);
  const hook = read("app/play/useKeyboardControls.ts");
  assert.match(hook, /latest\.current\.onUltimate\(\);\s*latest\.current\.onUltimateKey\(\);/);
  // 그 밖의 공격 동작은 게임(KeyboardInput)이 쿨다운·동시 입력 묶기를 거쳐 받아들인 것만 onKeyAction 으로 알린다.
  assert.match(read("game/input/KeyboardInput.ts"), /this\.host\.onAction\?\.\(\);/);
  assert.match(read("game/scenes/PlayScene.ts"), /onAction: opts\.onKeyAction,/);
  const page = read("app/play/page.tsx");
  assert.match(page, /onKeyAction: telemetry\.onKeyAction,/);
  assert.match(page, /onUltimateKey: telemetry\.onKeyAction,/);

  const analytics = read("lib/admin-analytics.ts");
  assert.match(analytics, /fetchDimRows\(\["sess_keyboard"\], window\)/);
  assert.match(analytics, /export const KEYBOARD_DEVICE_CLASS = "desktop-pointer";/);
  assert.match(analytics, /key_actions: "nullableNonnegativeInteger",/);
  assert.match(read("lib/admin-integrity.ts"), /max_touch, key_actions, distinct_weapons/);
  assert.match(read("app/admin/analytics/page.tsx"), /<KeyboardUsagePanel data=\{keyboardUsage\} \/>/);
});
