// 자산 가볍게(v1.61) — 이미지가 늦게 뜨는 시간을 줄이는 규약. 2026-09-25 실측: 소식 본문 원본 PNG 2.2MB(느린 4G LCP 15초),
// 갤러리 기본 캐릭터 카드가 게임용 768×1024 PNG 5장 710KB, 로고 112px 자리에 640px(56KB), 공개 자산 캐시 1시간.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { eventImageVariants } = await import("../../lib/events/markdown-image.ts");
const { LOGO_TRANSFORM, LOGO_PREVIEW_TRANSFORM } = await import("../../lib/site-assets.ts").catch(() => ({
  LOGO_TRANSFORM: null,
  LOGO_PREVIEW_TRANSFORM: null,
}));

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

test("소식 본문 이미지 변환본: object → render, 폭 750 · 1080 · 1440(원본보다 넓게 안 늘림), 비율 유지, contain", () => {
  const base = "https://x.supabase.co/storage/v1";
  const url = `${base}/object/public/events/202609/a.png`;
  const big = eventImageVariants(url, { width: 1731, height: 909 });
  assert.ok(big);
  assert.equal(big.src, `${base}/render/image/public/events/202609/a.png?width=1440&height=756&resize=contain`);
  assert.equal(
    big.srcSet,
    [750, 1080, 1440].map((w) => `${base}/render/image/public/events/202609/a.png?width=${w}&height=${Math.round((w * 909) / 1731)}&resize=contain ${w}w`).join(", "),
  );
  assert.equal(big.sizes, "(min-width: 712px) 672px, calc(100vw - 40px)");
  const small = eventImageVariants(url, { width: 400, height: 300 });
  assert.ok(small);
  assert.equal(small.srcSet, `${base}/render/image/public/events/202609/a.png?width=400&height=300&resize=contain 400w`);
  assert.equal(small.sizes, "(min-width: 440px) 400px, calc(100vw - 40px)");
  // 크기를 모르면 40:21 자리 비율
  const unknown = eventImageVariants(url, null);
  assert.ok(unknown);
  assert.match(unknown.src, /width=1440&height=756&resize=contain$/);
  // 공개 버킷 주소가 아니면 변환하지 않는다
  assert.equal(eventImageVariants("https://example.com/a.png", null), null);
});

test("기본 캐릭터 작은 칸은 카드 썸네일(thumb), 게임 화면만 원본(image)", () => {
  assert.match(source("components/gallery/BaseDollCard.tsx"), /src=\{doll\.thumb\}/);
  assert.match(source("components/gallery/DefaultBossCard.tsx"), /const DEFAULT_BOSS_SRC = BASE_DOLLS\[DEFAULT_BASE_DOLL\]\.thumb;/);
  assert.match(source("app/share/[scoreId]/page.tsx"), /src=\{dollImg \?\? base\.thumb\}/);
  assert.match(source("app/history/[userId]/[scoreId]/page.tsx"), /src=\{dollImg \?\? base\.thumb\}/);
  assert.match(source("app/doll/[id]/page.tsx"), /const DEFAULT_BOSS = BASE_DOLLS\[DEFAULT_BASE_DOLL\]\.thumb;/);
  assert.match(source("app/play/useGameInit.ts"), /Assets\.load\(base\.image\)/);
});

test("홈 캐릭터 얼굴은 첫 화면이라 두 줄 모두 바로 받기(eager)", () => {
  const row = source("components/home/HomeCharacterRow.tsx");
  const faces = [...row.matchAll(/<FadeImg src=\{doll\.face\}([^>]*)\/>/g)];
  assert.equal(faces.length, 2);
  for (const f of faces) assert.match(f[1], /loading="eager"/);
});

test("로고 변환 = 4:3 자리의 3배(384×288), 어드민 미리보기 224×168 — contain", () => {
  // lib/site-assets.ts 는 server-only 라 테스트에서 못 불러오면 소스로 확인한다.
  if (LOGO_TRANSFORM) {
    assert.deepEqual(LOGO_TRANSFORM, { width: 384, height: 288, resize: "contain" });
    assert.deepEqual(LOGO_PREVIEW_TRANSFORM, { width: 224, height: 168, resize: "contain" });
  } else {
    const s = source("lib/site-assets.ts");
    assert.match(s, /export const LOGO_TRANSFORM = \{ width: 384, height: 288, resize: "contain" \} as const;/);
    assert.match(s, /export const LOGO_PREVIEW_TRANSFORM = \{ width: 224, height: 168, resize: "contain" \} as const;/);
  }
});

test("어드민 업로드(소식 이미지 · 사이트 자산)는 1년 캐시 — uuid 경로라 바꾸면 새 경로", () => {
  for (const file of ["components/admin/EventEditor.tsx", "components/admin/content/MediaConfigEditor.tsx"]) {
    assert.match(source(file), /\.uploadToSignedUrl\(d1\.path, d1\.token, file, \{ cacheControl: "31536000" \}\)/, file);
  }
});

test("루트 레이아웃이 Supabase 연결을 미리 연다(crossOrigin anonymous, env 없으면 생략)", () => {
  assert.match(source("app/layout.tsx"), /<MemberHintSync \/>\s*<SupabasePreconnect \/>/);
  const c = source("components/SupabasePreconnect.tsx");
  assert.match(c, /preconnect\(new URL\(url\)\.origin, \{ crossOrigin: "anonymous" \}\)/);
  assert.match(c, /if \(url\) \{/);
});
