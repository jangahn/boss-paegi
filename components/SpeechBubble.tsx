"use client";

type Props = {
  text: string | null;
};

/**
 * 인게임 말풍선(시비 멘트 · 피격 반응). v1.65: 보였다 사라질 때 opacity 가 아니라 크기(scale)로 — 글자에 opacity 를 걸면
 * iOS WebKit 이 이전 글자 잔상을 남긴다(globals.css 「궁극기 게이지」 주석). 문구가 바뀌면 글줄을 새 요소로(key) 그린다.
 */
export function SpeechBubble({ text }: Props) {
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-[18%] z-10 -translate-x-1/2 origin-bottom transition-[scale] duration-200 ease-[var(--ease-stamp)] ${
        text ? "scale-100" : "scale-0"
      }`}
    >
      <div className="relative max-w-[280px] rounded-2xl bg-white px-5 py-3 shadow-2xl">
        <p key={text ?? ""} className="whitespace-nowrap text-center text-base font-semibold text-zinc-900">
          {text ?? " "}
        </p>
        {/* 말풍선 꼬리 (아래 캐릭터 가리킴) */}
        <div className="absolute -bottom-1.5 left-1/2 h-4 w-4 -translate-x-1/2 rotate-45 bg-white" />
      </div>
    </div>
  );
}
