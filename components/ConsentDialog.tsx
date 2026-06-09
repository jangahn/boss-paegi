"use client";

import { useState } from "react";
import { CONSENT_ITEMS, POLICY_NOTICE } from "@/lib/policy";

export function ConsentDialog({ onAgree }: { onAgree: () => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const allChecked = CONSENT_ITEMS.every((i) => checked[i.id]);

  const toggle = (id: string) => {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">시작 전에 확인해주세요</h1>
        <p className="mt-2 text-sm text-zinc-500">
          개인정보 보호와 안전한 이용을 위해 동의가 필요합니다.
        </p>
      </div>

      <div className="space-y-2 rounded-2xl bg-foreground/5 p-4 text-xs leading-relaxed text-zinc-500">
        <p>· {POLICY_NOTICE.imageRetention}</p>
        <p>· {POLICY_NOTICE.characterization}</p>
        <p>· {POLICY_NOTICE.prohibition}</p>
      </div>

      <div className="space-y-3">
        {CONSENT_ITEMS.map((item) => {
          const on = !!checked[item.id];
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => toggle(item.id)}
              className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-foreground/10 p-3 text-left transition hover:bg-foreground/5 active:bg-foreground/10"
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition ${
                  on
                    ? "border-foreground bg-foreground"
                    : "border-foreground/30 bg-transparent"
                }`}
              >
                {on && (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3 w-3 fill-background"
                  >
                    <path d="M13.854 3.146a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L6.5 9.793l6.646-6.647a.5.5 0 0 1 .708 0z" />
                  </svg>
                )}
              </span>
              <span className="text-sm leading-relaxed">{item.label}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={!allChecked}
        onClick={onAgree}
        className="rounded-full bg-foreground py-4 font-semibold text-background transition disabled:cursor-not-allowed disabled:opacity-30"
      >
        동의하고 사진 업로드
      </button>
    </div>
  );
}
