import { BACKGROUNDS } from "@/lib/backgrounds";

export function BgSwitcher({
  active,
  onChange,
}: {
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 gap-1 overflow-x-auto rounded-full bg-black/50 p-1 backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:gap-2">
      {BACKGROUNDS.map((b) => (
        <button
          key={b.key}
          onClick={() => onChange(b.key)}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition sm:px-3 sm:py-1.5 sm:text-xs ${
            b.key === active
              ? "bg-white text-black"
              : "text-white/80 hover:text-white"
          }`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
