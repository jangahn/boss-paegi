import { BACKGROUNDS } from "@/lib/backgrounds";
import { MAP_KEY_LABELS } from "@/lib/keyboard-controls";

/** 맵 선택 줄 — PC(마우스 환경, `pointer-fine`)에서는 맵마다 선택 키(Q W E R T Y) 배지가 붙는다(v1.50). */
export function BgSwitcher({
  active,
  onChange,
}: {
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="배경 선택"
      className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 gap-1 overflow-x-auto rounded-full bg-black/50 p-1 backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:gap-2"
    >
      {BACKGROUNDS.map((b, i) => (
        <button
          key={b.key}
          type="button"
          onClick={() => onChange(b.key)}
          aria-pressed={b.key === active}
          aria-keyshortcuts={MAP_KEY_LABELS[i]}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition sm:px-3 sm:py-1.5 sm:text-xs ${
            b.key === active
              ? "bg-white text-black"
              : "text-white/80 hover:text-white"
          }`}
        >
          <span
            aria-hidden
            className="mr-1 hidden rounded border border-current px-1 text-[10px] font-bold leading-[14px] opacity-60 pointer-fine:inline-block"
          >
            {MAP_KEY_LABELS[i]}
          </span>
          {b.label}
        </button>
      ))}
    </div>
  );
}
