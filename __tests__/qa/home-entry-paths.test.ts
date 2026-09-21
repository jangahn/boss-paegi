// home-entry-paths.test.ts — 홈 진입 경로(v1.49): 문구 키 개명 읽기 정규화 · 상태별 1차/2차 버튼 라우팅 · 캐릭터 줄 규칙.
//   실행: node --experimental-strip-types --test __tests__/qa/home-entry-paths.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { MARKETING_COPY_DEFAULT, marketingCopySchema, normalizeMarketingCopyInput } = await import(
  "../../lib/config/domains/marketing.ts"
);

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("문구 키 개명: 발행행의 구 primaryCta·secondaryCta 값이 createCta·playCta 로 무손실 승계되고 신규 키는 기본값으로 찬다", () => {
  const published = {
    ...MARKETING_COPY_DEFAULT,
    home: { tagline: "태그", primaryCta: "발행된 만들기", secondaryCta: "발행된 바로 패기", disclaimer: "고지" },
  };
  const parsed = marketingCopySchema.parse(published);
  assert.deepEqual(parsed.home, {
    tagline: "태그",
    lockedCaption: "가입하면 캐릭터 4명이 더 열려요",
    playCta: "발행된 바로 패기",
    memberPlayCta: "캐릭터 골라서 패기",
    createCta: "발행된 만들기",
    disclaimer: "고지",
  });
  assert.equal("primaryCta" in parsed.home, false, "구 키는 strip");
});

test("문구 키 개명: 새 키가 이미 있으면 그대로(재발행 뒤 no-op) · 객체가 아니면 통과", () => {
  const mixed = normalizeMarketingCopyInput({
    home: { primaryCta: "구 만들기", createCta: "새 만들기", secondaryCta: "구 패기" },
  }) as { home: Record<string, string> };
  assert.equal(mixed.home.createCta, "새 만들기");
  assert.equal(mixed.home.playCta, "구 패기");
  const fresh = { home: { playCta: "a", createCta: "b" } };
  assert.equal(normalizeMarketingCopyInput(fresh), fresh, "구 키가 없으면 입력 그대로");
  assert.equal(normalizeMarketingCopyInput(null), null);
  assert.deepEqual(normalizeMarketingCopyInput([1]), [1]);
  assert.deepEqual(marketingCopySchema.parse(MARKETING_COPY_DEFAULT), MARKETING_COPY_DEFAULT, "코드 기본값은 그대로 valid");
});

test("홈: 1차 = 플레이(비회원 /play · 회원 /gallery), 2차 = 만들기(비회원은 가입 후 생성), 부제 없음", () => {
  const home = source("app/page.tsx");
  assert.match(home, /\? \{ href: "\/gallery", label: home\.memberPlayCta \}/);
  assert.match(home, /: \{ href: "\/play", label: home\.playCta \};/);
  assert.match(home, /const createHref = isLoggedIn \? "\/generate" : "\/login\?next=\/generate";/);
  assert.match(home, /\{home\.createCta\}/);
  // 로그인 상태는 fail-closed 기본(비회원) — 세션 확인 뒤에만 회원 표시.
  assert.match(home, /const \[isLoggedIn, setIsLoggedIn\] = useState\(false\);/);
  // 2차 버튼 아래 부제는 두지 않는다(사용자 결정) — 가입 혜택은 캐릭터 줄 캡션 한 곳.
  assert.doesNotMatch(home, /nonmemberTitle|genCredits|formatCredits/);
  // 텍스트 링크 = 랭킹 + 내 뱃지(갤러리는 1차 버튼·내비와 중복이라 제거).
  assert.match(home, /href="\/leaderboard"/);
  assert.match(home, /href="\/badges"/);
  assert.doesNotMatch(home, /href="\/gallery"\s+className="font-semibold/);
  // 클릭 계측은 내비를 막지 않는다.
  assert.match(home, /log\.info\("home\.cta_click", \{ slot, state \}\);/);
});

test("홈 캐릭터 줄: 열린 캐릭터만 링크, 잠긴 캐릭터는 무상호작용 티저, 375px 카드 안쪽 폭에 들어온다", () => {
  const row = source("components/home/HomeCharacterRow.tsx");
  assert.match(row, /const locked = !isLoggedIn && doll\.extra;/);
  assert.match(row, /href=\{playHrefFor\(key\)\}/);
  const lockedBranch = row.slice(row.indexOf("{locked ? ("), row.indexOf(") : ("));
  assert.ok(lockedBranch.length > 0);
  assert.doesNotMatch(lockedBranch, /<Link|<button|onClick|href=/, "잠금 카드 무상호작용(v1.44)");
  assert.match(lockedBranch, /opacity-60 blur-\[2px\] grayscale-\[35%\]/, "갤러리 잠금 카드와 같은 표현");
  assert.match(row, /\{!isLoggedIn && <p className="text-xs text-zinc-500">\{lockedCaption\}<\/p>\}/);
  // 48px × 5 + 6px × 4 = 264px ≤ 271px(375 − main 24×2 − 카드 28×2).
  assert.match(row, /const FACE = "h-12 w-12 /);
  assert.match(row, /className="flex justify-center gap-1\.5"/);
  assert.ok(48 * 5 + 6 * 4 <= 375 - 24 * 2 - 28 * 2);
});
