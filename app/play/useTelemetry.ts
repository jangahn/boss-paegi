"use client";

import { useEffect, useMemo, useRef } from "react";
import { TelemetryCollector } from "@/lib/telemetry/collector";
import { TelemetryTransport } from "@/lib/telemetry/transport";
import { FLUSH_INTERVAL_MS, TICK_MS, DEVICE_CLASSES } from "@/lib/telemetry/budget";

const HIDDEN_TIMEOUT_MS = 30_000;

function detectDeviceClass(): string {
  if (typeof window === "undefined") return "other";
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const touch = (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window;
  const mobile = window.matchMedia?.("(max-width: 820px)")?.matches ?? false;
  const cls = `${mobile ? "mobile" : "desktop"}-${touch || coarse ? "touch" : "pointer"}`;
  return DEVICE_CLASSES.includes(cls) ? cls : "other";
}

export type PerfStats = {
  dpr: number;
  refreshHz: number;
  avgFrameMs: number;
  p95FrameMs: number;
};

export type TelemetryApi = {
  /** 세션 시작(마운트·재시작 시) — 새 collector/transport. */
  startSession: (startMap: string, startWeapon: string) => void;
  onWeaponSelect: (from: string, to: string) => void;
  onMapSelect: (from: string, to: string) => void;
  onUltFire: (score: number) => void;
  /** 종료 직전 — 게임 ticker 프레임타임 통계(렉 진단) 주입. */
  setPerf: (p: PerfStats) => void;
  /**
   * perf 소스 등록 — abandon/visibility 종료(finalize)는 게임오버 핸들러를 안 거치므로
   * 여기 등록된 getter 로 종료 직전 perf 를 직접 캡처(안 하면 이탈 세션 perf 유실).
   */
  registerPerfSource: (getPerf: () => PerfStats | null) => void;
  /** 정상/강제 종료 — end_reason 동결 + 최종 flush. */
  endSession: (reason: string) => void;
  /** 현재(또는 직전 종료된) 세션 id — 점수 제출 시 scores.telemetry_session_id 링크용. */
  getSessionId: () => string | null;
};

/**
 * 게임플레이 텔레메트리 hook — render loop 밖(tick/flush interval + 콜백)에서만 동작.
 * 핫패스 미침투(타격마다가 아니라 5초 버킷·10초 flush). 이탈은 pagehide/hidden 으로 sendBeacon.
 */
export function useTelemetry(): TelemetryApi {
  const colRef = useRef<TelemetryCollector | null>(null);
  const txRef = useRef<TelemetryTransport | null>(null);
  const lastSessionIdRef = useRef<string | null>(null); // 종료 후에도 유지(점수 링크용)
  const pointers = useRef<Set<number>>(new Set());
  const perfSourceRef = useRef<(() => PerfStats | null) | null>(null);

  useEffect(() => {
    const tickId = window.setInterval(() => {
      const c = colRef.current;
      if (c) {
        c.setMaxTouch(pointers.current.size);
        c.tick();
      }
    }, TICK_MS);
    const flushId = window.setInterval(() => {
      void txRef.current?.flush(null);
    }, FLUSH_INTERVAL_MS);

    // 동시터치 피크는 항상 pointer 가 추가되는 순간 발생 — down 에서 즉시 측정해야
    // 1초 미만 짧은 동시탭도 놓치지 않는다(tick 샘플링만으론 aliasing). Set 이라 중복 add 무해.
    const down = (e: PointerEvent) => {
      pointers.current.add(e.pointerId);
      colRef.current?.setMaxTouch(pointers.current.size);
    };
    const up = (e: PointerEvent) => pointers.current.delete(e.pointerId);
    // 포인터 누락(release/cancel 미수신) 시 stale 누적으로 과대측정되지 않게 전부 비운다.
    const clearPointers = () => pointers.current.clear();
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("lostpointercapture", up);
    window.addEventListener("blur", clearPointers);

    let hiddenTimer: number | null = null;
    const finalize = (reason: string) => {
      const c = colRef.current;
      const tx = txRef.current;
      if (c && tx) {
        // 이탈 종료(abandon/hidden_timeout)도 perf 캡처 — 게임오버 핸들러 미경유라 여기서 직접.
        //   실프레임 표본 있을 때만(avg>0) 기록 → 무플레이/즉시이탈 0 오염 방지.
        const perf = perfSourceRef.current?.();
        if (perf && perf.avgFrameMs > 0) c.setPerf(perf);
        c.end(reason);
        tx.beacon(reason);
        colRef.current = null;
        txRef.current = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        clearPointers(); // 백그라운드 전환 시 release 이벤트가 안 와 stale 남는 것 방지
        void txRef.current?.flush(null);
        hiddenTimer = window.setTimeout(() => finalize("hidden_timeout"), HIDDEN_TIMEOUT_MS);
      } else if (hiddenTimer) {
        window.clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
    };
    const onHide = () => finalize("abandon");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);

    return () => {
      window.clearInterval(tickId);
      window.clearInterval(flushId);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("lostpointercapture", up);
      window.removeEventListener("blur", clearPointers);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      if (hiddenTimer) window.clearTimeout(hiddenTimer);
    };
  }, []);

  return useMemo<TelemetryApi>(
    () => ({
      startSession: (startMap, startWeapon) => {
        const sessionId =
          typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : null;
        if (!sessionId) return; // 구형 환경 — 계측 생략(게임 무영향)
        pointers.current.clear(); // 새 세션 — 이전 세션 잔여 포인터 제거
        const c = new TelemetryCollector({
          sessionId,
          deviceClass: detectDeviceClass(),
          startMap,
          startWeapon,
        });
        colRef.current = c;
        txRef.current = new TelemetryTransport(c);
        lastSessionIdRef.current = sessionId;
      },
      getSessionId: () => lastSessionIdRef.current,
      onWeaponSelect: (from, to) => colRef.current?.onWeaponSelect(from, to),
      onMapSelect: (from, to) => colRef.current?.onMapSelect(from, to),
      onUltFire: (score) => colRef.current?.onUltFire(score),
      setPerf: (p) => colRef.current?.setPerf(p),
      registerPerfSource: (getPerf) => {
        perfSourceRef.current = getPerf;
      },
      endSession: (reason) => {
        const c = colRef.current;
        const tx = txRef.current;
        if (c && tx) {
          c.end(reason);
          void tx.flush(reason, { force: true });
          colRef.current = null;
          txRef.current = null;
        }
      },
    }),
    []
  );
}
