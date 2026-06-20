"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConsentDialog } from "@/components/ConsentDialog";
import { PhotoCropper } from "@/components/PhotoCropper";
import { AppNav } from "@/components/AppNav";
import { UploadStage } from "@/components/generate/UploadStage";
import { PickStage } from "@/components/generate/PickStage";
import { LoadingStage } from "@/components/generate/LoadingStage";
import { getMyProfile } from "@/lib/profile";
import { log, errInfo } from "@/lib/log";
import {
  useGenerationPolling,
  type Stage,
  type GeneratedImage,
} from "./useGenerationPolling";

function GeneratePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resumeId = searchParams.get("resume");
  const [stage, setStage] = useState<Stage>(resumeId ? "generating" : "checking");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 폴링 대상 genId — resume(URL) 우선, fresh 는 state. 리로드 시 URL 이 살아있어 이어짐.
  const activeGenId = resumeId ?? generationId;

  // 진입 가드: 생성권 확인(getMyProfile 가 세션 워밍업도 겸함). resume 은 이미 진행 중이라 스킵.
  // 멤버 & 생성권 0 확정이면 차단. 비멤버(프록시가 이미 막음)·조회 실패는 consent 로(서버가 최종 판단).
  useEffect(() => {
    if (resumeId) return;
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (cancelled) return;
        setStage(p?.isMember && p.genCredits === 0 ? "no_credits" : "consent");
      })
      .catch(() => {
        if (!cancelled) setStage("consent");
      });
    return () => {
      cancelled = true;
    };
  }, [resumeId]);

  // 진행 중 생성 폴링(fresh/resume 공통) — ready 면 고르기 단계로. 동시폴/취소/복귀 처리는 hook 내부.
  useGenerationPolling({
    activeGenId,
    stage,
    setResults,
    setGenerationId,
    setStage,
    setError,
  });

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
        if (err.error === "no_credits") {
          throw new Error(
            "무료 생성권을 모두 사용했어요. 화면 우측 아래 '의견' 버튼으로 닉네임과 함께 생성권을 요청해주세요!"
          );
        }
        if (err.error === "member_only" || err.error === "member_setup_required") {
          // 비회원/멤버화 미완 — 로그인 페이지로.
          router.push("/login?next=/generate");
          return;
        }
        if (err.error === "service_paused") {
          throw new Error(
            "생성 요청이 많아 AI 캐릭터 만들기가 일시적으로 중단됐어요. 잠시 후 다시 시도해주세요. (기본 부장님으로는 계속 플레이할 수 있어요)"
          );
        }
        throw new Error(err.error ?? "generation_failed");
      }
      // 비동기: 제출만 됨 → fal 이 생성 중. 폴링은 useGenerationPolling 이 담당.
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
      {stage === "checking" && <LoadingStage label="생성권 확인 중…" />}
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
      {stage === "no_credits" && (
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-amber-500/40 bg-amber-500/5 p-10 text-center">
          <span className="text-3xl" aria-hidden>
            🎫
          </span>
          <h2 className="text-lg font-bold">생성권을 다 썼어요</h2>
          <p className="text-sm leading-relaxed text-zinc-500">
            화면 우측 아래 &apos;의견&apos; 버튼으로 닉네임과 함께 생성권을
            요청해주세요. 확인하고 채워드릴게요!
          </p>
          <button
            type="button"
            onClick={() => router.push("/gallery")}
            className="rounded-full border border-foreground/15 px-6 py-3 text-sm font-medium transition hover:bg-foreground/5"
          >
            갤러리로 돌아가기
          </button>
        </div>
      )}
      </main>
    </>
  );
}

export default function GeneratePage() {
  return (
    <Suspense fallback={null}>
      <GeneratePageInner />
    </Suspense>
  );
}
