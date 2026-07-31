import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("header keeps the pre-QA original geometry (2026-08-01 product decision)", () => {
  // 사용자 확정: 네비는 라벨 맞춤 가변 폭(px-2.5 py-1.5 text-sm), 계정 pill은
  // py-1 pl-1 pr-2.5 원형. 고정폭(w-14/w-16)·h-11 확대·text-xs 축소 재도입 금지.
  const nav = source("components/AppNav.tsx");
  const account = source("components/AccountMenu.tsx");
  assert.match(nav, /gap-1\.5 px-3 py-2\.5 sm:px-4/);
  assert.match(nav, /rounded-full px-2\.5 py-1\.5 text-sm font-medium/);
  assert.doesNotMatch(nav, /\bw-14\b|\bh-11\b|\btext-xs\b/);
  assert.match(account, /py-1 pl-1 pr-2\.5 text-sm/);
  assert.match(account, /className="relative"/);
  assert.doesNotMatch(account, /\bh-11\b/);
});

test("home has a single programmatic page title in main content", () => {
  const home = source("app/page.tsx");
  assert.equal((home.match(/<h1\b/g) ?? []).length, 1);
  assert.match(home, /<h1 className="sr-only">/);
  assert.match(home, /직장인 스트레스 해소 게임/);
});

test("interactive public flows retain one page-level heading owner", () => {
  const login = source("app/login/LoginForm.tsx");
  const generate = source("app/generate/page.tsx");
  const play = source("app/play/page.tsx");
  const consentStage = source("components/ConsentDialog.tsx");
  const uploadStage = source("components/generate/UploadStage.tsx");
  const roleStage = source("components/generate/RoleSelectStage.tsx");
  const pickStage = source("components/generate/PickStage.tsx");
  const legal = source("components/legal/LegalPublicPage.tsx");

  assert.ok((login.match(/<h1 className="sr-only">로그인<\/h1>/g) ?? []).length >= 2);
  assert.match(generate, /<h1 className="sr-only">캐릭터 만들기<\/h1>/);
  assert.match(play, /<h1 className="sr-only">부장님 패기 게임<\/h1>/);
  for (const stage of [consentStage, uploadStage, roleStage, pickStage]) {
    assert.doesNotMatch(stage, /<h1\b/);
    assert.match(stage, /<h2\b/);
  }
  assert.match(legal, /<h1 className="text-xl font-bold text-foreground">/);
});
