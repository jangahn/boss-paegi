// avatar-presets.test.ts — 유저별 고정 기본 프사(v1.41): 해시 배정의 결정성·범위·분포, 커스텀 우선, 프리셋 자산 규격(256px PNG 알파).
//   실행: node --test __tests__/account/avatar-presets.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { AVATAR_PRESET_COUNT, AVATAR_PRESET_INDEXES, avatarPresetUrl, defaultAvatarPreset, defaultAvatarUrl, avatarSrc } =
  await import("../../lib/avatar-presets.ts");

test("프리셋 URL: 1..5 만 유효, 범위 밖은 RangeError", () => {
  assert.equal(AVATAR_PRESET_COUNT, 5);
  assert.deepEqual([...AVATAR_PRESET_INDEXES], [1, 2, 3, 4, 5]);
  assert.equal(avatarPresetUrl(3), "/avatars/preset-3.png");
  for (const bad of [0, 6, 1.5, Number.NaN]) assert.throws(() => avatarPresetUrl(bad), RangeError);
});

test("유저별 고정: 같은 id 는 항상 같은 프리셋, 결과는 1..5, id 없으면 1번", () => {
  const ids = ["35da9ed8-0432-4a67-95c6-e4e70a2a36a9", "f81c8a92-0000-4000-8000-000000000000", "6aaa7ce3-c6cf-475e-ab55-da35589e8db5"];
  for (const id of ids) {
    const a = defaultAvatarPreset(id);
    assert.equal(defaultAvatarPreset(id), a, "결정적");
    assert.ok(a >= 1 && a <= 5, `${id} → ${a}`);
    assert.equal(defaultAvatarUrl(id), `/avatars/preset-${a}.png`);
  }
  assert.equal(defaultAvatarPreset(null), 1);
  assert.equal(defaultAvatarPreset(undefined), 1);
  assert.equal(defaultAvatarPreset(""), 1);
});

test("분포: uuid 모양 id 1,000개가 5장에 고루 퍼진다(각 10% 이상)", () => {
  const counts = new Map<number, number>();
  for (let i = 0; i < 1000; i++) {
    const hex = (n: number) => n.toString(16).padStart(8, "0");
    const id = `${hex(i * 2654435761)}-${hex(i * 40503).slice(0, 4)}-4${hex(i * 7).slice(0, 3)}-8${hex(i * 13).slice(0, 3)}-${hex(i * 97)}${hex(i * 31).slice(0, 4)}`;
    const p = defaultAvatarPreset(id);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  assert.equal(counts.size, 5, "5장 전부 등장");
  for (const [p, n] of counts) assert.ok(n >= 100, `preset ${p}: ${n}`);
});

test("avatarSrc: 커스텀 프사가 있으면 그것, 없거나 빈 문자열이면 유저별 기본", () => {
  const id = "35da9ed8-0432-4a67-95c6-e4e70a2a36a9";
  assert.equal(avatarSrc("https://x.supabase.co/storage/v1/object/public/avatars/a.jpg", id), "https://x.supabase.co/storage/v1/object/public/avatars/a.jpg");
  assert.equal(avatarSrc(null, id), defaultAvatarUrl(id));
  assert.equal(avatarSrc("", id), defaultAvatarUrl(id));
});

test("프리셋 자산: public/avatars/preset-1..5.png 존재, 256×256, RGBA/팔레트 PNG(알파), 64KB 이하", () => {
  const dir = path.resolve(process.cwd(), "public/avatars");
  for (const i of AVATAR_PRESET_INDEXES) {
    const file = path.join(dir, `preset-${i}.png`);
    assert.ok(fs.existsSync(file), file);
    const buf = fs.readFileSync(file);
    assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file}: PNG 시그니처`);
    assert.equal(buf.readUInt32BE(16), 256, `${file}: width`);
    assert.equal(buf.readUInt32BE(20), 256, `${file}: height`);
    const colorType = buf[25];
    assert.ok(colorType === 6 || colorType === 3, `${file}: colorType ${colorType} (6=RGBA·3=palette)`);
    assert.ok(buf.length <= 64 * 1024, `${file}: ${buf.length} bytes`);
  }
  assert.ok(!fs.existsSync(path.join(dir, "default.png")), "고정 default.png 는 프리셋으로 대체됨");
});
