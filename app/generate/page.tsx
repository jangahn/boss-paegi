"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConsentDialog } from "@/components/ConsentDialog";
import { PhotoCropper } from "@/components/PhotoCropper";
import { UploadStage } from "@/components/generate/UploadStage";
import { PickStage } from "@/components/generate/PickStage";
import { LoadingStage } from "@/components/generate/LoadingStage";
import { RoleSelectStage } from "@/components/generate/RoleSelectStage";
import { getMyProfile } from "@/lib/profile";
import { setSentryGenStage, setSentryLastAction } from "@/lib/sentry-context";
import { type RoleId } from "@/lib/roles";
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
  const [selectedRole, setSelectedRole] = useState<RoleId>("boss");
  const [error, setError] = useState<string | null>(null);

  // 폴링 대상 genId — resume(URL) 우선, fresh 는 state. 리로드 시 URL 이 살아있어 이어짐.
  const activeGenId = resumeId ?? generationId;

  // 진입 가드: 생성권 확인(getMyProfile 가 세션 워밍업도 겸함). resume 은 이미 진행 중이라 스킵.
  // **법적 동의는 서버 proxy 가 렌더 전 게이트** → 여기 도달 = 로그인+동의완료. 생성권 0 만 차단,
  // 그 외는 photo 동의 단계("consent" = ConsentDialog). 조회 실패도 동의 단계(서버가 최종 판단).
  useEffect(() => {
    if (resumeId) return;
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (cancelled) return;
        setStage(p?.isLoggedIn && p.genCredits === 0 ? "no_credits" : "consent");
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
    setSelectedRole,
  });

  // 생성 퍼널 단계 태그(이탈 추적) — Sentry 저카디널리티 태그 + breadcrumb.
  useEffect(() => {
    setSentryGenStage(stage);
  }, [stage]);

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
    // crop 끝나면 롤 선택 단계로 (롤 확정 후 생성 — 고른 롤이 프롬프트·doll.role 에 반영)
    setStage("role-select");
  };

  const handleGenerate = async (uploadFile?: File, role: RoleId = selectedRole) => {
    const target = uploadFile ?? file;
    if (!target) return;
    setSentryLastAction("generate");
    setStage("generating");
    setError(null);
    const form = new FormData();
    form.append("image", target);
    form.append("role", role);
    try {
      const res = await fetch("/api/fal", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" }));
        if (err.error === "no_credits") {
          // 진입 후 크레딧 소진(드문 레이스) — 충전 화면으로.
          router.push("/credits");
          return;
        }
        if (err.error === "member_only") {
          // 비회원 — 로그인 페이지로.
          router.push("/login?next=/generate");
          return;
        }
        if (err.error === "consent_required") {
          // 동의 미완(in-between/레거시/구버전) — 통합 동의 화면으로.
          router.push("/consent?next=/generate");
          return;
        }
        if (err.error === "service_paused") {
          throw new Error(
            "생성 요청이 많아 AI 캐릭터 만들기가 일시적으로 중단됐어요. 잠시 후 다시 시도해주세요. (기본 부장님으로는 계속 플레이할 수 있어요)"
          );
        }
        if (err.error === "no_face") {
          // 제출 전 얼굴 게이트(차감 없음) — 다른 사진으로 즉시 재시도 안내.
          throw new Error(
            "사진에서 얼굴을 찾지 못했어요. 얼굴이 정면으로 또렷하게 보이는 사진으로 다시 시도해주세요."
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
        body: JSON.stringify({ imageUrl: img.url, generationId, role: selectedRole }),
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
      {stage === "role-select" && (
        <RoleSelectStage
          initialRole={selectedRole}
          onConfirm={(role) => {
            setSelectedRole(role);
            void handleGenerate(undefined, role);
          }}
        />
      )}
      {stage === "generating" && (
        <LoadingStage
          label="AI 가 캐릭터 만드는 중…"
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
            생성권을 충전하면 바로 캐릭터를 만들 수 있어요.
          </p>
          <button
            type="button"
            onClick={() => router.push("/credits")}
            className="rounded-full bg-foreground px-6 py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90"
          >
            생성권 충전하기
          </button>
          <button
            type="button"
            onClick={() => router.push("/gallery")}
            className="text-sm text-zinc-500 underline"
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
