import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("leaderboard period buttons expose their selected state", () => {
  const leaderboard = source("app/leaderboard/page.tsx");
  assert.match(leaderboard, /aria-pressed=\{active\}/);
});

test("news filters expose a labeled navigation and current filter", () => {
  const news = source("app/news/page.tsx");
  assert.match(news, /aria-label="소식 종류"/);
  assert.equal((news.match(/aria-current=/g) ?? []).length, 3);
});

test("game toggle and picker controls expose their selected state", () => {
  const play = source("app/play/page.tsx");
  const weapons = source("components/WeaponPicker.tsx");
  const backgrounds = source("components/play/BgSwitcher.tsx");

  assert.match(play, /aria-pressed=\{soundMuted\}/);
  assert.match(weapons, /aria-label="무기 선택"/);
  assert.match(weapons, /aria-pressed=\{w\.key === active\}/);
  assert.match(backgrounds, /aria-label="배경 선택"/);
  assert.match(backgrounds, /aria-pressed=\{b\.key === active\}/);
});

test("report grade labels and comments have an audible separator", () => {
  for (const path of [
    "components/ScoreReport.tsx",
    "app/share/[scoreId]/page.tsx",
    "app/history/[userId]/[scoreId]/page.tsx",
  ]) {
    assert.match(source(path), /— \{grade\.comment\}/, path);
  }
});

test("modal shell and nickname editor expose dialog and field names", () => {
  const modal = source("components/ModalShell.tsx");
  const account = source("components/AccountMenu.tsx");
  const gameOver = source("components/GameOverModal.tsx");
  const consent = source("app/consent/ConsentForm.tsx");
  const focus = source("lib/use-dialog-focus.ts");

  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-label=\{ariaLabel\}/);
  assert.match(modal, /ariaLabel: string/);
  assert.doesNotMatch(modal, /ariaLabel\?: string/);
  assert.match(modal, /useDialogFocus<HTMLDivElement>\(mounted, onClose\)/);
  assert.match(account, /ariaLabel="닉네임 수정"/);
  assert.match(account, /aria-label="닉네임"/);
  assert.match(gameOver, /role="dialog"/);
  assert.match(gameOver, /aria-modal="true"/);
  assert.match(gameOver, /aria-label="게임 결과"/);
  assert.match(gameOver, /useDialogFocus<HTMLDivElement>\(open\)/);
  assert.match(consent, /ariaLabel=\{`\$\{viewingDoc\.title\} 전문`\}/);
  assert.match(focus, /event\.key === "Escape"/);
  assert.match(focus, /event\.key !== "Tab"/);
  assert.match(focus, /previous\?\.isConnected/);
});

test("account, reviewer login, and reporting fields have explicit audible names", () => {
  const accountPage = source("app/account/page.tsx");
  const login = source("app/login/LoginForm.tsx");
  const report = source("components/ReportDialog.tsx");

  assert.match(accountPage, /htmlFor="account-nickname"/);
  assert.match(accountPage, /id="account-nickname"/);
  assert.match(accountPage, /htmlFor="withdraw-confirm"/);
  assert.match(accountPage, /id="withdraw-confirm"/);
  assert.match(login, /htmlFor="reviewer-email"/);
  assert.match(login, /htmlFor="reviewer-password"/);
  assert.match(report, /<fieldset/);
  assert.match(report, /<legend className="sr-only">신고 사유<\/legend>/);
  assert.match(report, /htmlFor=\{`\$\{fieldPrefix\}-detail`\}/);
  assert.match(report, /htmlFor=\{`\$\{fieldPrefix\}-contact`\}/);
  assert.match(report, /role="alert"/);
});

test("primary navigation exposes the current page", () => {
  assert.match(source("components/AppNav.tsx"), /aria-current=/);
});

test("mobile viewport does not disable user zoom", () => {
  const layout = source("app/layout.tsx");
  assert.doesNotMatch(layout, /maximumScale/);
  assert.doesNotMatch(layout, /userScalable/);
});

test("not-found UI is localized, navigable, and excluded from indexing", () => {
  const notFound = source("app/not-found.tsx");
  assert.match(notFound, /페이지를 찾을 수 없어요/);
  assert.match(notFound, /href="\/"/);
  assert.match(notFound, /index: false/);
});
