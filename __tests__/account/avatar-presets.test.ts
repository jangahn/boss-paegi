// avatar-presets.test.ts — 유저별 고정 기본 프사(v1.41): 해시 배정의 결정성·범위·분포, 커스텀 우선, 프리셋 자산 규격(256px PNG 알파).
//   실행: node --test __tests__/account/avatar-presets.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { AVATAR_PRESET_COUNT, AVATAR_PRESET_INDEXES, avatarPresetUrl, defaultAvatarPreset, defaultAvatarUrl, avatarSrc, avatarPresetThumbUrl, defaultAvatarThumbUrl, avatarThumbSrc, httpsAvatarUrl } =
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

test("작은 칸 썸네일(v1.61): 144px WebP 경로 · 범위 검사 · 커스텀 우선 — 헤더 · 랭킹 · 히스토리는 썸네일, 계정 화면은 원본", () => {
  assert.equal(avatarPresetThumbUrl(3), "/avatars/thumb/preset-3.webp");
  for (const bad of [0, 6, 1.5, Number.NaN]) assert.throws(() => avatarPresetThumbUrl(bad), RangeError);
  const id = "35da9ed8-0432-4a67-95c6-e4e70a2a36a9";
  assert.equal(defaultAvatarThumbUrl(id), `/avatars/thumb/preset-${defaultAvatarPreset(id)}.webp`);
  assert.equal(avatarThumbSrc(null, id), defaultAvatarThumbUrl(id));
  assert.equal(avatarThumbSrc("https://x.supabase.co/storage/v1/object/public/avatars/a.jpg", id), "https://x.supabase.co/storage/v1/object/public/avatars/a.jpg");
  const src = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  for (const file of ["app/leaderboard/page.tsx", "app/history/[userId]/page.tsx", "components/AccountMenu.tsx"]) {
    assert.match(src(file), /avatarThumbSrc\(/, file);
    assert.match(src(file), /fallbackSrc=\{defaultAvatarThumbUrl\(/, file);
  }
  assert.match(src("app/account/page.tsx"), /const avatar = avatarSrc\(profile\.avatar_url, profile\.id\);/);
  for (const i of AVATAR_PRESET_INDEXES) assert.ok(fs.existsSync(path.resolve(process.cwd(), "public", avatarPresetThumbUrl(i).slice(1))), `thumb ${i}`);
});

test("카카오 프로필 사진(v1.63): 주소는 https 로, 작은 칸은 110px 썸네일 — 카카오 기본 이미지 · 구글 · 업로드는 그대로", () => {
  const id = "35da9ed8-0432-4a67-95c6-e4e70a2a36a9";
  const kakao = "http://k.kakaocdn.net/dn/abc/btsXyZ/AbCdEf/img_640x640.jpg";
  const kakaoDefault = "http://img1.kakaocdn.net/thumb/R640x640.q70/?fname=http://t1.kakaocdn.net/account_images/default_profile.jpeg";
  const google = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";
  const upload = "https://x.supabase.co/storage/v1/object/public/avatars/u/a.jpg";
  assert.equal(httpsAvatarUrl(kakao), "https://k.kakaocdn.net/dn/abc/btsXyZ/AbCdEf/img_640x640.jpg");
  assert.equal(httpsAvatarUrl(kakaoDefault), "https://img1.kakaocdn.net/thumb/R640x640.q70/?fname=http://t1.kakaocdn.net/account_images/default_profile.jpeg");
  assert.equal(httpsAvatarUrl("http://example.com/a.jpg"), "http://example.com/a.jpg", "카카오 CDN 밖은 손대지 않는다");
  // 작은 칸: 카카오 사진만 110px, 나머지는 https 고정 외 그대로
  assert.equal(avatarThumbSrc(kakao, id), "https://k.kakaocdn.net/dn/abc/btsXyZ/AbCdEf/img_110x110.jpg");
  assert.equal(avatarThumbSrc(kakaoDefault, id), httpsAvatarUrl(kakaoDefault));
  assert.equal(avatarThumbSrc(google, id), google);
  assert.equal(avatarThumbSrc(upload, id), upload);
  // 큰 칸(회원정보 96 · 변경 창 112px): 카카오 원본(https)
  assert.equal(avatarSrc(kakao, id), "https://k.kakaocdn.net/dn/abc/btsXyZ/AbCdEf/img_640x640.jpg");
  assert.equal(avatarSrc(null, id), defaultAvatarUrl(id));
});

test("업로드 규격(v1.63): 128~256px JPEG 로 정규화, 서버 상한 512KB 는 유지(배포 전환 중 구 번들 수용)", () => {
  const src = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  const lib = src("lib/avatar.ts");
  assert.match(lib, /const MIN_DIM = 128;/);
  assert.match(lib, /const MAX_DIM = 256;/);
  assert.match(lib, /canvas\.toBlob\(resolve, "image\/jpeg", 0\.85\)/);
  assert.match(src("app/api/avatar/route.ts"), /const MAX_BYTES = 512 \* 1024;/);
});
