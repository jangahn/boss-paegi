"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { SessionLimits } from "@/lib/config/domains/session";
import {
  BASE_SECONDS_MAX,
  BASE_SECONDS_MIN,
  MAX_PLAY_SECONDS_MAX,
  ULTIMATE_BONUS_SECONDS_MAX,
  formatSecondsKo,
  playSecondsAfterUltimates,
  ultimatesToMaxPlay,
} from "@/lib/time-limit";
import { useAdminConfigMutation } from "@/lib/use-admin-config-mutation";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "범위를 벗어났어요. 안내된 최소/최대 안에서 정수로 입력하세요.",
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

type FieldKey = "baseSeconds" | "maxPlaySeconds" | "ultimateBonusSeconds" | "maxElapsedSeconds" | "maxScore";

const isInt = (v: string) => /^\d+$/.test(v.trim());

/**
 * 제한 시간(구 세션 한도, v1.53) 편집기 — 「시간 규칙」(기본 시간·최대 플레이 시간·궁극기 추가 시간)과
 * 「강제 종료」(최대 경과 시간·최대 점수, 어뷰징 방지) 두 칸. 스키마(lib/config/domains/session)와 같은 범위를 미리 검사한다.
 */
export function SessionLimitsEditor({
  initial,
  version,
  source,
  invalid,
  maxElapsedSecondsHard,
  maxScoreHard,
  scorePerSecMax,
  timeCapGraceSeconds,
}: {
  initial: SessionLimits;
  version: number;
  source: "db" | "default";
  invalid: boolean;
  /** 최대 경과 시간 상한(초) = 제출 clamp(30분) */
  maxElapsedSecondsHard: number;
  maxScoreHard: number;
  /** S3 점수/초 — 최대 플레이 시간에 따른 어뷰징 점수 상한(S11) 미리보기용(서버 규칙 상수) */
  scorePerSecMax: number;
  timeCapGraceSeconds: number;
}) {
  const router = useRouter();
  const submitAdminConfigMutation = useAdminConfigMutation();
  const [form, setForm] = useState<Record<FieldKey, string>>({
    baseSeconds: String(initial.timeLimit.baseSeconds),
    maxPlaySeconds: String(initial.timeLimit.maxPlaySeconds),
    ultimateBonusSeconds: String(initial.timeLimit.ultimateBonusSeconds),
    maxElapsedSeconds: String(initial.maxElapsedSeconds),
    maxScore: String(initial.maxScore),
  });
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: FieldKey, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const n = (k: FieldKey) => Number(form[k]);
  const base = n("baseSeconds");
  const maxPlay = n("maxPlaySeconds");
  const bonus = n("ultimateBonusSeconds");
  const maxElapsed = n("maxElapsedSeconds");
  const maxScore = n("maxScore");
  const allInts = (Object.keys(form) as FieldKey[]).every((k) => isInt(form[k]));
  const baseOk = allInts && base >= BASE_SECONDS_MIN && base <= BASE_SECONDS_MAX;
  const maxPlayOk = allInts && maxPlay >= Math.max(BASE_SECONDS_MIN, base) && maxPlay <= MAX_PLAY_SECONDS_MAX;
  const bonusOk = allInts && bonus >= 0 && bonus <= ULTIMATE_BONUS_SECONDS_MAX;
  const elapsedOk = allInts && maxElapsed >= Math.max(5, maxPlay) && maxElapsed <= maxElapsedSecondsHard;
  const scoreOk = allInts && maxScore >= 100 && maxScore <= maxScoreHard;
  const timeOk = baseOk && maxPlayOk && bonusOk;
  const allOk = timeOk && elapsedOk && scoreOk;

  const rule = { baseSeconds: base, maxPlaySeconds: maxPlay, ultimateBonusSeconds: bonus };
  const toMax = timeOk ? ultimatesToMaxPlay(rule) : null;
  const preview = timeOk
    ? [
        `궁극기 0회 ${formatSecondsKo(base)}`,
        ...(toMax == null
          ? []
          : [1, 2]
              .filter((k) => k < toMax)
              .map((k) => `${k}회 ${formatSecondsKo(playSecondsAfterUltimates(rule, k))}`)),
        toMax == null ? "추가 시간 없음" : `${toMax}회부터 최대 ${formatSecondsKo(maxPlay)}`,
      ].join(" · ")
    : null;
  const s11Ceiling = maxPlayOk ? scorePerSecMax * (maxPlay + timeCapGraceSeconds) : null;

  const submit = async () => {
    if (busy || !allOk) return;
    setBusy(true);
    setMsg(null);
    try {
      const value: SessionLimits = {
        maxElapsedSeconds: maxElapsed,
        maxScore,
        timeLimit: { baseSeconds: base, maxPlaySeconds: maxPlay, ultimateBonusSeconds: bonus },
      };
      const result = await submitAdminConfigMutation({
        body: { key: "session_limits", value, baseVersion },
        baseVersion,
      });
      if (result.ok) {
        setBaseVersion(result.ack.version);
        setMsg({ ok: true, text: "발행됐어요. 새로 시작하는 판부터 적용돼요." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: ERR_KO[result.error] ?? result.error });
      }
    } catch {
      setMsg({ ok: false, text: "네트워크 오류 — 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-foreground/15 ui-field p-2 text-sm tabular-nums outline-none focus:border-foreground/40";
  const field = (k: FieldKey, label: string, range: string, help: string, ok: boolean) => (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-zinc-500">
        {label} <span className="font-normal text-zinc-400">· {range}</span>
      </span>
      <input
        type="number"
        inputMode="numeric"
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
        aria-invalid={!ok}
        className={`${inputCls} ${ok ? "" : "border-red-400/60"}`}
      />
      <span className="text-[11px] text-zinc-400">{help}</span>
    </label>
  );

  return (
    <div className="mt-5 flex flex-col gap-4">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요. 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다."}
        </p>
      )}

      <fieldset className="flex flex-col gap-3 rounded-xl border border-foreground/10 ui-surface p-3">
        <legend className="px-1 text-sm font-semibold text-zinc-500">시간 규칙</legend>
        {field(
          "baseSeconds",
          "기본 시간(초)",
          `${BASE_SECONDS_MIN} ~ ${BASE_SECONDS_MAX}`,
          "첫 타격 때 주어지는 시간 · 시간 바가 가득 찬 값",
          baseOk,
        )}
        {field(
          "maxPlaySeconds",
          "최대 플레이 시간(초)",
          `기본 시간 ~ ${MAX_PLAY_SECONDS_MAX}`,
          s11Ceiling != null
            ? `궁극기로 늘려도 이 이상은 안 늘어나요 · 어뷰징 점수 상한(S11) ${s11Ceiling.toLocaleString()}점`
            : "궁극기로 늘려도 이 이상은 안 늘어나요",
          maxPlayOk,
        )}
        {field(
          "ultimateBonusSeconds",
          "궁극기 추가 시간(초)",
          `0 ~ ${ULTIMATE_BONUS_SECONDS_MAX}`,
          "궁극기 1회당 늘어나는 시간 · 0이면 안 늘어남",
          bonusOk,
        )}
        {preview && (
          <p className="rounded-lg border border-lime-400/30 bg-lime-400/10 p-2 text-xs text-lime-700 dark:text-lime-200">
            미리보기 · {preview}
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-xl border border-foreground/10 ui-surface p-3">
        <legend className="px-1 text-sm font-semibold text-zinc-500">강제 종료 (어뷰징 방지)</legend>
        {field(
          "maxElapsedSeconds",
          "최대 경과 시간(초)",
          `최대 플레이 시간 ~ ${maxElapsedSecondsHard}`,
          `${Number.isFinite(maxElapsed) && maxElapsed > 0 ? `= ${formatSecondsKo(maxElapsed)} · ` : ""}게임을 연 뒤 이 시간이 지나면 멈춰 있어도 자동 종료(켜 두고 떠난 판 정리)`,
          elapsedOk,
        )}
        {field(
          "maxScore",
          "최대 점수",
          `100 ~ ${maxScoreHard.toLocaleString()}`,
          "이 점수에 도달하면 자동 종료",
          scoreOk,
        )}
      </fieldset>

      {!allOk && (
        <p className="text-xs text-red-400">
          범위를 확인하세요 — 최대 플레이 시간은 기본 시간 이상, 최대 경과 시간은 최대 플레이 시간 이상이어야 해요.
        </p>
      )}
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !allOk}
        className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
