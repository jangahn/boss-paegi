"use client";

type Props = {
  text: string | null;
};

export function SpeechBubble({ text }: Props) {
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-[18%] z-10 -translate-x-1/2 transition-opacity duration-300 ${
        text ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="relative max-w-[280px] rounded-2xl bg-white px-5 py-3 shadow-2xl">
        <p className="whitespace-nowrap text-center text-base font-semibold text-zinc-900">
          {text ?? " "}
        </p>
        {/* 말풍선 꼬리 (아래 인형 가리킴) */}
        <div className="absolute -bottom-1.5 left-1/2 h-4 w-4 -translate-x-1/2 rotate-45 bg-white" />
      </div>
    </div>
  );
}
