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

export type TelemetryApi = {
  /** 세션 시작(마운트·재시작 시) — 새 collector/transport. */
  startSession: (startMap: string, startWeapon: string) => void;
  onWeaponSelect: (from: string, to: string) => void;
  onMapSelect: (from: string, to: string) => void;
  onUltFire: (score: number) => void;
  /** 정상/강제 종료 — end_reason 동결 + 최종 flush. */
  endSession: (reason: string) => void;
};

/**
 * 게임플레이 텔레메트리 hook — render loop 밖(tick/flush interval + 콜백)에서만 동작.
 * 핫패스 미침투(타격마다가 아니라 5초 버킷·10초 flush). 이탈은 pagehide/hidden 으로 sendBeacon.
 */
export function useTelemetry(): TelemetryApi {
  const colRef = useRef<TelemetryCollector | null>(null);
  const txRef = useRef<TelemetryTransport | null>(null);
  const pointers = useRef<Set<number>>(new Set());

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

    const down = (e: PointerEvent) => pointers.current.add(e.pointerId);
    const up = (e: PointerEvent) => pointers.current.delete(e.pointerId);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);

    let hiddenTimer: number | null = null;
    const finalize = (reason: string) => {
      const c = colRef.current;
      const tx = txRef.current;
      if (c && tx) {
        c.end(reason);
        tx.beacon(reason);
        colRef.current = null;
        txRef.current = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") {
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
        const c = new TelemetryCollector({
          sessionId,
          deviceClass: detectDeviceClass(),
          startMap,
          startWeapon,
        });
        colRef.current = c;
        txRef.current = new TelemetryTransport(c);
      },
      onWeaponSelect: (from, to) => colRef.current?.onWeaponSelect(from, to),
      onMapSelect: (from, to) => colRef.current?.onMapSelect(from, to),
      onUltFire: (score) => colRef.current?.onUltFire(score),
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
