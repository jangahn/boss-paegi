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

// WebP 크기(VP8X 확장 · VP8 손실 · VP8L 무손실 세 형식) — 썸네일 규격 확인용.
function webpSize(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(buf.subarray(8, 12).toString("ascii"), "WEBP");
  const chunk = buf.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

test("머리 크롭(face): 5종이 프사 프리셋 5장을 하나씩 — 홈 캐릭터 줄은 144px WebP 썸네일(v1.61), 원본은 256×256 PNG(v1.49 매핑)", () => {
  const pub = path.resolve(process.cwd(), "public");
  // 1=화난 검은 머리(기본 부장님) · 5=회색 구레나룻(사장님) · 3=긴 머리(부장님 여) · 4=단발(팀장님 여) · 2=능글 웃음(신입)
  assert.deepEqual(
    BASE_DOLL_KEYS.map((k) => BASE_DOLLS[k].face),
    ["/avatars/thumb/preset-1.webp", "/avatars/thumb/preset-5.webp", "/avatars/thumb/preset-3.webp", "/avatars/thumb/preset-4.webp", "/avatars/thumb/preset-2.webp"],
  );
  assert.equal(new Set(BASE_DOLL_KEYS.map((k) => BASE_DOLLS[k].face)).size, BASE_DOLL_KEYS.length, "한 장씩");
  for (const key of BASE_DOLL_KEYS) {
    const thumb = path.join(pub, BASE_DOLLS[key].face);
    assert.ok(fs.existsSync(thumb), thumb);
    assert.deepEqual(webpSize(fs.readFileSync(thumb)), { width: 144, height: 144 }, thumb);
    assert.ok(fs.statSync(thumb).size <= 16 * 1024, `${thumb}: 16KB 상한`);
    // 썸네일의 원본 = 같은 번호의 프사 프리셋 PNG(256×256)
    const source = path.join(pub, BASE_DOLLS[key].face.replace("/thumb/", "/").replace(/\.webp$/, ".png"));
    const buf = fs.readFileSync(source);
    assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${source}: PNG`);
    assert.equal(buf.readUInt32BE(16), 256, `${source}: width`);
    assert.equal(buf.readUInt32BE(20), 256, `${source}: height`);
  }
});

test("카드 썸네일(thumb, v1.61): 5종 public/sprites/thumb/<key>.webp 384×512(원본 768×1024 의 절반), 32KB 이하", () => {
  const pub = path.resolve(process.cwd(), "public");
  for (const key of BASE_DOLL_KEYS) {
    const d = BASE_DOLLS[key];
    assert.equal(d.thumb, `/sprites/thumb/${key}.webp`);
    const file = path.join(pub, d.thumb);
    assert.ok(fs.existsSync(file), file);
    assert.deepEqual(webpSize(fs.readFileSync(file)), { width: 384, height: 512 }, file);
    assert.ok(fs.statSync(file).size <= 32 * 1024, `${file}: 32KB 상한`);
  }
  // 생성 스크립트의 키 · 원본 경로가 어휘와 같다
  const script = fs.readFileSync(path.resolve(process.cwd(), "scripts/gen-static-thumbs.mjs"), "utf8");
  for (const key of BASE_DOLL_KEYS) {
    assert.match(script, new RegExp(`"${key}": "${BASE_DOLLS[key].image.slice(1).replace(/\//g, "\\/")}"`), key);
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
