"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ConsentDialog } from "@/components/ConsentDialog";
import { PhotoCropper } from "@/components/PhotoCropper";
import { ensureAuth } from "@/lib/auth-client";
import { AppNav } from "@/components/AppNav";

type Stage = "consent" | "upload" | "crop" | "generating" | "pick" | "saving";

type GeneratedImage = { url: string; width: number; height: number };

export default function GeneratePage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("consent");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ensureAuth().catch(() => {});
  }, []);

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
      const data = (await res.json()) as { images: GeneratedImage[] };
      setResults(data.images);
      setStage("pick");
    } catch (e) {
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
        body: JSON.stringify({ imageUrl: img.url }),
      });
      if (!res.ok) throw new Error("저장 실패");
      const { doll } = (await res.json()) as { doll: { id: string } };
      router.push(`/play?doll=${doll.id}`);
    } catch (e) {
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
      {stage === "generating" && <LoadingStage label="AI 가 인형 만드는 중…" sub="보통 10-20초 걸려요" />}
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
            <span className="text-emerald-400">✓</span> 안경·모자·마스크 없을 때 더
            잘 나와요
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
