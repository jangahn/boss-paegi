// iPhone SE(375×667) 무깨짐 전수 검사 하네스 — 모든 라우트 + 버튼/모달 상태를 크롤하며 레이아웃 위반을 측정한다.
//
// 안전장치: 쓰기 요청(POST/PUT/PATCH/DELETE)은 네트워크 계층에서 전부 차단(토큰 갱신만 허용)해
//           프로덕션을 대상으로 버튼을 눌러도 데이터가 바뀌지 않는다. 로그아웃 버튼은 클릭 대상에서 제외.
// 사용:  BASE=https://boss-paegi.vercel.app ENGINE=webkit COOKIES=./cookies.json SEEDS=./seeds.json node audit.mjs
// 출력:  OUT/report.json, OUT/report.md, OUT/shots/*.png

import { chromium, webkit, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.BASE || "https://boss-paegi.vercel.app").replace(/\/$/, "");
const ENGINE = process.env.ENGINE || "chromium";
const COOKIES = process.env.COOKIES || "./cookies.json";
const SEEDS = process.env.SEEDS || "./seeds.json";
const OUT = process.env.OUT || `./out-${ENGINE}`;
const MAX_PAGES = Number(process.env.MAX_PAGES || 400);
const CLICK = process.env.CLICK !== "0";
const MAX_CLICKS = Number(process.env.MAX_CLICKS || 30);
const PER_PATTERN = Number(process.env.PER_PATTERN || 2);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });

// Playwright 의 "iPhone SE" 는 1세대(320×568). 실제 대상은 2·3세대(375×667) = iPhone 8 디스크립터.
const device = { ...(devices["iPhone 8"] || {}), viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const launcher = ENGINE === "webkit" ? webkit : chromium;

const seeds = JSON.parse(fs.readFileSync(SEEDS, "utf8"));
const cookieDefs = fs.existsSync(COOKIES) ? JSON.parse(fs.readFileSync(COOKIES, "utf8")) : [];
const baseUrl = new URL(BASE);

// ── 인페이지 측정 스크립트 ────────────────────────────────────────────────────
const AUDIT_FN = `(() => {
  const vw = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const out = [];
  const seen = new Set();
  const desc = (el) => {
    const cls = (typeof el.className === "string" ? el.className : "").trim().replace(/\\s+/g, " ").slice(0, 90);
    const txt = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls.split(" ").slice(0, 6).join(".") : "") + (txt ? " «" + txt + "»" : "");
  };
  const chain = (el) => {
    const parts = [];
    let cur = el.parentElement;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      const cls = (typeof cur.className === "string" ? cur.className : "").trim().split(/\\s+/).slice(0, 3).join(".");
      parts.push(cur.tagName.toLowerCase() + (cls ? "." + cls : ""));
      cur = cur.parentElement;
    }
    return parts.join(" < ");
  };
  const r4 = (r) => ({ l: Math.round(r.left), t: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right) });
  const push = (type, sev, el, extra) => {
    const key = type + "|" + desc(el);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.assign({ type, sev, el: desc(el), chain: chain(el), rect: r4(el.getBoundingClientRect()) }, extra || {}));
  };
  const nearestHeading = (el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      const h = cur.querySelector && cur.querySelector("h1,h2,h3,h4");
      if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 40);
      cur = cur.parentElement;
    }
    return "";
  };
  if (sw > vw + 1) out.push({ type: "doc-overflow", sev: "error", el: "document", chain: "", rect: { w: sw, vw } });
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    if (el.closest("script,style,noscript,svg *")) continue;
    if (el.tagName === "SVG" || el.tagName === "PATH") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const tag0 = el.tagName;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.width <= 1 && r.height <= 1) continue; // sr-only 등 시각 숨김
    const transformed = (v) => v && v !== "none";
    if (transformed(cs.transform) || transformed(cs.rotate) || transformed(cs.scale) || transformed(cs.translate)) continue; // 회전 스탬프 등 변형 요소(Tailwind v4 는 rotate/scale/translate 개별 속성)
    if (parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0) continue; // 의도된 블리드(-mx-*)
    const pos = cs.position;
    if (pos === "fixed" || pos === "absolute") {
      if (r.right > vw + 2 || r.left < -2) {
        if (!(el.closest("[aria-hidden='true']"))) push("out-of-viewport", "error", el, { heading: nearestHeading(el) });
      }
      // 절대/고정 요소는 부모 박스 비교에서 제외
    } else {
      const p = el.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        const pcs = getComputedStyle(p);
        const pr = p.getBoundingClientRect();
        if (pcs.display !== "contents" && pcs.display !== "inline" && pr.width > 0) {
          const over = r.right > pr.right + 2 || r.left < pr.left - 2;
          if (over) {
            const ox = pcs.overflowX;
            if (ox === "auto" || ox === "scroll") {
              push("scroll-container", "info", p, { heading: nearestHeading(p), childRight: Math.round(r.right), parentRight: Math.round(pr.right) });
            } else if (ox === "hidden" || ox === "clip") {
              push("clipped", "warn", el, { heading: nearestHeading(el), parentRight: Math.round(pr.right) });
            } else {
              push("child-overflow", "error", el, { heading: nearestHeading(el), parentRight: Math.round(pr.right), parent: desc(p) });
            }
          }
        }
      }
    }
    // 자기 내용이 자기 박스를 넘침(텍스트 스필/자식 스필) — 폼 컨트롤 내부 텍스트 스크롤은 네이티브 동작이라 제외
    const formControl = tag0 === "INPUT" || tag0 === "TEXTAREA" || tag0 === "SELECT";
    if (!formControl && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const excess = el.scrollWidth - el.clientWidth;
      // 미세 초과(≤8px)가 후손의 의도된 블리드(-mx-*)·변형에서 온 것이면 무시
      if (excess <= 8 && [...el.querySelectorAll("*")].some((c) => { const s = getComputedStyle(c); return transformed(s.transform) || transformed(s.rotate) || transformed(s.scale) || transformed(s.translate) || parseFloat(s.marginLeft) < 0 || parseFloat(s.marginRight) < 0; })) continue;
      const ox = cs.overflowX;
      if (ox === "auto" || ox === "scroll") {
        push("scroll-container", "info", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      } else if (ox === "hidden" || ox === "clip") {
        if (cs.textOverflow === "ellipsis") push("truncated", "info", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        else push("clipped", "warn", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      } else if (ox === "visible") {
        push("content-overflow", "error", el, { heading: nearestHeading(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    }
    // 짧은 라벨(알약·탭·버튼)이 두 줄로 꺾임
    const tag = el.tagName;
    if ((tag === "BUTTON" || tag === "A" || tag === "SPAN" || tag === "LABEL" || tag === "TH" || el.getAttribute("role") === "tab") && el.children.length === 0) {
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length <= 8 && !/\\s/.test(t) && cs.whiteSpace !== "nowrap") {
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set([...range.getClientRects()].filter((b) => b.width > 0).map((b) => Math.round(b.top)));
        if (tops.size >= 2) push("label-wrapped", "warn", el, { heading: nearestHeading(el), lines: tops.size });
      }
    }
  }
  return { vw, sw, findings: out };
})()`;

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const patternOf = (u) => {
  const url = new URL(u, BASE);
  const p = url.pathname.replace(UUID, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");
  const q = [...url.searchParams.keys()].sort().join(",");
  return p + (q ? "?" + q : "");
};
const slug = (s) => s.replace(/^https?:\/\/[^/]+/, "").replace(/[^a-zA-Z0-9가-힣]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 110) || "root";
const SKIP_HREF = /^(mailto:|tel:|javascript:|#)|\/api\/|\/auth\/|\/login|logout|signout|\.(png|jpg|jpeg|webp|csv|pdf|zip)(\?|$)|\/share\/[^/]+\/opengraph/i;
const SKIP_CLICK = /로그아웃|logout|sign ?out|카카오로 시작|Google로 시작|계정 삭제|탈퇴하기$/i;
const CLOSE_TEXT = /^(닫기|취소|아니요|나중에|확인했어요|close|cancel)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const patternCount = new Map();
const visited = new Set();
const queue = [];
const results = [];
const enqueue = (href, from) => {
  let u;
  try { u = new URL(href, BASE); } catch { return; }
  if (u.origin !== baseUrl.origin) return;
  if (SKIP_HREF.test(u.pathname + u.search) || SKIP_HREF.test(href)) return;
  u.hash = "";
  const key = u.pathname + u.search;
  if (visited.has(key) || queue.includes(key)) return;
  const pat = patternOf(key);
  const n = patternCount.get(pat) || 0;
  if (n >= PER_PATTERN) return;
  patternCount.set(pat, n + 1);
  queue.push(key);
};

async function settle(page) {
  await page.waitForLoadState("load", { timeout: 45000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await sleep(900);
}

async function audit(page, label, shotName, opts = {}) {
  const res = await page.evaluate(AUDIT_FN).catch((e) => ({ vw: 0, sw: 0, findings: [{ type: "audit-error", sev: "warn", el: String(e).slice(0, 120), chain: "", rect: {} }] }));
  const errs = res.findings.filter((f) => f.sev === "error").length;
  const warns = res.findings.filter((f) => f.sev === "warn").length;
  const file = path.join("shots", `${errs || warns ? "X_" : ""}${shotName}.png`);
  try {
    await page.screenshot({ path: path.join(OUT, file), fullPage: !opts.viewportOnly, timeout: 15000 });
  } catch {}
  results.push({ label, url: page.url(), engine: ENGINE, vw: res.vw, sw: res.sw, errors: errs, warns, findings: res.findings, shot: file });
  const flag = errs ? "✗" : warns ? "△" : "✓";
  console.log(`${flag} ${label}  errors=${errs} warns=${warns}`);
  return res;
}

async function collectLinks(page) {
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).catch(() => []);
  for (const h of hrefs) enqueue(h);
}

async function buttonSignatures(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const out = [];
    const els = document.querySelectorAll("button, [role=button], summary, [role=tab], select");
    els.forEach((el, i) => {
      if (el.closest("[role=dialog]")) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (el.disabled) return;
      const text = (el.innerText || el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const cls = (typeof el.className === "string" ? el.className : "").trim().slice(0, 100);
      const sig = el.tagName + "|" + text + "|" + cls;
      if (seen.has(sig)) return;
      seen.add(sig);
      el.setAttribute("data-se-idx", String(i));
      out.push({ idx: i, tag: el.tagName, text, sig });
    });
    return out;
  }).catch(() => []);
}

async function dialogState(page) {
  return page.evaluate(() => {
    const d = document.querySelector("[role=dialog]");
    return { dialog: !!d, dialogLabel: d ? (d.getAttribute("aria-label") || "") : "", html: document.body.innerHTML.length, url: location.pathname + location.search };
  }).catch(() => ({ dialog: false, dialogLabel: "", html: 0, url: "" }));
}

async function closeDialog(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  let st = await dialogState(page);
  if (st.dialog) {
    const btns = page.locator("[role=dialog] button");
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const t = ((await btns.nth(i).innerText().catch(() => "")) || "").trim();
      if (CLOSE_TEXT.test(t)) { await btns.nth(i).click({ timeout: 2000 }).catch(() => {}); break; }
    }
    await sleep(300);
    st = await dialogState(page);
  }
  return st;
}

async function exploreButtons(page, pageKey, baseState, shotBase) {
  const sigs = await buttonSignatures(page);
  let clicks = 0;
  for (const s of sigs) {
    if (clicks >= MAX_CLICKS) break;
    if (SKIP_CLICK.test(s.text)) continue;
    if (s.tag === "SELECT") continue;
    clicks++;
    const loc = page.locator(`[data-se-idx="${s.idx}"]`);
    if ((await loc.count().catch(() => 0)) === 0) continue;
    try {
      await loc.first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await loc.first().click({ timeout: 3000, noWaitAfter: true });
    } catch { continue; }
    await sleep(800);
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    const st = await dialogState(page);
    const navigated = st.url && st.url !== baseState.url;
    if (navigated) {
      enqueue(st.url);
      await page.goBack({ waitUntil: "load", timeout: 20000 }).catch(() => {});
      await settle(page);
      await buttonSignatures(page); // re-tag indexes
      continue;
    }
    const changed = st.dialog || Math.abs(st.html - baseState.html) > 120;
    if (!changed) continue;
    const lbl = `${pageKey} ▸ [${s.text || s.tag.toLowerCase()}]${st.dialog ? " (dialog: " + st.dialogLabel + ")" : ""}`;
    await audit(page, lbl, `${shotBase}__click_${slug(s.text || s.tag)}_${clicks}`, { viewportOnly: st.dialog });
    // 다이얼로그 안 2차 버튼(단계 전환) — 닫기류 제외, 최대 6개
    if (st.dialog) {
      const inner = await page.evaluate(() => {
        const d = document.querySelector("[role=dialog]");
        if (!d) return [];
        const seen = new Set();
        const out = [];
        d.querySelectorAll("button, [role=tab], summary").forEach((el, i) => {
          const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
          if (el.disabled || seen.has(t)) return;
          seen.add(t);
          el.setAttribute("data-se-inner", String(i));
          out.push({ i, t });
        });
        return out;
      }).catch(() => []);
      let innerClicks = 0;
      for (const b of inner) {
        if (innerClicks >= 6) break;
        if (CLOSE_TEXT.test(b.t) || SKIP_CLICK.test(b.t)) continue;
        innerClicks++;
        const il = page.locator(`[data-se-inner="${b.i}"]`);
        if ((await il.count().catch(() => 0)) === 0) continue;
        await il.first().click({ timeout: 2000, noWaitAfter: true }).catch(() => {});
        await sleep(900);
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        const st2 = await dialogState(page);
        if (st2.url !== baseState.url) { await page.goBack({ waitUntil: "load", timeout: 20000 }).catch(() => {}); await settle(page); break; }
        await audit(page, `${lbl} ▸ [${b.t}]`, `${shotBase}__click_${slug(s.text || s.tag)}_${clicks}__${slug(b.t)}`, { viewportOnly: true });
      }
    }
    const after = await closeDialog(page);
    if (after.dialog || Math.abs(after.html - baseState.html) > 120 || after.url !== baseState.url) {
      await page.goto(BASE + pageKey, { waitUntil: "load", timeout: 45000 }).catch(() => {});
      await settle(page);
      await buttonSignatures(page);
    }
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
const browser = await launcher.launch({ headless: true });
const context = await browser.newContext({ ...device, locale: "ko-KR", timezoneId: "Asia/Seoul", colorScheme: "light" });
if (cookieDefs.length) await context.addCookies(cookieDefs.map((c) => ({ ...c, domain: c.domain || baseUrl.hostname, path: "/", secure: baseUrl.protocol === "https:", sameSite: "Lax" })));
await context.route("**/*", (route) => {
  const req = route.request();
  const m = req.method();
  const url = req.url();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    if (/\/auth\/v1\/token/.test(url)) return route.continue();
    return route.abort("blockedbyclient");
  }
  if (/sentry\.io|ingest\.sentry|\/monitoring\?/.test(url)) return route.abort();
  return route.continue();
});
context.on("dialog", (d) => d.dismiss().catch(() => {}));
const page = await context.newPage();
page.setDefaultTimeout(15000);

for (const s of seeds) enqueue(s, "seed");
let count = 0;
while (queue.length && count < MAX_PAGES) {
  const key = queue.shift();
  if (visited.has(key)) continue;
  if (ONLY && !ONLY.test(key)) continue;
  visited.add(key);
  count++;
  const shotBase = slug(key);
  try {
    await page.goto(BASE + key, { waitUntil: "load", timeout: 45000 });
  } catch (e) {
    results.push({ label: key, url: BASE + key, engine: ENGINE, errors: 0, warns: 1, findings: [{ type: "nav-error", sev: "warn", el: String(e).slice(0, 120), chain: "", rect: {} }], shot: "" });
    console.log(`! ${key} nav-error`);
    continue;
  }
  await settle(page);
  const finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
  const label = finalPath === key ? key : `${key} → ${finalPath}`;
  await audit(page, label, shotBase);
  await collectLinks(page);
  if (CLICK && !/^\/play/.test(key)) {
    const baseState = await dialogState(page);
    await exploreButtons(page, key, baseState, shotBase);
  }
}
await browser.close();

// ── 리포트 ────────────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ base: BASE, engine: ENGINE, device: device.viewport, pages: results }, null, 2));
const lines = [`# iPhone SE 무깨짐 전수 검사 — ${ENGINE} · ${BASE} · ${new Date().toISOString()}`, "", `페이지/상태 ${results.length}개 · 에러 ${results.filter((r) => r.errors).length} · 경고만 ${results.filter((r) => !r.errors && r.warns).length}`, ""];
for (const r of results) {
  const bad = r.findings.filter((f) => f.sev !== "info");
  if (!bad.length) continue;
  lines.push(`## ${r.errors ? "✗" : "△"} ${r.label}`);
  lines.push(`- url: ${r.url}  · shot: ${r.shot}`);
  for (const f of bad) lines.push(`- **${f.type}** [${f.sev}] ${f.el}${f.heading ? "  ⟨" + f.heading + "⟩" : ""}  · ${f.chain}  · rect ${JSON.stringify(f.rect)}${f.parentRight != null ? " parentRight=" + f.parentRight : ""}${f.scrollWidth ? " sw/cw=" + f.scrollWidth + "/" + f.clientWidth : ""}${f.lines ? " lines=" + f.lines : ""}`);
  lines.push("");
}
lines.push("## 정상 (에러·경고 없음)");
for (const r of results) if (!r.findings.some((f) => f.sev !== "info")) lines.push(`- ✓ ${r.label}`);
fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n"));
console.log(`\nDONE pages=${results.length} errors=${results.filter((r) => r.errors).length} warns=${results.filter((r) => !r.errors && r.warns).length} → ${OUT}/report.md`);
