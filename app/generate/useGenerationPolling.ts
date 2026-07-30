"use client";

import { useCallback, useEffect, useRef } from "react";
import { ensureAuth } from "@/lib/auth-client";
import { log, errInfo } from "@/lib/log";
import type { RoleId } from "@/lib/roles";
import { pollGeneration } from "@/lib/generation-poll";

export type Stage =
  | "checking"
  | "consent"
  | "upload"
  | "crop"
  | "role-select"
  | "generating"
  | "pick"
  | "saving"
  | "no_credits";

export type GeneratedImage = { url: string; width: number; height: number };

/**
 * 진행 중 생성 폴링 — fresh/resume 공통. ready 면 고르기 단계로 전환.
 * 동시폴 방지(pollActiveRef) + run-token 취소(cleanup 이 그 실행만 무효화)로
 * StrictMode 더블 + URL 동기화 재트리거 + 포그라운드 복귀 리스너를 모두 흡수한다.
 */
export function useGenerationPolling(opts: {
  activeGenId: string | null;
  stage: Stage;
  setResults: (r: GeneratedImage[]) => void;
  setGenerationId: (id: string) => void;
  setStage: (s: Stage) => void;
  setError: (e: string | null) => void;
  /** resume/복귀 시 생성에 기록된 롤 복구 → pick 후 doll.role 정합 */
  setSelectedRole: (r: RoleId) => void;
}): void {
  const {
    activeGenId,
    stage,
    setResults,
    setGenerationId,
    setStage,
    setError,
    setSelectedRole,
  } = opts;

  // 폴링 동시 실행 방지 — 한 번에 루프 하나만 (StrictMode 더블 + URL 동기화 재트리거
  // + 포그라운드 복귀 합쳐도). 현재 실행의 취소 토큰은 cleanup 이 그 실행만 무효화.
  const pollActiveRef = useRef(false);
  const pollAbortRef = useRef<{
    cancelled: boolean;
    controller: AbortController;
  } | null>(null);

  const runPoll = useCallback(
    async (genId: string) => {
      if (pollActiveRef.current) return; // 이미 폴링 중 → 중복 금지
      pollActiveRef.current = true;
      const token = {
        cancelled: false,
        controller: new AbortController(),
      };
      pollAbortRef.current = token;
      try {
        setError(null);
        await ensureAuth();
        const result = await pollGeneration(
          genId,
          () => token.cancelled,
          { signal: token.controller.signal },
        );
        if (token.cancelled) return; // 이 실행이 무효화됨(언마운트/리셋) → setState 금지
        if (result.status === "ready") {
          setResults(result.urls.map((url) => ({ url, width: 512, height: 512 })));
          setGenerationId(genId);
          setSelectedRole(result.role); // 복귀/이어서 시 고른 롤 복구
          setStage("pick");
        } else if (result.status === "interrupted") {
          setError(
            result.reason === "photo"
              ? "사진에서 얼굴을 찾지 못했어요. 얼굴이 정면으로 또렷하게 보이는 사진으로 다시 시도해주세요."
              : "이어할 생성이 중단됐어요. 다시 만들어주세요."
          );
          setStage("upload");
        } else if (result.status === "unauthorized") {
          // 권위 상태를 읽을 수 없으므로 새 생성은 열지 않는다(중복 차감 방지).
          setError(
            "현재 세션에서 이 생성 상태를 확인할 수 없어요. 로그인 상태를 다시 확인하거나 갤러리에서 결과를 확인해 주세요.",
          );
        } else if (result.status === "unavailable") {
          setError(
            "생성 상태를 불러오지 못했어요. 새 생성은 시작하지 않았습니다. 잠시 후 다시 확인해 주세요.",
          );
        } else {
          // timeout(포그라운드 5분 초과) — 비파괴: 생성중 화면·resume URL 유지하고 안내만.
          // 복귀/대기 시 visibility 리스너가 다시 폴링. 실제 종료는 서버 interrupted(30분).
          setError("생성이 예상보다 오래 걸려요. 화면을 켜 둔 채 잠시 기다리거나 갤러리에서 확인할 수 있어요.");
        }
      } catch (e) {
        if (token.cancelled) return;
        log.warn("gen.client_poll_fail", { genId, ...errInfo(e) });
        setError(
          "이어할 생성 상태를 확인하지 못했어요. 새 생성은 시작하지 않았습니다. 잠시 후 다시 확인해 주세요.",
        );
      } finally {
        // 이 실행이 아직 현재 실행일 때만 플래그 해제(취소된 stale 실행이 새 실행을 깨지 않게).
        if (pollAbortRef.current === token) {
          pollActiveRef.current = false;
          pollAbortRef.current = null;
        }
      }
    },
    [setResults, setGenerationId, setStage, setError, setSelectedRole]
  );

  // activeGenId 가 있고 생성중 단계면 폴링 시작. cleanup 은 현재 실행만 취소 + 플래그 해제
  // (StrictMode 2번째 setup 이 새 폴링을 시작할 수 있게).
  useEffect(() => {
    if (!activeGenId || stage !== "generating") return;
    // runPoll 의 setState 는 전부 await 이후라 동기 setState 아님.
    void runPoll(activeGenId);
    return () => {
      if (pollAbortRef.current) {
        pollAbortRef.current.cancelled = true;
        pollAbortRef.current.controller.abort(
          new Error("generation_poll_inactive"),
        );
      }
      pollActiveRef.current = false;
    };
  }, [activeGenId, stage, runPoll]);

  // 포그라운드 복귀 시 폴링 재개 — 모바일 백그라운드/탭 전환/bfcache 복귀 대응.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      if (stage !== "generating" || !activeGenId || pollActiveRef.current) return;
      void runPoll(activeGenId); // 새 deadline 으로 재시작 (pollActiveRef 로 중복 차단)
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake); // iOS bfcache
    window.addEventListener("focus", onWake); // 데스크톱 탭 복귀 보조
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [activeGenId, stage, runPoll]);
}
