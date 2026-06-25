import "server-only";
import {
  WEAPON_KEYS,
  MAP_KEYS,
  EVENT_TYPES,
  END_REASONS,
  DEVICE_CLASSES,
  MAX_EVENTS_PER_FLUSH,
  MAX_STRING_LEN,
} from "./budget";
import type { DimAgg, TelemetryPayload, TelemetryEvent } from "./types";

/**
 * 서버 deep validation — 공개 엔드포인트라 클라 payload 를 신뢰 0 에서 정제한다.
 * unknown key strip · key allowlist · 숫자 NaN/Infinity 방어 + clamp · string length · 이벤트 수 cap.
 * 알려진 shape 로만 재구성하므로 중첩 깊이도 자연히 bounded. (RPC 가 핵심 scalar 를 한 번 더 clamp.)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fin(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function num(v: unknown, min: number, max: number): number {
  const n = fin(v);
  if (n === null) return min < 0 ? 0 : min;
  return Math.min(max, Math.max(min, n));
}
function intOrNull(v: unknown, min: number, max: number): number | null {
  const n = fin(v);
  if (n === null) return null;
  return Math.round(Math.min(max, Math.max(min, n)));
}
function str(v: unknown, allow: readonly string[] | null): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, MAX_STRING_LEN);
  if (allow && !allow.includes(s)) return null;
  return s;
}

function dimAgg(v: unknown): DimAgg {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    hits: num(o.hits, 0, 1e7),
    score: num(o.score, 0, 1e9),
    attempts: num(o.attempts, 0, 1e6),
    switches: num(o.switches, 0, 1e6),
  };
}
function dimMap(v: unknown, keys: readonly string[]): Record<string, DimAgg> {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: Record<string, DimAgg> = {};
  for (const k of keys) if (k in o) out[k] = dimAgg(o[k]);
  return out;
}

function sanitizeEvent(v: unknown): TelemetryEvent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const type = str(o.type, EVENT_TYPES);
  const seq = fin(o.seq);
  if (!type || seq === null) return null;
  const ev: TelemetryEvent = { seq: Math.round(seq), type, t: num(o.t, 0, 3.6e6) };
  // 타입별 알려진 필드만 재구성(unknown key strip)
  switch (type) {
    case "weapon_select_attempt":
    case "weapon_switch": {
      const from = str(o.from, WEAPON_KEYS);
      const to = str(o.to, WEAPON_KEYS);
      if (from) ev.from = from;
      if (to) ev.to = to;
      if (fin(o.score) !== null) ev.score = num(o.score, 0, 1e9);
      if (fin(o.combo) !== null) ev.combo = num(o.combo, 0, 1e6);
      break;
    }
    case "map_select_attempt":
    case "map_switch": {
      const from = str(o.from, MAP_KEYS);
      const to = str(o.to, MAP_KEYS);
      if (from) ev.from = from;
      if (to) ev.to = to;
      break;
    }
    case "hit_bucket": {
      ev.dur = num(o.dur, 0, 6e4);
      ev.map = str(o.map, MAP_KEYS) ?? "";
      ev.perWeapon = dimMap(o.perWeapon, WEAPON_KEYS);
      ev.perMap = dimMap(o.perMap, MAP_KEYS);
      ev.maxCombo = num(o.maxCombo, 0, 1e6);
      ev.apm = num(o.apm, 0, 1e5);
      ev.maxTouch = num(o.maxTouch, 0, 20);
      break;
    }
    case "combo_break":
      ev.peak = num(o.peak, 0, 1e6);
      break;
    case "ult_fire":
      ev.score = num(o.score, 0, 1e9);
      break;
    case "idle_gap":
      ev.from = num(o.from, 0, 3.6e6);
      ev.to = num(o.to, 0, 3.6e6);
      break;
    case "session_end": {
      const r = str(o.reason, END_REASONS);
      if (r) ev.reason = r;
      break;
    }
    // session_start / ult_charge_ready : seq/type/t 만
  }
  return ev;
}

/** raw(파싱된 JSON) → 정제된 payload. 형식 불량이면 null. */
export function sanitizePayload(raw: unknown): TelemetryPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
  if (!UUID_RE.test(sessionId)) return null;

  const s = (o.summary && typeof o.summary === "object" ? o.summary : {}) as Record<string, unknown>;
  const t = (s.totals && typeof s.totals === "object" ? s.totals : {}) as Record<string, unknown>;
  const m = (s.milestones && typeof s.milestones === "object" ? s.milestones : {}) as Record<string, unknown>;

  const eventsRaw = Array.isArray(o.events) ? o.events.slice(0, MAX_EVENTS_PER_FLUSH) : [];
  const events: TelemetryEvent[] = [];
  for (const e of eventsRaw) {
    const ev = sanitizeEvent(e);
    if (ev) events.push(ev);
  }

  return {
    sessionId,
    deviceClass: str(o.deviceClass, DEVICE_CLASSES) ?? "other",
    startedAt: typeof o.startedAt === "string" ? o.startedAt.slice(0, 40) : "",
    summary: {
      seqHigh: Math.round(num(s.seqHigh, 0, 1e9)),
      endedAt: typeof s.endedAt === "string" ? s.endedAt.slice(0, 40) : null,
      endReason: str(s.endReason, END_REASONS),
      durationMs: num(s.durationMs, 0, 3.6e6),
      startMap: str(s.startMap, MAP_KEYS),
      startWeapon: str(s.startWeapon, WEAPON_KEYS),
      totals: {
        score: num(t.score, 0, 1e9),
        hitCount: num(t.hitCount, 0, 1e7),
        maxCombo: num(t.maxCombo, 0, 1e6),
        ultFireCount: num(t.ultFireCount, 0, 1e5),
        distinctWeapons: num(t.distinctWeapons, 0, WEAPON_KEYS.length),
        distinctMaps: num(t.distinctMaps, 0, MAP_KEYS.length),
        apm: num(t.apm, 0, 1e5),
        tapShare: num(t.tapShare, 0, 1),
        maxTouch: num(t.maxTouch, 0, 20),
        dpr: num(t.dpr, 0, 8),
        refreshHz: num(t.refreshHz, 0, 360),
        avgFrameMs: num(t.avgFrameMs, 0, 10000),
        p95FrameMs: num(t.p95FrameMs, 0, 10000),
      },
      weaponSummary: dimMap(s.weaponSummary, WEAPON_KEYS),
      mapSummary: dimMap(s.mapSummary, MAP_KEYS),
      milestones: {
        firstHitMs: intOrNull(m.firstHitMs, 0, 3.6e6),
        firstSwitchMs: intOrNull(m.firstSwitchMs, 0, 3.6e6),
        firstUltMs: intOrNull(m.firstUltMs, 0, 3.6e6),
        abandonAtMs: intOrNull(m.abandonAtMs, 0, 3.6e6),
      },
    },
    events,
  };
}
