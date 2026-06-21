import type { Persona } from "@/lib/persona";

/**
 * 패기 유형(페르소나) 리빌 카드 — 종료화면 보고서(`ScoreReport`)·공유페이지 공용.
 * 라벨 + 한 줄 해석 + 트리거 stat(evidence)을 함께 보여줘 "이 분석은 이 데이터에서" 느낌.
 */
export function PersonaCard({
  persona,
  heading = "오늘의 패기 유형",
}: {
  persona: Persona;
  heading?: string;
}) {
  return (
    <div className="rounded-md border-2 border-zinc-800 bg-zinc-900 p-3 text-center text-white">
      <p className="text-[10px] tracking-[0.25em] text-amber-300">{heading}</p>
      <p className="mt-1 text-xl font-extrabold">
        {persona.emoji} {persona.label}
      </p>
      <p className="mt-1 text-xs text-zinc-300">&ldquo;{persona.blurb}&rdquo;</p>
      <p className="mt-2 inline-block rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-medium text-amber-200">
        📊 {persona.evidence}
      </p>
    </div>
  );
}
