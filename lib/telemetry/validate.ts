import "server-only";
import {
  WEAPON_KEYS,
  MAP_KEYS,
  EVENT_TYPES,
  END_REASONS,
  DEVICE_CLASSES,
  MAX_EVENTS_PER_FLUSH,
  MAX_PAYLOAD_BYTES,
  MAX_STRING_LEN,
} from "./budget";
import type { DimAgg, TelemetryPayload, TelemetryEvent } from "./types";

/**
 * 서버 deep validation — 공개 엔드포인트라 클라 payload 를 신뢰 0 에서 정제한다.
 * unknown key strip · key allowlist · 숫자 NaN/Infinity 방어 + clamp · string length · 이벤트 수 cap.
 * 알려진 shape 로만 재구성하므로 중첩 깊이도 자연히 bounded. (RPC 가 핵심 scalar 를 한 번 더 clamp.)
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/i;

/** PostgreSQL `integer` 범위. RPC 의 seq cast 전에 이 경계를 강제한다. */
export const POSTGRES_INT_MIN = -2_147_483_648;
export const POSTGRES_INT_MAX = 2_147_483_647;
/** 정상 게임(최대 30분)과 클라이언트 시계 오차를 넉넉히 허용하는 수신 시간 창. */
export const TELEMETRY_TIMESTAMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const TELEMETRY_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type TelemetryBodyReadResult =
  | { ok: true; text: string }
  | { ok: false; error: "bad_body" | "payload_too_large" };

export type TelemetryIngestAck = {
  ok: boolean;
  mode: "full" | "summary" | "off";
  reason?: string | null;
  lastSeq?: number | null;
};

/** A malformed resolved RPC value is dependency failure, never implicit ok. */
export function parseTelemetryIngestAck(
  value: unknown,
): TelemetryIngestAck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ack = value as Record<string, unknown>;
  if (
    typeof ack.ok !== "boolean" ||
    typeof ack.mode !== "string" ||
    !["full", "summary", "off"].includes(ack.mode) ||
    !(
      ack.reason === undefined ||
      ack.reason === null ||
      (typeof ack.reason === "string" && ack.reason.length <= 100)
    ) ||
    !(
      ack.lastSeq === undefined ||
      ack.lastSeq === null ||
      (typeof ack.lastSeq === "number" &&
        Number.isSafeInteger(ack.lastSeq) &&
        ack.lastSeq >= 0 &&
        ack.lastSeq <= POSTGRES_INT_MAX)
    )
  ) {
    return null;
  }
  return ack as TelemetryIngestAck;
}

/** Content-Length 를 숫자로 변환하지 않고 검사해 매우 큰 십진수도 안전하게 판정한다. */
export function inspectTelemetryContentLength(
  value: string | null,
): "ok" | "invalid" | "too_large" {
  if (value === null) return "ok";
  const decimal = value.trim();
  if (!/^\d+$/.test(decimal)) return "invalid";
  const normalized = decimal.replace(/^0+(?=\d)/, "");
  const limit = String(MAX_PAYLOAD_BYTES);
  if (
    normalized.length > limit.length ||
    (normalized.length === limit.length && normalized > limit)
  ) {
    return "too_large";
  }
  return "ok";
}

/**
 * 요청 body 를 64KB까지만 스트리밍해 읽고 strict UTF-8로 디코딩한다.
 * Content-Length 초과는 body를 읽기 전에, 실제 byte 초과는 다음 계층(DB/RPC) 전에 거부한다.
 */
export async function readTelemetryRequestBody(
  request: Pick<Request, "headers" | "body">,
): Promise<TelemetryBodyReadResult> {
  const declaredLength = inspectTelemetryContentLength(request.headers.get("content-length"));
  if (declaredLength === "too_large") {
    return { ok: false, error: "payload_too_large" };
  }
  if (declaredLength === "invalid") {
    return { ok: false, error: "bad_body" };
  }

  let stream: ReadableStream<Uint8Array> | null;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    stream = request.body;
    if (!stream) return { ok: true, text: "" };
    reader = stream.getReader();
  } catch {
    return { ok: false, error: "bad_body" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_PAYLOAD_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // 이미 닫힌/오류난 stream cancel 실패는 응답 판정에 영향 없음.
        }
        return { ok: false, error: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "bad_body" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 네이티브 Request stream 외의 비정상 reader도 입력 오류 응답을 덮어쓰지 않게 한다.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: "bad_body" };
  }
}

function fin(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function postgresInt(v: unknown): number | null {
  const n = fin(v);
  if (n === null || !Number.isInteger(n) || n < POSTGRES_INT_MIN || n > POSTGRES_INT_MAX) {
    return null;
  }
  return n;
}
function num(v: unknown, min: number, max: number): number {
  const n = fin(v);
  if (n === null) return min < 0 ? 0 : min;
  return Math.min(max, Math.max(min, n));
}
function boundedInt(v: unknown, min: number, max: number): number {
  return Math.round(num(v, min, max));
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
    hits: boundedInt(o.hits, 0, 1e7),
    score: boundedInt(o.score, 0, 1e9),
    attempts: boundedInt(o.attempts, 0, 1e6),
    switches: boundedInt(o.switches, 0, 1e6),
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
  const seq = postgresInt(o.seq);
  if (!type || seq === null) return null;
  const ev: TelemetryEvent = { seq, type, t: num(o.t, 0, 3.6e6) };
  // 타입별 알려진 필드만 재구성(unknown key strip)
  switch (type) {
    case "weapon_select_attempt":
    case "weapon_switch": {
      const from = str(o.from, WEAPON_KEYS);
      const to = str(o.to, WEAPON_KEYS);
      if (from) ev.from = from;
      if (to) ev.to = to;
      if (fin(o.score) !== null)
        ev.score = boundedInt(o.score, 0, 1e9);
      if (fin(o.combo) !== null)
        ev.combo = boundedInt(o.combo, 0, 1e6);
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
      ev.maxCombo = boundedInt(o.maxCombo, 0, 1e6);
      ev.apm = boundedInt(o.apm, 0, 1e5);
      ev.maxTouch = boundedInt(o.maxTouch, 0, 20);
      break;
    }
    case "combo_break":
      ev.peak = boundedInt(o.peak, 0, 1e6);
      break;
    case "ult_fire":
      ev.score = boundedInt(o.score, 0, 1e9);
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

type ParsedTimestamp = { iso: string; ms: number };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseTelemetryTimestamp(v: unknown, nowMs: number): ParsedTimestamp | null {
  if (typeof v !== "string") return null;
  const match = ISO_TIMESTAMP_RE.exec(v);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const daysInMonth =
    month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day < 1 || day > daysInMonth) return null;

  const ms = Date.parse(v);
  if (
    !Number.isFinite(ms) ||
    ms < nowMs - TELEMETRY_TIMESTAMP_MAX_AGE_MS ||
    ms > nowMs + TELEMETRY_TIMESTAMP_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return { iso: new Date(ms).toISOString(), ms };
}

/** raw(파싱된 JSON) → 정제된 payload. 형식 불량이면 null. */
export function sanitizePayload(
  raw: unknown,
  options: { nowMs?: number } = {},
): TelemetryPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
  if (!UUID_RE.test(sessionId)) return null;

  const s = (o.summary && typeof o.summary === "object" ? o.summary : {}) as Record<string, unknown>;
  const t = (s.totals && typeof s.totals === "object" ? s.totals : {}) as Record<string, unknown>;
  const m = (s.milestones && typeof s.milestones === "object" ? s.milestones : {}) as Record<string, unknown>;
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const startedAt = parseTelemetryTimestamp(o.startedAt, nowMs);
  const seqHigh = postgresInt(s.seqHigh);
  if (!startedAt || seqHigh === null || seqHigh < 0) return null;

  let endedAt: ParsedTimestamp | null = null;
  if (s.endedAt !== null && s.endedAt !== undefined) {
    endedAt = parseTelemetryTimestamp(s.endedAt, nowMs);
    if (!endedAt) return null;
  }
  if (endedAt && endedAt.ms < startedAt.ms) return null;

  const eventsRaw = Array.isArray(o.events) ? o.events.slice(0, MAX_EVENTS_PER_FLUSH) : [];
  const events: TelemetryEvent[] = [];
  for (const e of eventsRaw) {
    const ev = sanitizeEvent(e);
    if (ev) events.push(ev);
  }

  return {
    sessionId,
    deviceClass: str(o.deviceClass, DEVICE_CLASSES) ?? "other",
    startedAt: startedAt.iso,
    summary: {
      seqHigh,
      endedAt: endedAt?.iso ?? null,
      endReason: str(s.endReason, END_REASONS),
      durationMs: boundedInt(s.durationMs, 0, 3.6e6),
      startMap: str(s.startMap, MAP_KEYS),
      startWeapon: str(s.startWeapon, WEAPON_KEYS),
      totals: {
        score: boundedInt(t.score, 0, 1e9),
        hitCount: boundedInt(t.hitCount, 0, 1e7),
        maxCombo: boundedInt(t.maxCombo, 0, 1e6),
        ultFireCount: boundedInt(t.ultFireCount, 0, 1e5),
        distinctWeapons: boundedInt(
          t.distinctWeapons,
          0,
          WEAPON_KEYS.length,
        ),
        distinctMaps: boundedInt(t.distinctMaps, 0, MAP_KEYS.length),
        apm: boundedInt(t.apm, 0, 1e5),
        tapShare: num(t.tapShare, 0, 1),
        maxTouch: boundedInt(t.maxTouch, 0, 20),
        dpr: num(t.dpr, 0, 8),
        refreshHz: boundedInt(t.refreshHz, 0, 360),
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
