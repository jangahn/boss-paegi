import type { GeneratedImage } from "@/app/generate/useGenerationPolling";

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
