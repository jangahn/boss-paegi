// 단일 URL 즉시 측정: BASE=... ENGINE=webkit node one.mjs /path [click-button-text]
import { chromium, webkit, devices } from "playwright";
import fs from "node:fs";
import { AUDIT_FN } from "./audit-fn.mjs";
const BASE = (process.env.BASE || "https://boss-paegi.vercel.app").replace(/\/$/, "");
const ENGINE = process.env.ENGINE || "chromium";
const [path, clickText] = process.argv.slice(2);
const device = { ...(devices["iPhone 8"] || {}), viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
const context = await browser.newContext({ ...device, locale: "ko-KR", timezoneId: "Asia/Seoul", colorScheme: "light" });
const cookies = fs.existsSync("./cookies.json") ? JSON.parse(fs.readFileSync("./cookies.json", "utf8")) : [];
if (cookies.length) await context.addCookies(cookies.map((c) => ({ ...c, domain: new URL(BASE).hostname, path: "/", secure: true, sameSite: "Lax" })));
await context.route("**/*", (route) => { const m = route.request().method(); if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !/\/auth\/v1\/token/.test(route.request().url())) return route.abort(); return route.continue(); });
const page = await context.newPage();
await page.goto(BASE + path, { waitUntil: "load", timeout: 45000 });
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 900));
if (clickText) { await page.getByText(clickText, { exact: true }).first().click({ timeout: 5000 }).catch((e) => console.log("click fail", String(e).slice(0, 80))); await new Promise((r) => setTimeout(r, 900)); }
const res = await page.evaluate(AUDIT_FN);
const shot = process.env.SHOT; if (shot) await page.screenshot({ path: shot, fullPage: !clickText });
console.log(JSON.stringify({ path, clickText: clickText || null, engine: ENGINE, vw: res.vw, sw: res.sw, findings: res.findings.filter((f) => f.sev !== "info") }, null, 1));
await browser.close();
