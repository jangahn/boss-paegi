"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import {
  GRADE_COMMENT_ONE_LINE_MAX_CHARS,
  GRADE_COMMENT_ONE_LINE_MAX_HANGUL,
  GRADE_LABEL_ONE_LINE_MAX_HANGUL,
  gradeFitsOneLine,
  type ScoreConfig,
} from "@/lib/config/domains/score";
import { isValidThresholds, THRESHOLD_STEP, TIER_COUNT, tierBandLabel } from "@/lib/score-tiers";
import {
  COMBO_WINDOW_SEC_MAX,
  COMBO_WINDOW_SEC_MIN,
  JUGGLE_WINDOW_SEC_MAX,
  JUGGLE_WINDOW_SEC_MIN,
  type JuggleSeconds,
} from "@/lib/game-tuning";
import { MAX_SCORE_HARD } from "@/lib/score-limits";
import { useAdminConfigMutation } from "@/lib/use-admin-config-mutation";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: `형식 오류 — 구간 경계 ${TIER_COUNT - 1}개(${THRESHOLD_STEP.toLocaleString()}점 단위·오름차순)와 라벨(1~20자)·한 줄 평(1~40자)을 모두 채워주세요.`,
  update_failed: "저장 실패. 잠시 후 다시 시도하세요.",
};

export function ScoreConfigEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: ScoreConfig;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const submitAdminConfigMutation = useAdminConfigMutation();
  const [grades, setGrades] = useState(initial.grades);
  // 경계는 문자열로 편집(빈 칸·타이핑 중 허용) → 발행 시 정수 변환.
  const [thresholds, setThresholds] = useState<string[]>(initial.thresholds.map((t) => String(t)));
  // 변경 보너스·콤보 창 초수(v1.36) — 문자열로 편집, 발행 시 숫자 변환(창은 정수 초, 콤보는 0.1초 단위).
  const [juggle, setJuggle] = useState<Record<keyof JuggleSeconds, string>>({
    weaponWindowSec: String(initial.juggle.weaponWindowSec),
    mapWindowSec: String(initial.juggle.mapWindowSec),
    comboWindowSec: String(initial.juggle.comboWindowSec),
  });
  const setJuggleField = (key: keyof JuggleSeconds, v: string) =>
    setJuggle((j) => ({ ...j, [key]: v.replace(/[^\d.]/g, "") }));
  const parsedJuggle: JuggleSeconds = {
    weaponWindowSec: Number(juggle.weaponWindowSec),
    mapWindowSec: Number(juggle.mapWindowSec),
    comboWindowSec: Math.round(Number(juggle.comboWindowSec) * 10) / 10,
  };
  const windowOk = (v: number) => Number.isInteger(v) && v >= JUGGLE_WINDOW_SEC_MIN && v <= JUGGLE_WINDOW_SEC_MAX;
  const juggleOk =
    windowOk(parsedJuggle.weaponWindowSec) &&
    windowOk(parsedJuggle.mapWindowSec) &&
    Number.isFinite(parsedJuggle.comboWindowSec) &&
    parsedJuggle.comboWindowSec >= COMBO_WINDOW_SEC_MIN &&
    parsedJuggle.comboWindowSec <= COMBO_WINDOW_SEC_MAX;
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setField = (i: number, key: "label" | "comment", v: string) =>
    setGrades((gs) => gs.map((g, gi) => (gi === i ? { ...g, [key]: v } : g)));
  const setThreshold = (i: number, v: string) =>
    setThresholds((ts) => ts.map((t, ti) => (ti === i ? v.replace(/[^\d]/g, "") : t)));

  const parsedThresholds = thresholds.map((t) => Number(t));
  const thresholdsOk = isValidThresholds(parsedThresholds, THRESHOLD_STEP, MAX_SCORE_HARD);
  // 미리보기 라벨은 유효할 때만 입력값으로, 아니면 발행값으로(입력 중 깨진 라벨 방지).
  const previewThresholds = thresholdsOk ? parsedThresholds : initial.thresholds;

  const submit = async () => {
    if (busy) return;
    if (!thresholdsOk || !juggleOk) {
      setMsg({ ok: false, text: ERR_KO.validation_failed });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const value: ScoreConfig = {
        thresholds: parsedThresholds,
        grades: grades.map((g) => ({ label: g.label.trim(), comment: g.comment.trim() })),
        juggle: parsedJuggle,
      };
      const result = await submitAdminConfigMutation({
        body: { key: "score_config", value, baseVersion },
        baseVersion,
      });
      if (result.ok) {
        setBaseVersion(result.ack.version);
        setMsg({ ok: true, text: "발행됐어요. 다음 로드부터 반영됩니다." });
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

  // 테두리 색은 하나만(기본 · 경고) — 두 색 클래스를 같이 두면 스타일시트 순서로 기본색이 이긴다.
  const fieldCls = (warn: boolean) =>
    `w-full rounded-lg border ui-field p-2 text-sm outline-none ${
      warn ? "border-amber-500 focus:border-amber-500" : "border-foreground/15 focus:border-foreground/40"
    }`;
  const inputCls = fieldCls(false);

  return (
    <div className="mt-5 flex flex-col gap-4">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 코드 기본값으로 동작 중이에요. 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다."}
        </p>
      )}

      {/* 구간 경계 — 단계 개수(5)는 고정, 경계 4개만 편집. 등급 칸 캡션·롤 대사 칸·게임 분석 분포가 이 값을 따른다. */}
      <fieldset className="flex flex-col gap-2 rounded-xl border border-foreground/10 ui-surface p-3">
        <legend className="px-1 text-sm font-semibold text-zinc-500">구간 경계</legend>
        <p className="text-xs text-zinc-500">
          {TIER_COUNT}단계의 경계 {TIER_COUNT - 1}개. {THRESHOLD_STEP.toLocaleString()}점 단위·오름차순. 바꾸면 등급·피격 반응·시비 멘트·게임 분석의
          점수 구간이 <b>과거 판까지</b> 새 경계로 다시 계산돼요(라벨과 같은 라이브 값).
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {thresholds.map((t, i) => (
            <label key={i} className="flex flex-col gap-0.5">
              <span className="text-[11px] text-zinc-400">{i + 1}단계 시작 점수</span>
              <input
                value={t}
                inputMode="numeric"
                onChange={(e) => setThreshold(i, e.target.value)}
                placeholder={String(initial.thresholds[i] ?? "")}
                className={`${inputCls} tabular-nums`}
              />
            </label>
          ))}
        </div>
        {!thresholdsOk && (
          <p className="text-xs text-red-400">
            경계는 {THRESHOLD_STEP.toLocaleString()}점 단위 정수, 오름차순, {THRESHOLD_STEP.toLocaleString()}~{MAX_SCORE_HARD.toLocaleString()}점 사이여야 해요.
          </p>
        )}
      </fieldset>

      {/* 변경 보너스·콤보 창(v1.36) — 배율 표(무기 2~5종 ×1.25~2.0 · 맵 2곳 ×1.5·3곳 ×2.0)는 코드, 여기선 창 초수만. */}
      <fieldset className="flex flex-col gap-2 rounded-xl border border-foreground/10 ui-surface p-3">
        <legend className="px-1 text-sm font-semibold text-zinc-500">변경 보너스 · 콤보 창</legend>
        <p className="text-xs text-zinc-500">
          최근 몇 초 안에 돌린 무기 수·맵 수로 배율을 매겨요(무기 2~5종 ×1.25~2.0, 맵 2곳 ×1.5·3곳 ×2.0, 둘은 곱).
          콤보 창은 다음 타격까지 콤보가 유지되는 시간이에요. 발행 후 <b>새로 시작하는 판</b>부터 적용됩니다.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              ["weaponWindowSec", "무기변경 창 (초)", `${JUGGLE_WINDOW_SEC_MIN}~${JUGGLE_WINDOW_SEC_MAX}, 정수`],
              ["mapWindowSec", "맵변경 창 (초)", `${JUGGLE_WINDOW_SEC_MIN}~${JUGGLE_WINDOW_SEC_MAX}, 정수`],
              ["comboWindowSec", "콤보 유지 창 (초)", `${COMBO_WINDOW_SEC_MIN.toFixed(1)}~${COMBO_WINDOW_SEC_MAX.toFixed(1)}, 0.1 단위`],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="flex flex-col gap-0.5">
              <span className="text-[11px] text-zinc-400">{label}</span>
              <input
                value={juggle[key]}
                inputMode="decimal"
                onChange={(e) => setJuggleField(key, e.target.value)}
                placeholder={String(initial.juggle[key])}
                className={`${inputCls} tabular-nums`}
              />
              <span className="text-[10px] text-zinc-500">{hint}</span>
            </label>
          ))}
        </div>
        {!juggleOk && (
          <p className="text-xs text-red-400">
            창은 {JUGGLE_WINDOW_SEC_MIN}~{JUGGLE_WINDOW_SEC_MAX}초 정수, 콤보 창은 {COMBO_WINDOW_SEC_MIN.toFixed(1)}~{COMBO_WINDOW_SEC_MAX.toFixed(1)}초여야 해요.
          </p>
        )}
      </fieldset>

      {/* 결과 화면 한 줄 규칙(v1.57) — 넘으면 경고만(발행은 막지 않음) */}
      <p className="text-xs text-zinc-500">
        결과 화면 한 줄(iPhone SE 375px) 기준: 등급 이름은 한글 {GRADE_LABEL_ONE_LINE_MAX_HANGUL}자, 한 줄 평은 공백 포함{" "}
        {GRADE_COMMENT_ONE_LINE_MAX_CHARS}자(한글 {GRADE_COMMENT_ONE_LINE_MAX_HANGUL}자)까지. 넘기면 그 줄이 두 줄로 꺾여요.
      </p>
      {grades.map((g, i) => {
        const fits = gradeFitsOneLine(g);
        return (
          <div key={i} className="flex flex-col gap-1 rounded-xl border border-foreground/10 ui-surface p-3">
            <span className="text-[11px] text-zinc-400">
              {i}단계 · {tierBandLabel(i, previewThresholds)}점
            </span>
            <input
              value={g.label}
              maxLength={20}
              onChange={(e) => setField(i, "label", e.target.value)}
              placeholder="등급 라벨 (예: 키보드 워리어)"
              className={`${fieldCls(!fits.label)} font-semibold`}
            />
            <input
              value={g.comment}
              maxLength={40}
              onChange={(e) => setField(i, "comment", e.target.value)}
              placeholder="한 줄 평 (예: 엔터키에 오늘의 감정이 실렸습니다)"
              className={fieldCls(!fits.comment)}
            />
            {(!fits.label || !fits.comment) && (
              <p className="text-[11px] text-amber-600">
                {!fits.label && "등급 이름"}
                {!fits.label && !fits.comment && " · "}
                {!fits.comment && "한 줄 평"}이 iPhone SE 에서 두 줄로 꺾여요.
              </p>
            )}
          </div>
        );
      })}

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="sticky bottom-3 flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 shadow-lg transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
