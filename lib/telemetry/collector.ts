import { useGameStore } from "@/store/gameStore";
import { WEAPONS } from "@/lib/weapons";
import { BUCKET_MS } from "./budget";
import type { DimAgg, TelemetryEvent, TelemetrySummary } from "./types";

/**
 * 인메모리 텔레메트리 수집기 — render loop 밖(tick/콜백)에서만 동작, 핫패스 미침투.
 * store totals(cumulative)를 5초 버킷마다 diff 해 per-weapon·per-map 집계 + 이벤트 생성(monotonic seq).
 * 익명/회원 무관하게 요약(weapon/map summary)은 항상 누적 — 서버가 익명 timeline 만 버린다.
 */

const TAP_KEYS = new Set<string>(WEAPONS.filter((w) => w.category === "tap").map((w) => w.key));
const COMBO_BREAK_MIN = 5; // 이 콤보 이상에서 끊겨야 combo_break 기록
const IDLE_GAP_MS = 2000;

function emptyAgg(): DimAgg {
  return { hits: 0, score: 0, attempts: 0, switches: 0 };
}

export class TelemetryCollector {
  readonly sessionId: string;
  readonly deviceClass: string;
  readonly startedAtIso: string;
  private readonly startMap: string;
  private readonly startWeapon: string;
  private base: number; // performance.now() at start
  private seq = 0;
  private events: TelemetryEvent[] = [];

  private mapAgg: Record<string, DimAgg> = {};
  private weaponMeta: Record<string, { attempts: number; switches: number }> = {};
  private visitedMaps = new Set<string>();

  // 현재 버킷
  private bucketMap: string;
  private bucketStart: number;
  private openHit = 0;
  private openWeaponCounts: Record<string, number> = {};
  private openWeaponScores: Record<string, number> = {};
  private bucketPeakCombo = 0;
  private bucketMaxTouch = 0;

  // 마일스톤·엣지 감지
  private firstSwitchMs: number | null = null;
  private firstUltMs: number | null = null;
  private abandonAtMs: number | null = null;
  private prevUltReady = false;
  private prevCombo = 0;
  private comboPeak = 0;
  private prevHit = 0;
  private lastHitMs = 0;
  private idleOpen = false;
  private ended = false;
  private endedMs = 0; // 종료 시점 경과(ms) — duration 동결(hidden_timeout 지연 무관)

  constructor(opts: { sessionId: string; deviceClass: string; startMap: string; startWeapon: string }) {
    this.sessionId = opts.sessionId;
    this.deviceClass = opts.deviceClass;
    this.startedAtIso = new Date().toISOString();
    this.base = performance.now();
    this.startMap = opts.startMap;
    this.startWeapon = opts.startWeapon;
    this.bucketMap = opts.startMap;
    this.bucketStart = 0;
    this.visitedMaps.add(opts.startMap);
    this.push("session_start", { startMap: opts.startMap, startWeapon: opts.startWeapon });
  }

  private now(): number {
    return Math.round(performance.now() - this.base);
  }
  private push(type: string, extra: Record<string, unknown> = {}): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, type, t: this.now(), ...extra });
  }
  private agg(rec: Record<string, DimAgg>, key: string): DimAgg {
    if (!rec[key]) rec[key] = emptyAgg();
    return rec[key];
  }

  /** TICK_MS 마다 호출(render loop 밖). 버킷 마감·콤보/궁극/idle 엣지 감지. */
  tick(): void {
    if (this.ended) return;
    const s = useGameStore.getState();
    this.bucketPeakCombo = Math.max(this.bucketPeakCombo, s.combo);
    this.comboPeak = Math.max(this.comboPeak, s.combo);

    // 궁극 충전 완료 엣지
    if (s.ultReady && !this.prevUltReady) this.push("ult_charge_ready", {});
    this.prevUltReady = s.ultReady;

    // 콤보 끊김
    if (s.combo < this.prevCombo && this.prevCombo >= COMBO_BREAK_MIN) {
      this.push("combo_break", { peak: this.comboPeak });
      this.comboPeak = s.combo;
    }
    this.prevCombo = s.combo;

    // 타격 갱신 추적(idle 감지용)
    if (s.hitCount > this.prevHit) {
      if (this.idleOpen) this.idleOpen = false;
      this.lastHitMs = this.now();
      this.prevHit = s.hitCount;
    } else if (!this.idleOpen && this.lastHitMs > 0 && this.now() - this.lastHitMs >= IDLE_GAP_MS) {
      this.push("idle_gap", { from: this.lastHitMs, to: this.now() });
      this.idleOpen = true;
    }

    if (this.now() - this.bucketStart >= BUCKET_MS) this.closeBucket();
  }

  /** 버킷 마감 — store diff 로 per-weapon delta, bucketMap 으로 per-map 귀속. */
  private closeBucket(): void {
    const s = useGameStore.getState();
    const bucketHits = Math.max(0, s.hitCount - this.openHit);
    if (bucketHits > 0) {
      const perWeapon: Record<string, DimAgg> = {};
      let bucketScore = 0;
      for (const [w, cur] of Object.entries(s.weaponCounts)) {
        const dh = cur - (this.openWeaponCounts[w] ?? 0);
        const ds = (s.weaponScores[w] ?? 0) - (this.openWeaponScores[w] ?? 0);
        if (dh > 0 || ds > 0) {
          perWeapon[w] = { hits: dh, score: ds, attempts: 0, switches: 0 };
          bucketScore += ds;
          const ma = this.agg(this.mapAgg, this.bucketMap);
          ma.hits += dh;
          ma.score += ds;
        }
      }
      const durSec = (this.now() - this.bucketStart) / 1000 || 1;
      this.push("hit_bucket", {
        dur: Math.round(this.now() - this.bucketStart),
        map: this.bucketMap,
        perWeapon,
        perMap: { [this.bucketMap]: { hits: bucketHits, score: bucketScore, attempts: 0, switches: 0 } },
        maxCombo: this.bucketPeakCombo,
        apm: Math.round(bucketHits / (durSec / 60)),
        maxTouch: this.bucketMaxTouch,
      });
    }
    this.openHit = s.hitCount;
    this.openWeaponCounts = { ...s.weaponCounts };
    this.openWeaponScores = { ...s.weaponScores };
    this.bucketStart = this.now();
    this.bucketPeakCombo = 0;
    this.bucketMaxTouch = 0;
  }

  setMaxTouch(n: number): void {
    if (n > this.bucketMaxTouch) this.bucketMaxTouch = n;
  }

  onWeaponSelect(from: string, to: string): void {
    this.push("weapon_select_attempt", { from, to });
    const wm = (this.weaponMeta[to] ??= { attempts: 0, switches: 0 });
    wm.attempts += 1;
    if (to !== from) {
      const s = useGameStore.getState();
      this.push("weapon_switch", { from, to, score: s.score, combo: s.combo });
      wm.switches += 1;
      this.firstSwitchMs ??= this.now();
    }
  }

  onMapSelect(from: string, to: string): void {
    this.closeBucket(); // 이전 맵 타격 귀속 마감
    this.push("map_select_attempt", { from, to });
    this.agg(this.mapAgg, to).attempts += 1;
    if (to !== from) {
      this.push("map_switch", { from, to });
      this.agg(this.mapAgg, to).switches += 1;
      this.firstSwitchMs ??= this.now();
      this.visitedMaps.add(to);
      this.bucketMap = to;
    }
  }

  onUltFire(score: number): void {
    this.push("ult_fire", { score });
    this.firstUltMs ??= this.now();
  }

  end(reason: string): void {
    if (this.ended) return;
    this.endedMs = this.now();
    this.closeBucket();
    this.push("session_end", { reason });
    if (reason === "abandon" || reason === "reload" || reason === "hidden_timeout") {
      this.abandonAtMs = this.now();
    }
    this.ended = true;
  }

  /** 전송용 요약 스냅샷(매 flush). store 에서 totals 읽어 latest-wins. */
  snapshot(endReason: string | null): TelemetrySummary {
    const s = useGameStore.getState();
    const weaponSummary: Record<string, DimAgg> = {};
    let totalHits = 0;
    let tapHits = 0;
    let distinctWeapons = 0;
    for (const [w, hits] of Object.entries(s.weaponCounts)) {
      const meta = this.weaponMeta[w] ?? { attempts: 0, switches: 0 };
      weaponSummary[w] = { hits, score: s.weaponScores[w] ?? 0, attempts: meta.attempts, switches: meta.switches };
      totalHits += hits;
      if (TAP_KEYS.has(w)) tapHits += hits;
      if (hits > 0) distinctWeapons += 1;
    }
    // attempts 만 있고 hits 0 인 무기(써보지도 않고 선택만)도 포함
    for (const [w, meta] of Object.entries(this.weaponMeta)) {
      if (!weaponSummary[w]) weaponSummary[w] = { hits: 0, score: 0, attempts: meta.attempts, switches: meta.switches };
    }
    // collector 자체 base 기준(store.startedAt 의존 제거 — 재시작 store 리셋과 무관). 종료 시 동결.
    const durationMs = this.ended ? this.endedMs : this.now();
    const durMin = durationMs > 0 ? durationMs / 60000 : 0;
    return {
      seqHigh: this.seq,
      endedAt: this.ended ? new Date().toISOString() : null,
      endReason,
      durationMs,
      startMap: this.startMap,
      startWeapon: this.startWeapon,
      totals: {
        score: s.score,
        hitCount: s.hitCount,
        maxCombo: s.maxCombo,
        ultFireCount: s.ultimateCount,
        distinctWeapons,
        distinctMaps: this.visitedMaps.size,
        apm: durMin > 0 ? Math.round(s.hitCount / durMin) : 0,
        tapShare: totalHits > 0 ? tapHits / totalHits : 0,
        maxTouch: this.bucketMaxTouch,
      },
      weaponSummary,
      mapSummary: this.mapAgg,
      milestones: {
        firstHitMs: s.firstHitMs,
        firstSwitchMs: this.firstSwitchMs,
        firstUltMs: this.firstUltMs,
        abandonAtMs: this.abandonAtMs,
      },
    };
  }

  /** lastAckedSeq 이후 미전송 이벤트만 */
  eventsSince(seq: number): TelemetryEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }
  get currentSeq(): number {
    return this.seq;
  }
}
