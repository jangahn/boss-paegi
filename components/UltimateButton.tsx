"use client";

type Props = {
  ready: boolean;
  onFire: () => void;
};

/**
 * 궁극기 발동 버튼 — 게이지 풀 충전(ready) 시에만 등장.
 * 무기 picker 위, 화면 중앙 하단. 빛나는 펄스로 시선 유도.
 */
export function UltimateButton({ ready, onFire }: Props) {
  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={onFire}
      className="pointer-events-auto absolute bottom-[8.5rem] left-1/2 z-20 -translate-x-1/2 animate-bounce rounded-full bg-gradient-to-r from-amber-400 via-orange-500 to-red-500 px-6 py-3 text-base font-extrabold text-white shadow-[0_0_24px_rgba(249,115,22,0.7)] ring-2 ring-white/40 transition active:scale-95 sm:bottom-36 sm:px-8 sm:py-3.5 sm:text-lg"
    >
      🔥 궁극기 발동
    </button>
  );
}
