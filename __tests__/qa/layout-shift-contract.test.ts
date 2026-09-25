// 화면 밀림 방지 규약(v1.60) — 자산 · 데이터가 늦게 와도 이미 그려진 요소가 자리를 옮기지 않게 하는 소스 규약을 고정한다.
// 실측은 scripts/qa/se-audit/shift.mjs(느린 4G · CPU 4배 · 첫 방문, Chromium layout-shift)가 한다. 2026-09-25 전수 실측에서
// 밀림의 원인은 ①빈 Suspense fallback ②완성 화면보다 짧은 로딩 표시(사업자 정보 푸터가 밀림) ③크기 정보 없는 이미지
// ④실제 비율과 다른 이미지 자리 ⑤로딩 뒤에만 끼어드는 배너였다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const { firstMarkdownImageSrc, parseEventImageSrc, withEventImageSize } = await import("../../lib/events/markdown-image.ts");
const { PAGE_LOADING_ATTRIBUTE, PAGE_LOADING_PROPS, PAGE_LOADING_STYLE, SITE_FOOTER_ATTRIBUTE } = await import("../../lib/page-loading.ts");

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(new URL(dir, root))) {
    const rel = `${dir}/${name}`;
    if (statSync(new URL(rel, root)).isDirectory()) out.push(...tsxFiles(rel));
    else if (rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

test("소식 본문 이미지 크기 조각: 붙이고 떼기, 형식 밖이면 크기 없음, 첫 이미지 주소", () => {
  const url = "https://x.supabase.co/storage/v1/object/public/events/202609/a.png";
  assert.equal(withEventImageSize(url, { width: 1731.4, height: 909 }), `${url}#1731x909`);
  assert.deepEqual(parseEventImageSrc(`${url}#1731x909`), { url, size: { width: 1731, height: 909 } });
  assert.deepEqual(parseEventImageSrc(url), { url, size: null });
  assert.deepEqual(parseEventImageSrc(`${url}#0x909`), { url, size: null });
  assert.deepEqual(parseEventImageSrc(`${url}#abc`), { url: `${url}#abc`, size: null });
  assert.equal(firstMarkdownImageSrc("글\n\n![](a.png#10x5)\n\n![대체](b.png)"), "a.png#10x5");
  assert.equal(firstMarkdownImageSrc("이미지 없음"), null);
});

test("소식 본문: 크기를 알면 width/height, 모르면 40:21 자리 · 어드민은 넣을 때 크기를 기록", () => {
  const md = source("components/events/Markdown.tsx");
  assert.match(md, /const \{ url, size \} = parseEventImageSrc\(src\);/);
  assert.match(md, /<img src=\{url\} alt=\{alt \?\? ""\} width=\{size\.width\} height=\{size\.height\} loading=\{loading\} \/>/);
  assert.match(md, /<span className="block aspect-\[40\/21\] w-full">/);
  assert.match(md, /const loading = src === firstImageSrc \? "eager" : "lazy";/);
  const editor = source("components/admin/EventEditor.tsx");
  assert.match(editor, /await Promise\.all\(\[upload\(file\), readImageFileSize\(file\)\]\)/);
  assert.match(editor, /const src = size \? withEventImageSize\(url, size\) : url;/);
});

test("로딩 중 푸터 숨김: 규칙은 <head> 인라인 style, 푸터가 표지를 단다", () => {
  assert.equal(PAGE_LOADING_ATTRIBUTE, "data-page-loading");
  assert.deepEqual(PAGE_LOADING_PROPS, { "data-page-loading": "", "aria-busy": true });
  assert.equal(PAGE_LOADING_STYLE, `body:has([data-page-loading]) [${SITE_FOOTER_ATTRIBUTE}]{display:none!important}`);
  assert.match(source("app/layout.tsx"), /<style dangerouslySetInnerHTML=\{\{ __html: PAGE_LOADING_STYLE \}\} \/>/);
  assert.match(source("components/SiteFooter.tsx"), /<footer\s+\{\.\.\.\{ \[SITE_FOOTER_ATTRIBUTE\]: "" \}\}/);
});

test("서버 HTML fallback 은 비우지 않는다 — 페이지의 Suspense fallback 이 null 이거나 빈 div 면 실패", () => {
  const withSuspense = tsxFiles("app").filter((f) => /<Suspense\b/.test(source(f)));
  assert.ok(withSuspense.length >= 5, withSuspense.join(", "));
  for (const file of withSuspense) {
    const s = source(file);
    assert.doesNotMatch(s, /fallback=\{null\}/, file);
    assert.doesNotMatch(s, /fallback=\{<div className="flex flex-1" \/>\}/, file);
  }
});

test("로딩 상태는 PAGE_LOADING_PROPS 를 단다 — 어드민 밖 loading.tsx 전부 + 브라우저 로딩 스켈레톤", () => {
  const routeLoadings = tsxFiles("app").filter((f) => f.endsWith("/loading.tsx") && !f.startsWith("app/admin/"));
  assert.ok(routeLoadings.length >= 4, routeLoadings.join(", "));
  for (const file of routeLoadings) assert.match(source(file), /<main \{\.\.\.PAGE_LOADING_PROPS\}/, file);
  for (const file of [
    "app/account/page.tsx",
    "app/gallery/page.tsx",
    "app/badges/page.tsx",
    "app/leaderboard/page.tsx",
    "app/generate/page.tsx",
    "app/play/page.tsx",
    "app/login/LoginForm.tsx",
  ]) {
    assert.match(source(file), /\{\.\.\.(?:\(.*\? )?PAGE_LOADING_PROPS/, file);
  }
  // 결제 결과(/credits/done)는 표지를 달지 않는다 — 사업자 정보 상시 노출 대상이고, 가운데 정렬 짧은 화면이라 푸터가 움직이지 않는다.
  assert.doesNotMatch(source("app/credits/done/page.tsx"), /\{\.\.\.PAGE_LOADING_PROPS\}/);
});

test("이미지는 도착 전에 자리를 잡는다 — 원시 <img> · next/image 는 고정 크기 상자 또는 width/height", () => {
  const files = [...tsxFiles("app"), ...tsxFiles("components")].filter((f) => !f.endsWith("opengraph-image.tsx"));
  let seen = 0;
  for (const file of files) {
    const s = source(file);
    for (const m of s.matchAll(/<(img|Image)\b([^>]*?)\/>/g)) {
      seen++;
      const attrs = m[2];
      const hasSize = /\bwidth=\{/.test(attrs) && /\bheight=\{/.test(attrs);
      const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(attrs);
      const c = cls ? (cls[1] ?? cls[2]) : "";
      const fixedBox =
        (/\bh-full\b/.test(c) && /\bw-full\b/.test(c)) || /\baspect-/.test(c) || (/\bh-\d/.test(c) && /\bw-\d/.test(c));
      assert.ok(hasSize || fixedBox, `${file}: <${m[1]}${attrs.slice(0, 120)}`);
      // next/image 는 width/height 가 필수이고, 자리가 실제 비율과 어긋나지 않게 고정 크기 상자도 함께 둔다.
      if (m[1] === "Image") assert.ok(hasSize && fixedBox, `${file}: <Image${attrs.slice(0, 120)}`);
    }
  }
  assert.ok(seen >= 8, `원시 <img>·<Image> ${seen}개만 발견 — 탐색 정규식 점검`);
});

test("로고 자리 4:3 = 로고 자산 비율(640×480) — 홈 112×84 · 로그인 128×96 · 어드민 미리보기 4:3", () => {
  const png = readFileSync(new URL("public/logo.png", root));
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.equal(w * 3, h * 4, `public/logo.png ${w}×${h}`);
  assert.match(source("app/page.tsx"), /width=\{640\}\s+height=\{480\}[\s\S]*?className="h-21 w-28 max-w-full object-contain"/);
  assert.match(source("app/login/LoginForm.tsx"), /width=\{640\}\s+height=\{480\}[\s\S]*?className="h-24 w-32 max-w-full object-contain"/);
  assert.match(source("components/admin/content/MediaConfigEditor.tsx"), /box: "aspect-\[4\/3\] w-28"/);
});

test("랭킹: 서버 HTML 에 같은 틀 + 스켈레톤, 스켈레톤 행 높이 = 실제 행(이름 24px + 시간 16px, 점수 28px)", () => {
  const s = source("app/leaderboard/page.tsx");
  assert.match(s, /fallback=\{\s*<LeaderboardFrame period=\{DEFAULT_PERIOD\}>\s*<RankSkeleton \/>\s*<\/LeaderboardFrame>\s*\}/);
  const skeleton = s.slice(s.indexOf("function RankSkeleton"));
  assert.match(skeleton, /<div className="flex h-6 items-center">/);
  assert.match(skeleton, /<div className="flex h-4 items-center">/);
  assert.match(skeleton, /<div className="flex h-7 items-center">/);
  assert.match(s, /<div className="truncate font-medium">/);
  assert.match(s, /<div className="text-xs text-zinc-500">\{timeAgo\(r\.created_at\)\}<\/div>/);
  assert.match(s, /<div className="text-xl font-extrabold tabular-nums">/);
});

test("갤러리: 비회원 가입 배너는 로딩 중에도 로딩 뒤와 같은 자리(회원 힌트)", () => {
  assert.match(
    source("app/gallery/page.tsx"),
    /<div className=\{FOR_NONMEMBER_CLASS\}>\s*<SignupBanner state="nonmember" \/>\s*<\/div>\s*<GridSkeleton \/>/,
  );
});

test("로딩 자리 높이 = 완성 높이: 계정 메뉴 34px, 게임 「그만 패기」는 준비 전에도 자리를 차지", () => {
  assert.match(source("components/AccountMenu.tsx"), /<div className="flex h-8\.5 w-24 items-center justify-end">/);
  const play = source("app/play/page.tsx");
  assert.doesNotMatch(play, /\{gameReady && \(\s*<button[^>]*>\s*그만 패기/);
  assert.match(play, /gameReady \? "" : "invisible"/);
});
