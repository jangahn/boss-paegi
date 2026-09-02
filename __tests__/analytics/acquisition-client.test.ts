import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

// lib/acquisition 은 "use client" 모듈 — DOM 없는 node 에서 window/document/navigator/storage 셧으로 구동한다.
// 검증 대상(v1.16): ①상호작용 게이트가 큐잉만 했을 땐 중복 방지 플래그를 남기지 않고, 실제 전송 뒤에만 기록
// ②대기 중 라우트 전환으로 같은 방문이 두 번 큐잉되지 않음 ③봇 게이트가 방문 비콘과 전환 source 에 대칭 적용.

type AcquisitionModule = typeof import("../../lib/acquisition.ts");

const FT_KEY = "bp_acq_ft_v1";
const CURRENT_VISIT_KEY = "bp_visit_current_tracked_v1";
const INTERACTED_KEY = "bp_touched_v1";

class MemStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

type Listener = () => void;

type Dom = {
  sent: Record<string, unknown>[];
  localStorage: MemStorage;
  sessionStorage: MemStorage;
  /** 첫 상호작용(pointerdown) 발생 시뮬레이션 — 등록된 리스너를 호출한다. */
  interact: () => void;
};

function installDom(opts: {
  href?: string;
  referrer?: string;
  webdriver?: boolean;
  userAgent?: string;
  localStorage?: MemStorage;
} = {}): Dom {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const href = opts.href ?? "http://localhost:3000/";
  const url = new URL(href);
  const win = {
    location: { href, pathname: url.pathname, origin: url.origin, search: url.search },
    sessionStorage: new MemStorage(),
    localStorage: opts.localStorage ?? new MemStorage(),
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", win);
  define("document", { referrer: opts.referrer ?? "" });
  // sendBeacon 을 두지 않아 send() 가 fetch 폴백으로 가게 하고, body(JSON 문자열)를 그대로 캡처한다.
  define("navigator", {
    webdriver: opts.webdriver ?? false,
    userAgent: opts.userAgent ?? "Mozilla/5.0 (Macintosh; test agent)",
  });
  define("fetch", (_input: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? "null") as Record<string, unknown>);
    return Promise.resolve({ ok: true });
  });
  return {
    sent,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    interact: () => {
      for (const fn of [...(listeners.get("pointerdown") ?? [])]) fn();
    },
  };
}

let instance = 0;
/** 새 페이지 로드처럼 모듈 상태(메모리 큐·리스너 armed)를 비운 fresh 인스턴스. 쿼리스트링으로 모듈 캐시를 우회한다. */
async function freshModule(): Promise<AcquisitionModule> {
  const url = new URL("../../lib/acquisition.ts", import.meta.url);
  url.searchParams.set("instance", String(++instance));
  return (await import(url.href)) as AcquisitionModule;
}

function storedFirstTouch(dom: Dom): { acquisitionVisitSent?: boolean; playConversionSent?: boolean; source: { source_kind: string } } | null {
  const raw = dom.localStorage.getItem(FT_KEY);
  return raw ? JSON.parse(raw) : null;
}

test("visit flags are recorded only after the queued beacon is actually sent", async () => {
  const dom = installDom();
  const acq = await freshModule();

  acq.trackVisit("/");
  assert.equal(dom.sent.length, 0, "상호작용 전엔 전송 없음(큐잉)");
  assert.equal(dom.sessionStorage.getItem(CURRENT_VISIT_KEY), null, "current 플래그는 큐잉만으론 미기록");
  const before = storedFirstTouch(dom);
  assert.ok(before, "first-touch 는 생성됨");
  assert.notEqual(before?.acquisitionVisitSent, true, "first-touch 방문 플래그는 큐잉만으론 미기록");

  dom.interact();
  assert.deepEqual(
    dom.sent.map((e) => [e.kind, e.source_scope, e.landing, e.source_kind]),
    [
      ["visit", "current", "home", "direct"],
      ["visit", "first_touch", "home", "direct"],
    ],
  );
  assert.equal(dom.sessionStorage.getItem(INTERACTED_KEY), "1");
  assert.equal(dom.sessionStorage.getItem(CURRENT_VISIT_KEY), "1", "current 플래그는 전송 뒤 기록");
  assert.equal(storedFirstTouch(dom)?.acquisitionVisitSent, true, "first-touch 플래그는 전송 뒤 기록");
});

test("route changes while queued do not enqueue the same visit twice", async () => {
  const dom = installDom();
  const acq = await freshModule();

  acq.trackVisit("/");
  acq.trackVisit("/play");
  acq.trackVisit("/gallery");
  dom.interact();

  assert.equal(dom.sent.length, 2, "current 1 + first_touch 1 — 라우트 전환으로 중복 큐잉되지 않음");
  assert.deepEqual(dom.sent.map((e) => e.landing), ["home", "home"], "landing 은 실제 진입 페이지");
});

test("a browser that left before interacting gets its first-touch visit recorded on the next session", async () => {
  const persisted = new MemStorage(); // localStorage 는 브라우저에 남고, 메모리 큐·sessionStorage 는 사라진다
  const first = installDom({ localStorage: persisted, referrer: "https://m.search.naver.com/" });
  const acq1 = await freshModule();
  acq1.trackVisit("/");
  assert.equal(first.sent.length, 0);
  assert.notEqual(storedFirstTouch(first)?.acquisitionVisitSent, true, "떠날 때 플래그가 남아 있지 않아야 재시도 가능");

  // 다음 날 재방문: 새 페이지 로드(fresh 모듈) + 새 탭세션, 이번엔 직접 진입 후 상호작용.
  const second = installDom({ localStorage: persisted });
  const acq2 = await freshModule();
  acq2.trackVisit("/gallery");
  second.interact();

  assert.deepEqual(
    second.sent.map((e) => [e.kind, e.source_scope, e.source_kind, e.referrer_domain ?? null, e.landing]),
    [
      ["visit", "current", "direct", null, "gallery"],
      ["visit", "first_touch", "referrer", "m.search.naver.com", "gallery"],
    ],
    "first-touch 방문은 원래 획득 source(첫 방문의 referrer)로 뒤늦게 기록된다",
  );
  assert.equal(storedFirstTouch(second)?.acquisitionVisitSent, true);
});

test("an already-interacted tab session sends immediately and flags immediately", async () => {
  const dom = installDom();
  dom.sessionStorage.setItem(INTERACTED_KEY, "1");
  const acq = await freshModule();

  acq.trackVisit("/play");
  assert.equal(dom.sent.length, 2);
  assert.equal(dom.sessionStorage.getItem(CURRENT_VISIT_KEY), "1");
  assert.equal(storedFirstTouch(dom)?.acquisitionVisitSent, true);

  acq.trackVisit("/badges");
  assert.equal(dom.sent.length, 2, "탭세션·first-touch 모두 1회 — 재전송 없음");
});

test("bot gate is symmetric: automation sends neither visit beacons nor conversion sources", async () => {
  for (const bot of [{ webdriver: true }, { userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }]) {
    const dom = installDom(bot);
    const acq = await freshModule();
    acq.trackVisit("/play");
    dom.interact();
    assert.equal(dom.sent.length, 0, `방문 비콘 없음: ${JSON.stringify(bot)}`);
    assert.equal(acq.shouldSendPlayConversion(), false, `플레이 전환 게이트 닫힘: ${JSON.stringify(bot)}`);
    assert.equal(acq.firstTouchSourceForConversion(), null, `전환 source 미동봉: ${JSON.stringify(bot)}`);
  }

  const human = installDom({ href: "http://localhost:3000/play?utm_source=insta_bio" });
  const acq = await freshModule();
  assert.equal(acq.shouldSendPlayConversion(), true);
  assert.deepEqual(acq.firstTouchSourceForConversion(), {
    source_kind: "utm",
    utm_source: "insta_bio",
    referrer_domain: null,
    viral_type: null,
  });
  acq.markPlayConversionSent();
  assert.equal(acq.shouldSendPlayConversion(), false, "first-touch 당 1회");
  assert.equal(storedFirstTouch(human)?.playConversionSent, true);
});
