"use client";

import { useCallback, useEffect, useRef } from "react";
import { ensureAuth } from "@/lib/auth-client";
import { log, errInfo } from "@/lib/log";
import { asRole, type RoleId } from "@/lib/roles";

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

type PendingRow = { id: string; kind: string; candidateUrls: string[]; role?: string };
type PollResult =
  | { status: "ready"; urls: string[]; role: RoleId }
  | { status: "interrupted" }
  | { status: "unauthorized" }
  | { status: "timeout" };

/**
 * 비동기 생성 폴링 — generationId 가 ready(후보 확보) 될 때까지 /api/generations 확인.
 * 생성은 fal 에서 진행되고 /api/generations 의 복구가 완료분을 채운다.
 *
 * deadline 은 **포그라운드 누적 시간**(탭이 visible 일 때만 가산) 5분 상한 —
 * 백그라운드(앱 전환) 시간은 안 세므로, 복귀 즉시 timeout 으로 떨어지지 않는다.
 * 이 상한은 안전망(genId 가 끝내 안 뜨고 interrupted 도 아닌 실패 row 대비)이고,
 * 실제 종료는 ready/서버 interrupted(30분)다. timeout 은 비파괴로 처리(호출부 참고).
 */
async function pollGeneration(
  genId: string,
  isCancelled: () => boolean
): Promise<PollResult> {
  const MAX_VISIBLE_MS = 5 * 60_000;
  let visibleElapsed = 0;
  let lastTick = Date.now();
  let consecutive401 = 0;
  const accrue = () => {
    const now = Date.now();
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      visibleElapsed += now - lastTick;
    }
    lastTick = now;
  };

  while (!isCancelled()) {
    accrue();
    try {
      const res = await fetch("/api/generations");
      if (res.ok) {
        consecutive401 = 0;
        const { pending } = (await res.json()) as { pending: PendingRow[] };
        const g = pending.find((p) => p.id === genId);
        if (g?.kind === "ready" && g.candidateUrls.length > 0) {
          return { status: "ready", urls: g.candidateUrls, role: asRole(g.role) };
        }
        if (g?.kind === "interrupted") return { status: "interrupted" };
        // generating / 아직 목록에 없음 → 계속 폴링
      } else if (res.status === 401) {
        // 세션 없음/다른 익명 세션 — 쿠키 지연일 수 있어 몇 번 관용 후 종료(무한 폴 방지).
        if (++consecutive401 >= 4) return { status: "unauthorized" };
      }
    } catch {
      /* 일시 오류 — 계속 폴링 */
    }
    accrue();
    if (visibleElapsed > MAX_VISIBLE_MS) return { status: "timeout" };
    await new Promise((r) => setTimeout(r, 3500));
  }
  return { status: "timeout" };
}

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
  setError: (e: string) => void;
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
  const pollAbortRef = useRef<{ cancelled: boolean } | null>(null);

  const runPoll = useCallback(
    async (genId: string) => {
      if (pollActiveRef.current) return; // 이미 폴링 중 → 중복 금지
      pollActiveRef.current = true;
      const token = { cancelled: false };
      pollAbortRef.current = token;
      try {
        await ensureAuth();
        const result = await pollGeneration(genId, () => token.cancelled);
        if (token.cancelled) return; // 이 실행이 무효화됨(언마운트/리셋) → setState 금지
        if (result.status === "ready") {
          setResults(result.urls.map((url) => ({ url, width: 512, height: 512 })));
          setGenerationId(genId);
          setSelectedRole(result.role); // 복귀/이어서 시 고른 롤 복구
          setStage("pick");
        } else if (result.status === "interrupted") {
          setError("이어할 생성이 중단됐어요. 다시 만들어주세요.");
          setStage("upload");
        } else if (result.status === "unauthorized") {
          setError("다른 기기/세션에서 시작한 생성은 이어볼 수 없어요. 갤러리에서 확인해주세요.");
          setStage("upload");
        } else {
          // timeout(포그라운드 5분 초과) — 비파괴: 생성중 화면·resume URL 유지하고 안내만.
          // 복귀/대기 시 visibility 리스너가 다시 폴링. 실제 종료는 서버 interrupted(30분).
          setError("생성이 예상보다 오래 걸려요. 화면을 켜 둔 채 잠시 기다리거나 갤러리에서 확인할 수 있어요.");
        }
      } catch (e) {
        if (token.cancelled) return;
        log.warn("gen.client_poll_fail", { genId, ...errInfo(e) });
        setError("이어할 생성을 불러오지 못했어요. 다시 만들어주세요.");
        setStage("upload");
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
      if (pollAbortRef.current) pollAbortRef.current.cancelled = true;
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
