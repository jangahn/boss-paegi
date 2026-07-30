"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVE_EVENTS_FALLBACK_TTL_MS,
  activeEventsMonotonicNow,
  fetchActiveEvents,
  type ActiveEvents,
} from "@/lib/active-events-response";
import { createExpiringSharedRequest } from "@/lib/expiring-shared-request";

const EMPTY: ActiveEvents = {
  serverNow: "1970-01-01T00:00:00.000Z",
  nextTransitionAt: null,
  popup: null,
  banners: { home: null, gallery: null, leaderboard: null },
};
export const ACTIVE_EVENTS_CACHE_TTL_MS =
  ACTIVE_EVENTS_FALLBACK_TTL_MS;

// 같은 브라우저 탭의 팝업·지면별 배너는 요청과 만료 타이머를 하나만 공유한다.
// 성공 뒤 최대 30초, 또는 서버가 결속한 다음 starts_at/ends_at 경계 중
// 먼저 오는 시점에 세대를 전환한다. 경계에서는 이전 snapshot을 먼저 숨겨
// 네트워크 왕복 중에도 만료된 이벤트를 계속 노출하지 않는다.
const activeEventsRequest = createExpiringSharedRequest({
  ttlMs: ACTIVE_EVENTS_CACHE_TTL_MS,
  load: (signal) => fetchActiveEvents(fetch, signal),
  now: activeEventsMonotonicNow,
  expiresAt: (value) => value.cacheUntilMonotonic,
});

/** 활성 팝업 1건 + 지면별 배너(공개 캐시 API 기반). */
export function useActiveEvents(): ActiveEvents & {
  loading: boolean;
  error: boolean;
  retry: () => void;
} {
  const [state, setState] = useState<ActiveEvents>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestEpochRef = useRef(0);

  useEffect(() => {
    return activeEventsRequest.subscribe(() => {
      // Cache generation advances synchronously before subscribers run.
      // A prior request resolving after this point cannot update this hook.
      requestEpochRef.current += 1;
      setState(EMPTY);
      setLoading(true);
      setError(false);
      setAttempt((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    const refreshIfExpired = () => {
      activeEventsRequest.refreshIfExpired();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshIfExpired();
    };
    window.addEventListener("focus", refreshIfExpired);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshIfExpired);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    void activeEventsRequest
      .load()
      .then((d) => {
        if (requestEpochRef.current === requestEpoch) {
          setState({
            serverNow: d.serverNow,
            nextTransitionAt: d.nextTransitionAt,
            popup: d.popup,
            banners: d.banners,
          });
          setError(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (requestEpochRef.current === requestEpoch) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      if (requestEpochRef.current === requestEpoch) {
        requestEpochRef.current += 1;
      }
    };
  }, [attempt]);
  const retry = useCallback(() => {
    activeEventsRequest.refresh();
  }, []);
  return { ...state, loading, error, retry };
}
