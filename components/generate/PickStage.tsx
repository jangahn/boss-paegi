"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { FadeImg } from "@/components/FadeImg";
import type { GeneratedImage } from "@/app/generate/useGenerationPolling";
import { burst } from "@/lib/motion";

/**
 * 생성 후보 선택 — 1~2분 유료 생성 직후라 이미지 로드 전 "빈 카드" 인상 방지.
 * 각 후보는 로드 전 shimmer placeholder(공용 FadeImg, 갤러리/공유와 동일 — 이미지는 페이드 없이 불투명).
 * v1.65 공개 연출: 후보 카드가 한 장씩 뒤집히며 나오고(motion-flip), 제목에서 축하 조각이 한 번 튄다.
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => burst(headingRef.current, { emojis: ["🎉", "✨", "🎨"] }), 250);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6">
      <h2 ref={headingRef} className="text-2xl font-bold">
        마음에 드는 캐릭터 선택
      </h2>
      <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
        {results.map((img, i) => (
          <PickCandidate key={i} index={i} img={img} onPick={onPick} />
        ))}
      </div>
      {error && (
        <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}

function PickCandidate({
  img,
  index,
  onPick,
}: {
  img: GeneratedImage;
  index: number;
  onPick: (img: GeneratedImage) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(img)}
      style={{ "--i": index } as CSSProperties}
      className="motion-flip relative aspect-square overflow-hidden rounded-2xl border border-foreground/10 transition hover:scale-[1.02] hover:border-foreground/40"
    >
      <FadeImg src={img.url} placeholder="shimmer" loading="eager" fit="cover" className="h-full w-full" />
    </button>
  );
}
