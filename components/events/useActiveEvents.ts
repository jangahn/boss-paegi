"use client";

import { useEffect, useState } from "react";
import type { EventType } from "@/lib/events/types";

export type ActivePopup = {
  id: string;
  type: EventType;
  title: string;
  summary: string;
  popupDismissDays: number;
};
export type ActiveBanner = { id: string; type: EventType; summary: string };
type Active = { popup: ActivePopup | null; banner: ActiveBanner | null };

// 모듈 레벨 메모 — 한 페이지 로드에서 팝업·배너 컴포넌트가 한 번만 fetch.
let cache: Promise<Active> | null = null;
function load(): Promise<Active> {
  if (!cache) {
    cache = fetch("/api/events/active")
      .then((r) => (r.ok ? (r.json() as Promise<Active>) : { popup: null, banner: null }))
      .catch(() => ({ popup: null, banner: null }));
  }
  return cache;
}

/** 활성 팝업·배너 1건씩(공개 캐시 API 기반). */
export function useActiveEvents(): Active & { loading: boolean } {
  const [state, setState] = useState<Active>({ popup: null, banner: null });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void load().then((d) => {
      if (alive) {
        setState(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return { ...state, loading };
}
