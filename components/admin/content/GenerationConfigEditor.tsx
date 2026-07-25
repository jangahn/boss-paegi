"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import {
  GENERATION_IMAGE_SIZES,
  type GenerationConfig,
  type GenerationPromptConfig,
} from "@/lib/config/domains/generation";
import { PromptFields } from "@/components/admin/content/generation/PromptFields";
import { PromptPreview } from "@/components/admin/content/generation/PromptPreview";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed:
    "형식 위반이에요. 수치 범위·placeholder 규칙(예: headTemplate {subject} 1회, attire {suitColor} 1회, positiveTemplate 7종)·정장색 3개 이상을 확인하세요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

function NumField({
  label,
  hint,
  value,
  onChange,
  step,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-zinc-500">
        {label} <span className="font-normal text-zinc-400">· {hint}</span>
      </span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40"
      />
    </label>
  );
}

export function GenerationConfigEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: GenerationConfig;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [steps, setSteps] = useState(String(initial.numbers.numInferenceSteps));
  const [guidance, setGuidance] = useState(String(initial.numbers.guidanceScale));
  const [trueCfg, setTrueCfg] = useState(String(initial.numbers.trueCfg));
  const [imageSize, setImageSize] = useState<GenerationConfig["numbers"]["imageSize"]>(
    initial.numbers.imageSize
  );
  const [prompt, setPrompt] = useState<GenerationPromptConfig>(initial.prompt);
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const value: GenerationConfig = {
        numbers: {
          numInferenceSteps: Number(steps),
          guidanceScale: Number(guidance),
          trueCfg: Number(trueCfg),
          imageSize,
        },
        prompt,
      };
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "generation_config", value, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
      };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 다음 생성부터 반영됩니다." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: ERR_KO[out.error ?? ""] ?? out.error ?? "저장 실패" });
      }
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-5">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요."
            : "아직 발행된 적 없어 코드 기본값(현행 프롬프트·수치)을 보여줍니다."}
        </p>
      )}

      {/* 수치 (안전 서브레인지) */}
      <div className="grid grid-cols-2 gap-3">
        <NumField label="steps" hint="20~40 정수" value={steps} onChange={setSteps} step="1" />
        <NumField label="guidance" hint="3~6" value={guidance} onChange={setGuidance} step="0.1" />
        <NumField label="true_cfg" hint="1~4" value={trueCfg} onChange={setTrueCfg} step="0.1" />
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-zinc-500">image_size</span>
          <select
            value={imageSize}
            onChange={(e) =>
              setImageSize(e.target.value as GenerationConfig["numbers"]["imageSize"])
            }
            className="w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm outline-none focus:border-foreground/40"
          >
            {GENERATION_IMAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <PromptPreview prompt={prompt} />
      <PromptFields prompt={prompt} onChange={setPrompt} />

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="sticky bottom-4 flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 shadow-lg transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
