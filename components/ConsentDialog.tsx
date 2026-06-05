"use client";

import { useState } from "react";
import { CONSENT_ITEMS, POLICY_NOTICE } from "@/lib/policy";

export function ConsentDialog({ onAgree }: { onAgree: () => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const allChecked = CONSENT_ITEMS.every((i) => checked[i.id]);

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
        {CONSENT_ITEMS.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-foreground/10 p-3 transition hover:bg-foreground/5"
          >
            <input
              type="checkbox"
              checked={!!checked[item.id]}
              onChange={(e) =>
                setChecked({ ...checked, [item.id]: e.target.checked })
              }
              className="mt-0.5 h-5 w-5 accent-foreground"
            />
            <span className="text-sm leading-relaxed">{item.label}</span>
          </label>
        ))}
      </div>

      <button
        disabled={!allChecked}
        onClick={onAgree}
        className="rounded-full bg-foreground py-4 font-semibold text-background transition disabled:cursor-not-allowed disabled:opacity-30"
      >
        동의하고 사진 업로드
      </button>
    </div>
  );
}
