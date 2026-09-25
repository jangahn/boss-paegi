// home-entry-paths.test.ts — 홈 진입 경로(v1.49): 문구 키 개명 읽기 정규화 · 상태별 1차/2차 버튼 라우팅 · 캐릭터 줄 규칙(v1.51: 두 상태 동시 렌더).
//   실행: node --experimental-strip-types --test __tests__/qa/home-entry-paths.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { MARKETING_COPY_DEFAULT, normalizeMarketingCopyInput } = await import("../../lib/config/domains/marketing.ts");
const { marketingCopySchema } = await import("../../lib/config/domains/marketing-schema.ts");

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
  // v1.51: 두 상태를 정적 HTML 에 같이 넣고 회원 힌트(첫 페인트 전 쿠키 판별)로 하나만 보인다 — 새로고침 때 회원에게 비회원 화면이 보이지 않는다.
  // v1.52: 표시 클래스는 lib/member-hint.ts 소유(<head> 인라인 style) — Tailwind 변형은 Vercel 빌드 캐시에서 규칙이 빠진 사고로 폐기.
  assert.match(
    home,
    /state="nonmember"\s+className=\{`\$\{FOR_NONMEMBER_CLASS\} flex flex-col gap-3`\}\s+play=\{\{ href: "\/play", label: home\.playCta \}\}\s+create=\{\{ href: "\/login\?next=\/generate", label: home\.createCta \}\}/,
  );
  assert.match(
    home,
    /state="member"\s+className=\{`\$\{FOR_MEMBER_CLASS\} flex flex-col gap-3`\}\s+play=\{\{ href: "\/gallery", label: home\.memberPlayCta \}\}\s+create=\{\{ href: "\/generate", label: home\.createCta \}\}/,
  );
  // 로그인 상태는 세션으로 확정해 힌트를 맞춘다. 세션을 읽지 못하면 힌트를 그대로 둔다(힌트가 없으면 비회원 화면) — React 상태로 화면을 바꾸지 않는다.
  assert.match(home, /applyMemberHint\(\s*sessionData\.session !== null &&\s*sessionData\.session\.user\.is_anonymous !== true,\s*\);/);
  assert.doesNotMatch(home, /useState|isLoggedIn/);
  // 2차 버튼 아래 부제는 두지 않는다(사용자 결정) — 가입 혜택은 캐릭터 줄 캡션 한 곳.
  assert.doesNotMatch(home, /nonmemberTitle|genCredits|formatCredits/);
  // 텍스트 링크 = 랭킹 + 내 뱃지(갤러리는 1차 버튼·내비와 중복이라 제거) — 상태와 무관하게 한 번만 렌더.
  assert.equal(home.split('href="/leaderboard"').length, 2);
  assert.equal(home.split('href="/badges"').length, 2);
  assert.doesNotMatch(home, /href="\/gallery"\s+className="font-semibold/);
  // 클릭 계측은 내비를 막지 않는다 — state 는 누른 쪽 블록의 상태.
  assert.match(home, /log\.info\("home\.cta_click", \{ slot, state \}\);/);
  assert.match(home, /onClick=\{\(\) => onClick\("play", state\)\}/);
  assert.match(home, /onClick=\{\(\) => onClick\("create", state\)\}/);
});

test("홈 캐릭터 줄: 열린 캐릭터만 링크, 잠긴 캐릭터는 무상호작용 티저, 375px 카드 안쪽 폭에 들어온다", () => {
  const row = source("components/home/HomeCharacterRow.tsx");
  // v1.51: 비회원용 줄(잠금 4종 + 캡션)과 회원용 줄(5종 전부 열림, 캡션 없음)을 둘 다 렌더하고 회원 힌트로 하나만 보인다.
  assert.match(row, /const locked = state === "nonmember" && doll\.extra;/);
  assert.match(
    row,
    /<div className=\{`\$\{FOR_NONMEMBER_CLASS\} flex w-full flex-col items-center gap-2`\}>\s*<CharacterFaces state="nonmember" onPlay=\{onPlay\} \/>\s*<p className="text-xs text-zinc-500">\{lockedCaption\}<\/p>\s*<\/div>/,
  );
  assert.match(
    row,
    /<div className=\{`\$\{FOR_MEMBER_CLASS\} flex w-full flex-col items-center gap-2`\}>\s*<CharacterFaces state="member" onPlay=\{onPlay\} \/>\s*<\/div>/,
  );
  assert.match(row, /href=\{playHrefFor\(key\)\}/);
  const lockedBranch = row.slice(row.indexOf("{locked ? ("), row.indexOf(") : ("));
  assert.ok(lockedBranch.length > 0);
  assert.doesNotMatch(lockedBranch, /<Link|<button|onClick|href=/, "잠금 카드 무상호작용(v1.44)");
  assert.match(lockedBranch, /opacity-60 blur-\[2px\] grayscale-\[35%\]/, "갤러리 잠금 카드와 같은 표현");
  // 48px × 5 + 6px × 4 = 264px ≤ 271px(375 − main 24×2 − 카드 28×2).
  assert.match(row, /const FACE = "h-12 w-12 /);
  assert.match(row, /className="flex justify-center gap-1\.5"/);
  assert.ok(48 * 5 + 6 * 4 <= 375 - 24 * 2 - 28 * 2);
});
