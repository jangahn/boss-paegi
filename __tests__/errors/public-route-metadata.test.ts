import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROUTE_TITLES = new Map([
  ["app/login/page.tsx", "로그인"],
  ["app/consent/page.tsx", "이용 동의"],
  ["app/gallery/layout.tsx", "내 캐릭터들"],
  ["app/leaderboard/layout.tsx", "랭킹"],
  ["app/badges/layout.tsx", "내 뱃지"],
  ["app/credits/layout.tsx", "생성권 충전"],
  ["app/credits/done/layout.tsx", "결제 결과 확인"],
  ["app/generate/layout.tsx", "캐릭터 만들기"],
  ["app/play/layout.tsx", "게임"],
  ["app/account/layout.tsx", "회원정보"],
  ["app/admin/layout.tsx", "운영"],
]);

const SITEMAP_STATIC_ROUTES = [
  { route: "/", source: "app/layout.tsx", ogTitle: "SERVICE_NAME" },
  {
    route: "/faq",
    source: "app/faq/page.tsx",
    ogTitle: "소개·자주 묻는 질문",
  },
  { route: "/play", source: "app/play/layout.tsx", ogTitle: "게임" },
  {
    route: "/news",
    source: "app/news/page.tsx",
    ogTitle: "소식 · 공지·이벤트",
  },
  { route: "/terms", source: "app/terms/page.tsx", ogTitle: "이용약관" },
  {
    route: "/privacy",
    source: "app/privacy/page.tsx",
    ogTitle: "개인정보처리방침",
  },
] as const;

const STATIC_NOINDEX_ROUTES = [
  ["/login", "app/login/page.tsx"],
  ["/consent", "app/consent/page.tsx"],
  ["/gallery", "app/gallery/layout.tsx"],
  ["/leaderboard", "app/leaderboard/layout.tsx"],
  ["/badges", "app/badges/layout.tsx"],
  ["/credits", "app/credits/layout.tsx"],
  ["/credits/done", "app/credits/done/layout.tsx"],
  ["/generate", "app/generate/layout.tsx"],
  ["/account", "app/account/layout.tsx"],
  ["/account/payments", "app/account/payments/page.tsx"],
  ["/account/credits", "app/account/credits/page.tsx"],
] as const;

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("major public and member routes own a distinct metadata title", () => {
  for (const [path, title] of ROUTE_TITLES) {
    const route = source(path);
    assert.match(route, new RegExp(`title: "${title}"`), path);
  }
});

test("every static sitemap route is indexable, self-canonical, and owns matching OG identity", () => {
  const sitemap = source("app/sitemap.ts");
  const listedRoutes = Array.from(
    sitemap.matchAll(/\{ url: `\$\{SITE_URL\}(\/[^`$]*)`/g),
    (match) => match[1]!,
  );
  assert.deepEqual(
    new Set(listedRoutes),
    new Set(SITEMAP_STATIC_ROUTES.map(({ route }) => route)),
  );

  for (const { route, source: path, ogTitle } of SITEMAP_STATIC_ROUTES) {
    const metadata = source(path);
    assert.match(
      metadata,
      new RegExp(
        `alternates:\\s*\\{ canonical: "${escaped(route)}" \\}`,
      ),
      `${route} canonical`,
    );
    assert.match(
      metadata,
      new RegExp(`openGraph:\\s*\\{[\\s\\S]{0,600}title:[^\\n]*${escaped(ogTitle)}`),
      `${route} OG title`,
    );
    if (route === "/") {
      assert.match(metadata, /openGraph:\s*\{[\s\S]{0,600}url: SITE_URL,/);
    } else {
      assert.match(
        metadata,
        new RegExp(
          `openGraph:\\s*\\{[\\s\\S]{0,600}url: \`\\$\\{SITE_URL\\}${escaped(route)}\``,
        ),
        `${route} OG URL`,
      );
    }
    assert.doesNotMatch(
      metadata,
      /robots:\s*\{[^}]*index:\s*false/,
      `${route} is in sitemap and cannot be noindex`,
    );
  }
});

test("noindex routes declare a non-home canonical and stay out of the sitemap", () => {
  const sitemap = source("app/sitemap.ts");
  const listedRoutes = new Set(
    Array.from(
      sitemap.matchAll(/\{ url: `\$\{SITE_URL\}(\/[^`$]*)`/g),
      (match) => match[1]!,
    ),
  );
  for (const [route, path] of STATIC_NOINDEX_ROUTES) {
    const metadata = source(path);
    assert.match(metadata, /robots:\s*\{[^}]*index:\s*false/);
    assert.match(
      metadata,
      new RegExp(
        `alternates:\\s*\\{ canonical: "${escaped(route)}" \\}`,
      ),
      route,
    );
    assert.equal(listedRoutes.has(route), false, route);
  }

  for (const path of [
    "app/history/[userId]/layout.tsx",
    "app/share/[scoreId]/layout.tsx",
    "app/doll/[id]/layout.tsx",
    "app/admin/layout.tsx",
  ]) {
    const metadata = source(path);
    assert.match(metadata, /robots:\s*\{[^}]*index:\s*false/);
    assert.match(metadata, /alternates:\s*\{ canonical: null \}/);
  }
});

test("dynamic news sitemap entries and metadata agree on index and canonical policy", () => {
  const events = source("lib/events/index.ts");
  const detail = source("app/news/[id]/page.tsx");
  assert.match(events, /\.eq\("noindex", false\)/);
  assert.match(detail, /alternates: \{ canonical: `\/news\/\$\{id\}` \}/);
  assert.match(detail, /url: `\$\{SITE_URL\}\/news\/\$\{id\}`/);
  assert.match(detail, /e\.noindex \? \{ robots: \{ index: false/);
});

test("missing UGC metadata never falls back to the home service title", () => {
  const doll = source("app/doll/[id]/page.tsx");
  const score = source("app/share/[scoreId]/page.tsx");
  assert.match(doll, /title: "캐릭터를 찾을 수 없음"/);
  assert.match(score, /title: "게임 기록을 찾을 수 없음"/);
  assert.doesNotMatch(doll, /if \(!doll\) return \{ title: SERVICE_NAME \}/);
  assert.doesNotMatch(score, /if \(!score\)[\s\S]{0,80}title: SERVICE_NAME/);
});
