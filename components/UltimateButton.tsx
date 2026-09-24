"use client";

type Props = {
  ready: boolean;
  onFire: () => void;
  /** 이번 발동으로 받을 추가 시간(초, 제한 시간 v1.53) — 최대 플레이 시간에 막혀 0이면 칩을 숨긴다. */
  bonusSeconds?: number;
};

/**
 * 궁극기 발동 버튼 — 게이지 풀 충전(ready) 시에만 등장.
 * 무기 picker 위, 화면 중앙 하단. 빛나는 펄스로 시선 유도.
 * sm:bottom-40 = 안내 캡슐 윗변(124 + 28 = 152px) 위로 8px — 캡슐 위치를 바꾸면 같이 맞춘다.
 * PC(마우스 환경)에서는 발동 키(Space) 배지가 붙는다(v1.50).
 * 발동하면 남은 시간이 늘어나는 규칙을 버튼에서 미리 알린다 — 「+10초」 칩(v1.53).
 */
export function UltimateButton({ ready, onFire, bonusSeconds = 0 }: Props) {
  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={onFire}
      aria-keyshortcuts="Space"
      className="pointer-events-auto absolute bottom-[8.5rem] left-1/2 z-20 -translate-x-1/2 animate-bounce rounded-full bg-gradient-to-r from-amber-400 via-orange-500 to-red-500 px-6 py-3 text-base font-extrabold text-white shadow-[0_0_24px_rgba(249,115,22,0.7)] ring-2 ring-white/40 transition active:scale-95 sm:bottom-40 sm:px-8 sm:py-3.5 sm:text-lg"
    >
      🔥 궁극기 발동
      {bonusSeconds > 0 && (
        <span className="ml-2 rounded-full bg-lime-300 px-2 py-0.5 align-middle text-xs font-black text-lime-950 sm:text-sm">
          +{bonusSeconds}초
        </span>
      )}
      <span
        aria-hidden
        className="ml-2 hidden rounded border border-white/60 px-1.5 align-middle text-xs font-bold pointer-fine:inline-block"
      >
        Space
      </span>
    </button>
  );
}
