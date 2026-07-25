"use client";

import { useState } from "react";
import {
  assembleGenerationPrompts,
  type GenerationPromptConfig,
} from "@/lib/config/domains/generation";
import type { RoleId } from "@/lib/roles";

const ROLES: { id: RoleId; label: string }[] = [
  { id: "boss", label: "부장" },
  { id: "exec", label: "임원" },
  { id: "teamlead", label: "팀장" },
  { id: "client", label: "거래처" },
  { id: "coworker", label: "동료" },
];

/**
 * 최종 조립 positive/negative 실시간 미리보기 — fal 호출 없음(assembleGenerationPrompts 순수 함수).
 * 편집 중 스키마 위반이어도 문자열 조립은 되므로(발행은 서버 Zod 가 막음) 미리보기는 항상 표시.
 */
export function PromptPreview({ prompt }: { prompt: GenerationPromptConfig }) {
  const [role, setRole] = useState<RoleId>("boss");
  const [glasses, setGlasses] = useState(false);
  const suitColor = prompt.suitColors[0] ?? "(정장색 없음)";
  const { positive, negative } = assembleGenerationPrompts(prompt, role, {
    wearsGlasses: glasses,
    suitColor,
  });

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-500">미리보기</span>
        <div className="flex gap-1">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRole(r.id)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                role === r.id
                  ? "bg-foreground text-paper-2"
                  : "text-zinc-500 hover:bg-foreground/5"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
          <input type="checkbox" checked={glasses} onChange={(e) => setGlasses(e.target.checked)} />
          안경
        </label>
      </div>
      <p className="text-[11px] text-zinc-400">정장색 = {suitColor} (첫 색)</p>
      <div className="mt-2 flex flex-col gap-2">
        <div>
          <p className="text-[11px] font-semibold text-emerald-600">positive</p>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-2 font-mono text-[11px] leading-relaxed">
            {positive}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-red-500">negative</p>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-2 font-mono text-[11px] leading-relaxed">
            {negative}
          </p>
        </div>
      </div>
    </div>
  );
}
