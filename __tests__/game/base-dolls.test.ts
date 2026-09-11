// base-dolls.test.ts — 기본 캐릭터 5종(v1.42): 어휘·롤/성별·URL 해석·자산 규격(768×1024 PNG 알파, 기본 부장님과 동일)·텔레메트리 표기.
//   실행: node --test __tests__/game/base-dolls.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  BASE_DOLL_KEYS,
  BASE_DOLLS,
  DEFAULT_BASE_DOLL,
  EXTRA_BASE_DOLLS,
  baseDollKeyFromParam,
  baseDollOf,
  isBaseDollKey,
  playHrefFor,
  telemetryBaseDollLabel,
} = await import("../../lib/base-dolls.ts");
const { ROLE_IDS } = await import("../../lib/roles/ids.ts");
const { GENDERS } = await import("../../lib/gender.ts");

test("어휘: 기본 부장님 + 추가 4종, 키 = 롤-성별, 롤·성별은 현행 어휘 안", () => {
  assert.deepEqual([...BASE_DOLL_KEYS], ["boss-m", "ceo-m", "boss-f", "teamlead-f", "junior-m"]);
  assert.equal(DEFAULT_BASE_DOLL, "boss-m");
  assert.deepEqual(EXTRA_BASE_DOLLS.map((d) => d.key), ["ceo-m", "boss-f", "teamlead-f", "junior-m"]);
  for (const key of BASE_DOLL_KEYS) {
    const d = BASE_DOLLS[key];
    assert.equal(d.key, key);
    assert.ok((ROLE_IDS as readonly string[]).includes(d.role), `${key} role ${d.role}`);
    assert.ok((GENDERS as readonly string[]).includes(d.gender), `${key} gender ${d.gender}`);
    assert.equal(key, `${d.role}-${d.gender[0]}`, "키 = 롤-성별 이니셜");
    assert.equal(d.extra, key !== "boss-m");
  }
  assert.equal(BASE_DOLLS["boss-m"].image, "/sprites/boss-default.png", "기본 부장님 스프라이트는 종전 경로 그대로");
});

test("URL 해석: 없음=boss-m, 키=그 키, uuid 등=null(커스텀) · href · 폴백", () => {
  assert.equal(baseDollKeyFromParam(null), "boss-m");
  assert.equal(baseDollKeyFromParam(""), "boss-m");
  assert.equal(baseDollKeyFromParam("ceo-m"), "ceo-m");
  assert.equal(baseDollKeyFromParam("4625c2c7-0c05-46f3-9877-c9ae92b990e6"), null);
  assert.equal(baseDollKeyFromParam("CEO-M"), null, "대소문자 엄격");
  assert.equal(isBaseDollKey("boss-f"), true);
  assert.equal(isBaseDollKey("boss"), false);
  assert.equal(playHrefFor("boss-m"), "/play");
  assert.equal(playHrefFor("teamlead-f"), "/play?doll=teamlead-f");
  assert.equal(baseDollOf(null).key, "boss-m", "구 기록(null) = 기본 부장님");
  assert.equal(baseDollOf("junior-m").role, "junior");
  assert.equal(baseDollOf("nope").key, "boss-m");
  assert.equal(telemetryBaseDollLabel(null), "default");
  assert.equal(telemetryBaseDollLabel("boss-m"), "default", "롤업 호환: 기본 부장님은 종전 표기");
  assert.equal(telemetryBaseDollLabel("boss-f"), "boss-f");
});

test("자산: 추가 4종은 public/sprites/base/<key>.png 768×1024 PNG(알파·팔레트), 기본 부장님과 같은 규격", () => {
  const pub = path.resolve(process.cwd(), "public");
  for (const d of [...EXTRA_BASE_DOLLS, BASE_DOLLS["boss-m"]]) {
    const file = path.join(pub, d.image);
    assert.ok(fs.existsSync(file), file);
    const buf = fs.readFileSync(file);
    assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file}: PNG`);
    assert.equal(buf.readUInt32BE(16), 768, `${file}: width`);
    assert.equal(buf.readUInt32BE(20), 1024, `${file}: height`);
    const colorType = buf[25];
    assert.ok(colorType === 6 || colorType === 3, `${file}: colorType ${colorType}`);
    assert.ok(buf.length <= 256 * 1024, `${file}: ${buf.length} bytes (256KB 상한)`);
  }
});

test("DB CHECK 어휘(0127)와 코드 어휘가 같다", () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations/0127_base_dolls.sql"), "utf8");
  const m = sql.match(/base_doll in \(([^)]*)\)/);
  assert.ok(m, "check constraint");
  const dbKeys = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  assert.deepEqual(dbKeys, [...BASE_DOLL_KEYS]);
  assert.match(sql, /p_base_doll text DEFAULT NULL\)/);
  assert.match(sql, /case when p_doll_id is null then p_base_doll else null end/);
});

test("점수 라우트 계약(v1.43): p_base_doll 은 저장 RPC 에만, 예약 RPC 공유 인자엔 없다", () => {
  const route = fs.readFileSync(path.resolve(process.cwd(), "app/api/score/route.ts"), "utf8");
  const attemptArgs = route.slice(route.indexOf("const scoreAttemptArgs = {"), route.indexOf("};", route.indexOf("const scoreAttemptArgs = {")));
  assert.doesNotMatch(attemptArgs, /p_base_doll/, "reserve_score_write_attempt 에는 p_base_doll 파라미터가 없다(공유 인자에 넣으면 PostgREST 해석 실패 → 전 제출 500)");
  const submitCall = route.slice(route.indexOf('admin.rpc("submit_score_with_review"'), route.indexOf("});", route.indexOf('admin.rpc("submit_score_with_review"')));
  assert.match(submitCall, /\.\.\.scoreAttemptArgs,\s*p_base_doll: dollId \? null : baseDoll,/);
  assert.match(route, /const baseDoll = isBaseDollKey\(body\.baseDoll\) \? body\.baseDoll : null;/);
});
