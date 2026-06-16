"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConsentDialog } from "@/components/ConsentDialog";
import { PhotoCropper } from "@/components/PhotoCropper";
import { ensureAuth } from "@/lib/auth-client";
import { AppNav } from "@/components/AppNav";
import { log, errInfo } from "@/lib/log";

type Stage = "consent" | "upload" | "crop" | "generating" | "pick" | "saving";

type GeneratedImage = { url: string; width: number; height: number };

type PendingRow = { id: string; kind: string; candidateUrls: string[] };
type PollResult =
  | { status: "ready"; urls: string[] }
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
          return { status: "ready", urls: g.candidateUrls };
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

function GeneratePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resumeId = searchParams.get("resume");
  const [stage, setStage] = useState<Stage>(resumeId ? "generating" : "consent");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 폴링 동시 실행 방지 — 한 번에 루프 하나만 (StrictMode 더블 + URL 동기화 재트리거
  // + 포그라운드 복귀 합쳐도). 현재 실행의 취소 토큰은 cleanup 이 그 실행만 무효화.
  const pollActiveRef = useRef(false);
  const pollAbortRef = useRef<{ cancelled: boolean } | null>(null);

  // 폴링 대상 genId — resume(URL) 우선, fresh 는 state. 리로드 시 URL 이 살아있어 이어짐.
  const activeGenId = resumeId ?? generationId;

  // 익명 세션 워밍업 (best-effort). 폴 취소는 sticky ref 가 아니라 run-token 으로 일원화.
  useEffect(() => {
    ensureAuth().catch(() => {});
  }, []);

  // 진행 중 생성 폴링 — fresh/resume 공통. ready 면 고르기 단계로 전환.
  const runPoll = useCallback(async (genId: string) => {
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
  }, []);

  // activeGenId 가 있고 생성중 단계면 폴링 시작. cleanup 은 현재 실행만 취소 + 플래그 해제
  // (StrictMode 2번째 setup 이 새 폴링을 시작할 수 있게).
  useEffect(() => {
    if (!activeGenId || stage !== "generating") return;
    // runPoll 의 setState 는 전부 await 이후라 동기 setState 아님 — 룰 오탐.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const handleFile = (f: File) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setError(null);
    setStage("crop");
  };

  const handleCropConfirm = (blob: Blob) => {
    if (preview) URL.revokeObjectURL(preview);
    const newPreview = URL.createObjectURL(blob);
    setPreview(newPreview);
    setFile(new File([blob], "cropped.jpg", { type: "image/jpeg" }));
    // crop 끝나면 바로 생성 시작
    void handleGenerate(new File([blob], "cropped.jpg", { type: "image/jpeg" }));
  };

  const handleGenerate = async (uploadFile?: File) => {
    const target = uploadFile ?? file;
    if (!target) return;
    setStage("generating");
    setError(null);
    const form = new FormData();
    form.append("image", target);
    try {
      const res = await fetch("/api/fal", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" }));
        if (err.error === "daily_limit") {
          throw new Error(
            `오늘 무료 생성 ${err.limit}회를 모두 사용했어요. 내일 0시에 다시 만들 수 있어요!`
          );
        }
        if (err.error === "service_paused") {
          throw new Error(
            "생성 요청이 많아 AI 캐릭터 만들기가 일시적으로 중단됐어요. 잠시 후 다시 시도해주세요. (기본 부장님으로는 계속 플레이할 수 있어요)"
          );
        }
        throw new Error(err.error ?? "generation_failed");
      }
      // 비동기: 제출만 됨 → fal 이 생성 중. 폴링은 [activeGenId, stage] 이펙트가 담당.
      const data = (await res.json()) as { generationId?: string };
      const genId = data.generationId;
      if (!genId) throw new Error("generation_failed");
      setGenerationId(genId);
      // URL 에 genId 기록 → 리로드/모바일 eviction 후에도 resume 플로우로 재진입(폴링 이어감).
      // history.replaceState 는 Next 라우터와 동기화돼 resumeId 가 갱신되되 라우트 전환은
      // 안 일으킨다. (전환 안 돼도 activeGenId=generationId 라 이펙트가 폴링 시작.)
      window.history.replaceState(null, "", `/generate?resume=${genId}`);
    } catch (e) {
      log.warn("gen.client_request_fail", errInfo(e));
      setError(e instanceof Error ? e.message : "알 수 없는 오류");
      setStage("upload");
    }
  };

  const handlePick = async (img: GeneratedImage) => {
    setStage("saving");
    try {
      const res = await fetch("/api/doll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: img.url, generationId }),
      });
      if (!res.ok) throw new Error("저장 실패");
      const { doll } = (await res.json()) as { doll: { id: string } };
      router.push(`/play?doll=${doll.id}`);
    } catch (e) {
      log.warn("doll.client_save_fail", { genId: generationId, ...errInfo(e) });
      setError(e instanceof Error ? e.message : "저장 실패");
      setStage("pick");
    }
  };

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col px-6 py-8">
      {stage === "consent" && <ConsentDialog onAgree={() => setStage("upload")} />}
      {stage === "upload" && (
        <UploadStage preview={preview} onFile={handleFile} error={error} />
      )}
      {stage === "crop" && preview && (
        <PhotoCropper
          imageUrl={preview}
          onConfirm={handleCropConfirm}
          onCancel={() => setStage("upload")}
        />
      )}
      {stage === "generating" && (
        <LoadingStage
          label="AI 가 인형 만드는 중…"
          sub={error ?? "보통 1분, 길면 2분까지 걸려요. 완료되면 자동으로 떠요."}
        />
      )}
      {stage === "pick" && (
        <PickStage results={results} onPick={handlePick} error={error} />
      )}
      {stage === "saving" && <LoadingStage label="저장 중…" />}
      </main>
    </>
  );
}

function UploadStage({
  preview,
  onFile,
  error,
}: {
  preview: string | null;
  onFile: (f: File) => void;
  error: string | null;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-5">
      <div className="text-center">
        <h1 className="text-3xl font-bold">사진 업로드</h1>
        <p className="mt-2 text-sm text-zinc-500">
          다음 화면에서 얼굴 영역을 직접 맞출 수 있어요.
        </p>
      </div>

      <div className="w-full rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-xs leading-relaxed">
        <p className="mb-2 font-semibold text-foreground/80">좋은 결과를 위한 팁</p>
        <ul className="space-y-1 text-zinc-500">
          <li>
            <span className="text-emerald-400">✓</span> 얼굴이 잘 보이는{" "}
            <strong className="font-semibold text-foreground/80">정면 사진</strong>
          </li>
          <li>
            <span className="text-emerald-400">✓</span> 밝은 곳에서 또렷하게 찍힌 사진
          </li>
          <li>
            <span className="text-emerald-400">✓</span> 모자·마스크는 벗고 찍으면 더
            잘 나와요 <span className="text-zinc-600">(안경은 그대로 반영돼요)</span>
          </li>
          <li>
            <span className="text-rose-400">✗</span> 옆모습·어두운·흐릿한 사진,
            여러 명이 함께 찍힌 사진은 피해주세요
          </li>
        </ul>
      </div>

      <label className="flex aspect-[3/4] w-full cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-foreground/20 bg-foreground/5 transition hover:bg-foreground/10 active:bg-foreground/15">
        {preview ? (
          // sentry-block-face: 업로드 원본 얼굴은 Session Replay 에서 차단(정책 #1/PIPA)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            data-sentry-block
            className="sentry-block-face h-full w-full object-cover"
          />
        ) : (
          <span className="text-zinc-500">탭해서 사진 선택</span>
        )}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
      </label>

      <div className="w-full space-y-1 text-center text-[11px] leading-relaxed text-zinc-500">
        <p>업로드한 원본은 인형 생성 직후 자동으로 폐기됩니다.</p>
        <p>결과가 마음에 안 들면 다시 만들 수 있어요 — 매번 조금씩 달라져요.</p>
      </div>

      {error && (
        <p className="w-full rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function PickStage({
  results,
  onPick,
  error,
}: {
  results: GeneratedImage[];
  onPick: (img: GeneratedImage) => void;
  error: string | null;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6">
      <h1 className="text-2xl font-bold">마음에 드는 인형 선택</h1>
      <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
        {results.map((img, i) => (
          <button
            key={i}
            onClick={() => onPick(img)}
            className="overflow-hidden rounded-2xl border border-foreground/10 transition hover:scale-[1.02] hover:border-foreground/40"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt="" className="aspect-square w-full object-cover" />
          </button>
        ))}
      </div>
      {error && (
        <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}

function LoadingStage({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="m-auto flex flex-col items-center gap-4 text-center">
      <div className="h-16 w-16 animate-spin rounded-full border-4 border-foreground/20 border-t-foreground" />
      <p className="text-lg font-medium">{label}</p>
      {sub && <p className="text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

export default function GeneratePage() {
  return (
    <Suspense fallback={null}>
      <GeneratePageInner />
    </Suspense>
  );
}
