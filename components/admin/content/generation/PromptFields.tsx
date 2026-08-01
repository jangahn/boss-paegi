"use client";

import { useEffect, useRef } from "react";
import type { GenerationPromptConfig } from "@/lib/config/domains/generation";
import type { RoleId } from "@/lib/roles";

const ROLE_LABEL: Record<RoleId, string> = {
  boss: "부장 (boss)",
  exec: "임원 (exec)",
  teamlead: "팀장 (teamlead)",
  client: "거래처 (client)",
  coworker: "동료 (coworker)",
};
const ROLES: RoleId[] = ["boss", "exec", "teamlead", "client", "coworker"];

// 내용에 맞춰 세로로 자동 확장(잘림 없음) — 값 변경/마운트 시 scrollHeight 로 높이 재설정.
function Area({
  label,
  hint,
  value,
  onChange,
  minRows = 2,
  mono = true,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  minRows?: number;
  mono?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-zinc-500">
        {label}
        {hint ? <span className="ml-1 font-normal text-zinc-400">· {hint}</span> : null}
      </span>
      <textarea
        ref={ref}
        value={value}
        rows={minRows}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full resize-none overflow-hidden rounded-lg border border-foreground/15 ui-field p-2 text-xs leading-relaxed outline-none focus:border-foreground/40 ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}

/**
 * generation_config.prompt v2 편집 — 통짜 template({subject}{role}{glasses}{idGlasses} 각 1회)
 * + 안경 절 + 정장색 + 롤별 변주(subject/body). 프롬프트 텍스트 100% config 소유.
 * 검증(placeholder 규칙 등)은 서버 Zod(발행 시 validation_failed).
 */
export function PromptFields({
  prompt,
  onChange,
}: {
  prompt: GenerationPromptConfig;
  onChange: (next: GenerationPromptConfig) => void;
}) {
  const set = (patch: Partial<GenerationPromptConfig>) => onChange({ ...prompt, ...patch });
  const setRole = (role: RoleId, patch: Partial<GenerationPromptConfig["roles"][RoleId]>) =>
    onChange({
      ...prompt,
      roles: { ...prompt.roles, [role]: { ...prompt.roles[role], ...patch } },
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
        <p className="mb-2 text-xs text-zinc-400">
          최종 프롬프트 = <code>template</code> 에{" "}
          <code>{"{subject}{role}{glasses}{idGlasses}"}</code> 치환.{" "}
          <code>{"{subject}"}</code>→각 롤 호칭, <code>{"{role}"}</code>→각 롤 body(복장+표정,{" "}
          <code>{"{suitColor}"}</code> 치환), <code>{"{glasses}"}</code>/<code>{"{idGlasses}"}</code>
          →안경 시에만 삽입.
        </p>
        <Area
          label="template (통짜 고정문)"
          hint="{subject}{role}{glasses}{idGlasses} 각 1회"
          value={prompt.template}
          onChange={(v) => set({ template: v })}
          minRows={6}
        />
        <div className="mt-3">
          <Area label="negative prompt" value={prompt.negative} onChange={(v) => set({ negative: v })} minRows={3} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Area
            label="glasses (안경 시 {glasses} 위치 삽입)"
            hint="빈값=비활성"
            value={prompt.glasses}
            onChange={(v) => set({ glasses: v })}
            minRows={2}
          />
          <Area
            label="glassesIdentity (안경 시 {idGlasses} 위치 삽입)"
            hint="빈값=비활성"
            value={prompt.glassesIdentity}
            onChange={(v) => set({ glassesIdentity: v })}
            minRows={2}
          />
        </div>
        <div className="mt-3">
          <Area
            label="suitColors (한 줄에 하나, ≥3)"
            hint="후보마다 셔플해 주입"
            value={prompt.suitColors.join("\n")}
            onChange={(v) =>
              set({ suitColors: v.split("\n").map((s) => s.trim()).filter(Boolean) })
            }
            minRows={4}
            mono={false}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-zinc-500">롤별 변주 (호칭·복장+표정)</p>
        {ROLES.map((role) => (
          <div key={role} className="rounded-xl border border-foreground/10 p-3">
            <p className="mb-2 text-xs font-bold text-foreground">{ROLE_LABEL[role]}</p>
            <div className="flex flex-col gap-2">
              <Area
                label="subject (호칭 — 짧은 명사구)"
                value={prompt.roles[role].subject}
                onChange={(v) => setRole(role, { subject: v })}
                minRows={1}
                mono={false}
              />
              <Area
                label="body (복장+표정 통합, {suitColor} 1회)"
                value={prompt.roles[role].body}
                onChange={(v) => setRole(role, { body: v })}
                minRows={3}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
