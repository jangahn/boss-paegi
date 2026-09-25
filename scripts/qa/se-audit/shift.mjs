// 화면 밀림(레이아웃 시프트) 측정 하네스(v1.60) — 자산 · 데이터가 늦게 와서 이미 그려진 요소가 자리를 옮기는지 라우트마다 잰다.
//
// 조건: iPhone SE(375×667) · 느린 4G(왕복 150ms, 1.6Mbps) · CPU 4배 감속 · 라우트마다 새 컨텍스트(빈 캐시 = 첫 방문).
// 측정: Chromium layout-shift API(움직인 요소와 전후 좌표) → CLS(창 방식, 1초 간격 · 5초 상한). 하네스는 입력을 보내지 않으므로
//       hadRecentInput 표시와 무관하게 전부 센다. 판정: CLS ≥ 0.1 error, ≥ 0.01 warn.
// 안전장치: audit.mjs 와 같다 — 쓰기 요청(POST/PUT/PATCH/DELETE) 전부 차단(토큰 갱신만 허용), Sentry 전송 차단.
// 한계: ① Playwright 가 route 를 가로채면 HTTP 캐시가 꺼진다 — 재방문(캐시 있음) 측정은 불가, 캐시는 응답 헤더로 판단한다.
//       ② 쿠키 없이(비회원) 재면 익명 로그인(POST)이 막혀 하이드레이션 게이트가 안 풀린다 — 서버 HTML 단계(로고 · 본문 이미지 자리)만 유효.
//       ③ Chromium 전용(layout-shift API). 3px 미만 이동은 Chromium 이 세지 않는다.
// 사용:  BASE=https://boss-paegi.vercel.app COOKIES=./cookies.json SEEDS=./seeds.json node shift.mjs
//        ONLY=<regex> 로 라우트 제한, FILM=<regex> 로 해당 라우트의 화면 프레임 저장(OUT/film/<라우트>/)
// 출력:  OUT/shift-report.json, OUT/shift-report.md

import { chromium, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.BASE || "https://boss-paegi.vercel.app").replace(/\/$/, "");
const COOKIES = process.env.COOKIES || "./cookies.json";
const SEEDS = process.env.SEEDS || "./seeds.json";
const OUT = process.env.OUT || "./out-shift";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const FILM = process.env.FILM ? new RegExp(process.env.FILM) : null;
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);
const WARN_CLS = 0.01;
const ERROR_CLS = 0.1;

fs.mkdirSync(OUT, { recursive: true });

const device = { ...(devices["iPhone 8"] || {}), viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const seeds = JSON.parse(fs.readFileSync(SEEDS, "utf8"));
const cookieDefs = fs.existsSync(COOKIES) ? JSON.parse(fs.readFileSync(COOKIES, "utf8")) : [];
const baseUrl = new URL(BASE);

// ── 인페이지: layout-shift · LCP 기록(페이지 스크립트보다 먼저) ──
const INIT = () => {
  const describe = (n) => {
    if (!n || n.nodeType !== 1) return n && n.nodeType === 3 ? `#text "${(n.textContent || "").trim().slice(0, 24)}"` : String(n);
    const cls = typeof n.className === "string" ? n.className.split(/\s+/).filter(Boolean).slice(0, 4).join(".") : "";
    const txt = (n.innerText || n.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 28);
    const src = n.tagName === "IMG" ? ` src=${(n.currentSrc || n.src || "").replace(/\?.*$/, "").slice(-48)}` : "";
    return `${n.tagName.toLowerCase()}${cls ? "." + cls : ""}${txt ? ` "${txt}"` : ""}${src}`;
  };
  const rect = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);
  window.__shifts = [];
  window.__lcp = null;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__shifts.push({
          t: Math.round(e.startTime),
          v: e.value,
          sources: (e.sources || []).map((s) => ({ node: describe(s.node), prev: rect(s.previousRect), cur: rect(s.currentRect) })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      const all = list.getEntries();
      const e = all[all.length - 1];
      window.__lcp = { t: Math.round(e.startTime), node: describe(e.element) };
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    // layout-shift 미지원 엔진 — 빈 기록
  }
};

// 표준 CLS: 최대 세션 창(창 안 간격 < 1초, 창 길이 ≤ 5초)의 합.
function sessionWindowCls(shifts) {
  let max = 0;
  let cur = 0;
  let first = -1;
  let prev = -1;
  for (const s of shifts) {
    if (first >= 0 && s.t - prev < 1000 && s.t - first < 5000) cur += s.v;
    else {
      cur = s.v;
      first = s.t;
    }
    prev = s.t;
    max = Math.max(max, cur);
  }
  return max;
}

const browser = await chromium.launch({ headless: true });
const results = [];

for (const route of seeds) {
  if (ONLY && !ONLY.test(route)) continue;
  const context = await browser.newContext({ ...device, locale: "ko-KR", timezoneId: "Asia/Seoul", colorScheme: "light" });
  if (cookieDefs.length) await context.addCookies(cookieDefs.map((c) => ({ ...c, domain: c.domain || baseUrl.hostname, path: "/", secure: baseUrl.protocol === "https:", sameSite: "Lax" })));
  await context.route("**/*", (r) => {
    const req = r.request();
    const m = req.method();
    const url = req.url();
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
      if (/\/auth\/v1\/token/.test(url)) return r.continue();
      return r.abort("blockedbyclient");
    }
    if (/sentry\.io|ingest\.sentry|\/monitoring\?/.test(url)) return r.abort();
    return r.continue();
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const frames = [];
  const film = FILM ? FILM.test(route) : false;
  if (film) {
    cdp.on("Page.screencastFrame", async (f) => {
      frames.push({ ts: f.metadata.timestamp, data: f.data });
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 750, maxHeight: 1334 });
  }
  const startedAt = Date.now() / 1000;
  let status = null;
  try {
    const resp = await page.goto(BASE + route, { waitUntil: "load", timeout: 90000 });
    status = resp ? resp.status() : null;
  } catch (e) {
    status = `goto-error: ${String(e.message || e).slice(0, 80)}`;
  }
  await page.waitForTimeout(SETTLE_MS);
  if (film) await cdp.send("Page.stopScreencast").catch(() => {});
  const data = await page
    .evaluate(() => ({ shifts: window.__shifts || [], lcp: window.__lcp, finalUrl: location.pathname + location.search }))
    .catch((e) => ({ shifts: [], lcp: null, finalUrl: null, error: String(e.message || e) }));
  const cls = sessionWindowCls(data.shifts);
  const sev = cls >= ERROR_CLS ? "error" : cls >= WARN_CLS ? "warn" : "ok";
  results.push({ route, status, cls, sev, ...data });
  if (film && frames.length) {
    const dir = path.join(OUT, "film", route.replace(/[^a-z0-9]+/gi, "_"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, f] of frames.entries()) {
      const ms = Math.round((f.ts - startedAt) * 1000);
      fs.writeFileSync(path.join(dir, `${String(i).padStart(3, "0")}_${ms}ms.jpg`), Buffer.from(f.data, "base64"));
    }
  }
  console.log(`${sev === "ok" ? " " : sev === "warn" ? "!" : "X"} ${route} CLS=${cls.toFixed(3)} shifts=${data.shifts.length} → ${data.finalUrl}`);
  await context.close();
  fs.writeFileSync(path.join(OUT, "shift-report.json"), JSON.stringify(results, null, 1));
}
await browser.close();

// ── 보고서 ──
const lines = [
  "# 화면 밀림 측정",
  "",
  `대상 ${BASE} · 375×667 · 느린 4G · CPU 4배 · 첫 방문 · error ≥ ${ERROR_CLS}, warn ≥ ${WARN_CLS}`,
  "",
  "| 판정 | 라우트 | CLS | 밀림 |",
  "|---|---|---|---|",
];
for (const r of results) {
  lines.push(`| ${r.sev} | ${r.route} | ${r.cls.toFixed(3)} | ${r.shifts.length} |`);
}
lines.push("", "## 움직인 요소(warn · error)", "");
for (const r of results.filter((x) => x.sev !== "ok")) {
  lines.push(`### ${r.route} (CLS ${r.cls.toFixed(3)})`);
  for (const s of r.shifts) {
    for (const src of s.sources) {
      lines.push(`- ${s.t}ms ${s.v.toFixed(4)} ${src.node} ${JSON.stringify(src.prev)} → ${JSON.stringify(src.cur)}`);
    }
  }
  lines.push("");
}
fs.writeFileSync(path.join(OUT, "shift-report.md"), lines.join("\n"));
const bad = results.filter((r) => r.sev !== "ok").length;
console.log(`done ${results.length} routes, warn/error ${bad} → ${path.join(OUT, "shift-report.md")}`);
