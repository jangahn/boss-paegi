"use client";

import { useState } from "react";
import type { GeneratedImage } from "@/app/generate/useGenerationPolling";
import { PaperPanel, DashedDivider } from "@/components/dossier";

/**
 * 생성 후보 선택 — 1~2분 유료 생성 직후라 이미지 로드 전 "빈 카드" 인상 방지.
 * 각 후보는 로드 전 pulse placeholder → onLoad 시 fade-in (갤러리 DollCard 패턴).
 */
export function PickStage({
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
      <PaperPanel className="w-full px-5 py-6 sm:px-7 sm:py-7">
        <h1 className="text-center font-display text-2xl tracking-tight text-ink sm:text-3xl">
          마음에 드는 인형 선택
        </h1>
        <DashedDivider className="my-5" />
        <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
          {results.map((img, i) => (
            <PickCandidate key={i} img={img} onPick={onPick} />
          ))}
        </div>
      </PaperPanel>
      {error && (
        <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}

function PickCandidate({
  img,
  onPick,
}: {
  img: GeneratedImage;
  onPick: (img: GeneratedImage) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      onClick={() => onPick(img)}
      className="relative aspect-square overflow-hidden rounded-lg border border-line bg-paper-3 transition hover:scale-[1.02] hover:border-steel"
    >
      {!loaded && <div className="absolute inset-0 animate-pulse bg-paper-3" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={img.url}
        alt=""
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={`h-full w-full object-cover transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );
}
