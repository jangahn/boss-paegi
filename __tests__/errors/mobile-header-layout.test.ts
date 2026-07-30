import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("mobile header gives navigation and account a bounded shared width", () => {
  const nav = source("components/AppNav.tsx");
  const account = source("components/AccountMenu.tsx");
  assert.match(nav, /gap-1 px-2/);
  assert.match(nav, /px-1\.5 py-1\.5 text-xs/);
  assert.match(account, /max-w-\[40vw\]/);
  assert.match(account, /className="relative min-w-0/);
  assert.match(account, /w-full min-w-0 max-w-full/);
  assert.match(account, /min-w-0 flex-1 truncate/);
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
