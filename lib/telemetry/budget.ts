import { WEAPONS } from "@/lib/weapons";
import { BACKGROUNDS } from "@/lib/backgrounds";

/**
 * 게임플레이 텔레메트리 — 클라/서버 공용 상수 + key allowlist.
 * env 의존 없음(런타임 자동 degrade는 telemetry_budget DB row 기준). 모든 수치는 여기 한 곳에서 조정.
 */

// ── 클라 수집·전송 ──
/** 타격 집계 버킷(5초) — 한 버킷 = 한 hit_bucket 이벤트 */
export const BUCKET_MS = 5_000;
/** flush 주기(10초) — 미전송 delta 만 전송 */
export const FLUSH_INTERVAL_MS = 10_000;
/** 수집기 샘플 tick — combo peak·동시터치·경과시간 체크(render loop 밖) */
export const TICK_MS = 1_000;

// ── 용량 가드(운영 target·cap — Supabase 500MB 한계 아님) ──
/** 텔레메트리 운영 target budget. cron 이 pg_total_relation_size 로 판정해 degrade. */
export const TARGET_BUDGET_BYTES = 30 * 1024 * 1024; // 30MB
/** 하루 신규 세션 cap — 초과 시 신규 세션 summary/off degrade */
export const DAILY_NEW_SESSION_CAP = 5_000;
/** 한 flush payload 바이트 상한(서버 거부) */
export const MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB
/** 한 flush 이벤트 수 상한 */
export const MAX_EVENTS_PER_FLUSH = 200;
/** 세션 timeline 누적 이벤트 상한(초과 시 timeline_dropped, 요약만) */
export const MAX_TIMELINE_EVENTS = 2_000;
/** 세션 누적 쓰기 횟수 상한 */
export const MAX_WRITE_COUNT = 400;
/** 원시 timeline 보관 일수(이후 NULL화, 롤업만 영구) */
export const RAW_RETENTION_DAYS = 30;
/** 문자열 필드 최대 길이(deep validation) */
export const MAX_STRING_LEN = 40;
/** 이벤트 객체 최대 중첩 깊이(deep validation) */
export const MAX_OBJECT_DEPTH = 4;

// ── key allowlist(소스에서 파생 — 드리프트 방지) ──
export const WEAPON_KEYS: readonly string[] = WEAPONS.map((w) => w.key);
export const MAP_KEYS: readonly string[] = BACKGROUNDS.map((b) => b.key);
export const WEAPON_COUNT = WEAPON_KEYS.length; // 9
export const MAP_COUNT = MAP_KEYS.length; // 6

/** 디바이스 클래스 allowlist(coarse·무PII). 그 외는 'other' 로 clamp. */
export const DEVICE_CLASSES: readonly string[] = [
  "mobile-touch",
  "mobile-pointer",
  "desktop-touch",
  "desktop-pointer",
  "other",
] as const;

/** end_reason allowlist */
export const END_REASONS: readonly string[] = [
  "normal",
  "time_limit",
  "score_limit",
  "abandon",
  "reload",
  "hidden_timeout",
] as const;

/** timeline 이벤트 타입 allowlist */
export const EVENT_TYPES: readonly string[] = [
  "session_start",
  "weapon_select_attempt",
  "weapon_switch",
  "map_select_attempt",
  "map_switch",
  "hit_bucket",
  "combo_break",
  "ult_charge_ready",
  "ult_fire",
  "idle_gap",
  "session_end",
] as const;
