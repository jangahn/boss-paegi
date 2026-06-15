"use client";

import { Suspense, useEffect, useRef, useState } from "react";
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
  | { status: "timeout" };

/**
 * 비동기 생성 폴링 — generationId 가 ready(후보 확보) 될 때까지 /api/generations 확인.
 * 생성은 fal 에서 진행되고 /api/generations 의 복구가 완료분을 채운다. 최대 3분.
 */
async function pollGeneration(
  genId: string,
  isCancelled: () => boolean
): Promise<PollResult> {
  const deadline = Date.now() + 3 * 60_000;
  while (!isCancelled()) {
    try {
      const res = await fetch("/api/generations");
      if (res.ok) {
        const { pending } = (await res.json()) as { pending: PendingRow[] };
        const g = pending.find((p) => p.id === genId);
        if (g?.kind === "ready" && g.candidateUrls.length > 0) {
          return { status: "ready", urls: g.candidateUrls };
        }
        if (g?.kind === "interrupted") return { status: "interrupted" };
        // generating / 아직 목록에 없음 → 계속 폴링
      }
    } catch {
      /* 일시 오류 — 계속 폴링 */
    }
    if (Date.now() > deadline) return { status: "timeout" };
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
  // 언마운트 시 진행 중 폴링 중단용
  const unmountedRef = useRef(false);

  useEffect(() => {
    ensureAuth().catch(() => {});
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // ?resume=genId 진입 — 생성중이면 폴링, ready 면 후보를 불러와 고르기 단계로
  useEffect(() => {
    if (!resumeId) return;
    let cancelled = false;
    (async () => {
      try {
        await ensureAuth();
        const result = await pollGeneration(
          resumeId,
          () => cancelled || unmountedRef.current
        );
        if (cancelled || unmountedRef.current) return;
        if (result.status === "ready") {
          setResults(result.urls.map((url) => ({ url, width: 512, height: 512 })));
          setGenerationId(resumeId);
          setStage("pick");
        } else if (result.status === "interrupted") {
          setError("이어할 생성이 중단됐어요. 다시 만들어주세요.");
          setStage("upload");
        } else {
          setError("생성이 오래 걸리고 있어요. 잠시 후 갤러리에서 확인해주세요.");
          setStage("upload");
        }
      } catch (e) {
        log.warn("gen.client_resume_fail", { genId: resumeId, ...errInfo(e) });
        if (!cancelled && !unmountedRef.current) {
          setError("이어할 생성을 불러오지 못했어요. 다시 만들어주세요.");
          setStage("upload");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeId]);

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
      // 비동기: 제출만 됨 → fal 이 생성 중. generationId 로 완성될 때까지 폴링.
      const data = (await res.json()) as { generationId?: string };
      const genId = data.generationId;
      if (!genId) throw new Error("generation_failed");
      setGenerationId(genId);

      const result = await pollGeneration(genId, () => unmountedRef.current);
      if (unmountedRef.current) return;
      if (result.status === "ready") {
        setResults(result.urls.map((url) => ({ url, width: 512, height: 512 })));
        setStage("pick");
      } else if (result.status === "interrupted") {
        throw new Error("생성이 중단됐어요. 다시 시도해주세요.");
      } else {
        // timeout — 생성은 백그라운드에서 계속, 갤러리에서 이어볼 수 있음
        setError(
          "생성이 예상보다 오래 걸려요. 잠시 후 갤러리에서 확인할 수 있어요. (기본 부장님으로는 바로 플레이 가능)"
        );
        setStage("upload");
      }
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
      {stage === "generating" && <LoadingStage label="AI 가 인형 만드는 중…" sub="보통 1분, 길면 2분까지 걸려요. 완료되면 자동으로 떠요." />}
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
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
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
