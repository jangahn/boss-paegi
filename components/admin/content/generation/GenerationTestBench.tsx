"use client";

import { useEffect, useState } from "react";
import { PhotoCropper } from "@/components/PhotoCropper";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { runBoundedClientJsonFetch } from "@/lib/client-mutation";
import {
  GENERATION_IMAGE_SIZES,
  type GenerationConfig,
} from "@/lib/config/domains/generation";
import type { RoleId } from "@/lib/roles";

const ROLES: { id: RoleId; label: string }[] = [
  { id: "boss", label: "부장" },
  { id: "exec", label: "임원" },
  { id: "teamlead", label: "팀장" },
  { id: "client", label: "거래처" },
  { id: "coworker", label: "동료" },
];

const MAX_SLOTS = 3;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TICKS = 120; // ≈6분 — 이후 미회수 상태로 정지(세션 일회성).

// 슬롯 = "현재 편집값 복제" 후 template/negative/수치/롤/안경만 개별 수정(나머지 prompt 는 복제값 유지).
type BenchSlot = {
  base: GenerationConfig;
  template: string;
  negative: string;
  steps: string;
  guidance: string;
  trueCfg: string;
  imageSize: GenerationConfig["numbers"]["imageSize"];
  role: RoleId;
  wearsGlasses: boolean;
};

type BenchRequest = {
  settingIndex: number;
  imageIndex: number;
  requestId: string | null;
};

type BenchRun = {
  faceUrl: string;
  seeds: number[];
  requests: BenchRequest[];
  // 실행 시점 스냅샷 — 이후 슬롯 편집/제거가 결과 표시를 흔들지 않게 고정.
  settingCount: number;
  diffs: string[][];
};

type BenchStatus = {
  requestId: string;
  status: "in_queue" | "in_progress" | "completed" | "failed";
  imageUrl?: string;
  seed?: number;
  nsfw?: boolean;
};

function slotFrom(current: GenerationConfig): BenchSlot {
  return {
    base: structuredClone(current),
    template: current.prompt.template,
    negative: current.prompt.negative,
    steps: String(current.numbers.numInferenceSteps),
    guidance: String(current.numbers.guidanceScale),
    trueCfg: String(current.numbers.trueCfg),
    imageSize: current.numbers.imageSize,
    role: "boss",
    wearsGlasses: false,
  };
}

function composeSlotValue(slot: BenchSlot): GenerationConfig {
  return {
    numbers: {
      numInferenceSteps: Number(slot.steps),
      guidanceScale: Number(slot.guidance),
      trueCfg: Number(slot.trueCfg),
      imageSize: slot.imageSize,
    },
    prompt: {
      ...slot.base.prompt,
      template: slot.template,
      negative: slot.negative,
    },
  };
}

// submit 응답 최소 형태 검증 — 서버 응답이라도 unknown 으로 취급(표시 전 형태 확인).
function parseBenchRunBody(
  body: unknown,
): Omit<BenchRun, "settingCount" | "diffs"> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.faceUrl !== "string" ||
    !Array.isArray(record.seeds) ||
    record.seeds.some((seed) => typeof seed !== "number") ||
    !Array.isArray(record.requests) ||
    record.requests.some((request) => {
      if (request === null || typeof request !== "object") return true;
      const r = request as Record<string, unknown>;
      return (
        typeof r.settingIndex !== "number" ||
        typeof r.imageIndex !== "number" ||
        (r.requestId !== null && typeof r.requestId !== "string")
      );
    })
  ) {
    return null;
  }
  return {
    faceUrl: record.faceUrl,
    seeds: record.seeds as number[],
    requests: record.requests as BenchRequest[],
  };
}

// 설정 간 차이 요약 — 슬롯 1(기준) 대비 변경 필드 나열.
function diffAgainstFirst(slot: BenchSlot, first: BenchSlot): string[] {
  const diffs: string[] = [];
  if (slot.template !== first.template) diffs.push("template");
  if (slot.negative !== first.negative) diffs.push("negative");
  if (slot.steps !== first.steps) diffs.push(`steps ${first.steps}→${slot.steps}`);
  if (slot.guidance !== first.guidance) diffs.push(`guidance ${first.guidance}→${slot.guidance}`);
  if (slot.trueCfg !== first.trueCfg) diffs.push(`true_cfg ${first.trueCfg}→${slot.trueCfg}`);
  if (slot.imageSize !== first.imageSize)
    diffs.push(`image_size ${first.imageSize}→${slot.imageSize}`);
  if (slot.role !== first.role) diffs.push(`롤 ${first.role}→${slot.role}`);
  if (slot.wearsGlasses !== first.wearsGlasses)
    diffs.push(`안경 ${first.wearsGlasses ? "on→off" : "off→on"}`);
  return diffs;
}

function SlotNumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-zinc-500">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-foreground/15 ui-field p-1.5 text-xs outline-none focus:border-foreground/40"
      />
    </label>
  );
}

/**
 * 생성 config A/B 테스트 벤치 — 원본 사진 1장 + 설정 슬롯 ≤3, 실행 시 설정당 2장을
 * **모든 설정 동일 seed 쌍**으로 생성해 나란히 비교(서버권위 조립, 유저 파이프라인 무접촉).
 * 세션 내 일회성: 어디에도 저장하지 않으며 새로고침 시 소실.
 */
export function GenerationTestBench({ current }: { current: GenerationConfig }) {
  const [file, setFile] = useState<File | null>(null);
  // 유저 서비스와 동일한 크롭 단계 — 원본 선택 → 3:4 크롭 확정 → 제출용 파일.
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [croppedPreview, setCroppedPreview] = useState<string | null>(null);
  const [slots, setSlots] = useState<BenchSlot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<BenchRun | null>(null);
  const [results, setResults] = useState<Record<string, BenchStatus>>({});
  const [pollTick, setPollTick] = useState(0);

  const setSlot = (index: number, patch: Partial<BenchSlot>) =>
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  // 미완료 requestId 폴링 — 상태 병합이 다음 tick 을 다시 스케줄한다(전부 종결/상한 도달 시 정지).
  useEffect(() => {
    if (!run) return;
    const ids = run.requests
      .map((r) => r.requestId)
      .filter((id): id is string => id !== null);
    const pending = ids.filter((id) => {
      const status = results[id]?.status;
      return status !== "completed" && status !== "failed";
    });
    if (pending.length === 0 || pollTick > POLL_MAX_TICKS) return;
    const timer = setTimeout(async () => {
      // 단일 시도·응답 바운드(runBoundedClientJsonFetch) — transient 실패는 다음 tick 이 재시도.
      const outcome = await runBoundedClientJsonFetch({
        input: "/api/admin/generation-test/status",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestIds: pending }),
        },
      });
      if (
        outcome.kind === "confirmed" &&
        outcome.value.response.ok &&
        Array.isArray(outcome.value.body)
      ) {
        const data = outcome.value.body as BenchStatus[];
        setResults((prev) => {
          const next = { ...prev };
          for (const item of data) {
            if (item && typeof item.requestId === "string") {
              next[item.requestId] = item;
            }
          }
          return next;
        });
      }
      setPollTick((t) => t + 1);
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [run, results, pollTick]);

  const execute = async () => {
    if (busy) return;
    if (!file) {
      setError("원본 사진을 먼저 선택하세요.");
      return;
    }
    if (slots.length === 0) {
      setError("설정 슬롯을 1개 이상 추가하세요.");
      return;
    }
    setBusy(true);
    setError(null);
    setRun(null);
    setResults({});
    setPollTick(0);
    try {
      const form = new FormData();
      form.set("image", file);
      form.set(
        "settings",
        JSON.stringify(
          slots.map((slot) => ({
            value: composeSlotValue(slot),
            role: slot.role,
            wearsGlasses: slot.wearsGlasses,
          })),
        ),
      );
      // 단일 시도(자동 재시도 없음 — 재제출 = fal 실비 중복). 응답은 바운드 JSON 읽기.
      const outcome = await runBoundedClientJsonFetch({
        input: "/api/admin/generation-test/submit",
        init: { method: "POST", body: form },
        attemptMs: 25_000,
        deadlineMs: 30_000,
      });
      if (outcome.kind !== "confirmed") {
        setError(
          outcome.kind === "unconfirmed"
            ? "응답 미확인 — fal 제출 여부 불명. 재실행하면 실비가 중복될 수 있어요."
            : "실행이 중단됐어요 — 다시 시도하세요.",
        );
        return;
      }
      const { response, body } = outcome.value;
      const errorCode =
        body !== null && typeof body === "object" && "error" in body
          ? String((body as { error?: unknown }).error)
          : null;
      if (!response.ok) {
        setError(
          errorCode === "invalid_settings"
            ? "설정 형식 위반 — 수치 범위·placeholder 규칙을 확인하세요."
            : `실행 실패 (${errorCode ?? response.status})`,
        );
        return;
      }
      const parsed = parseBenchRunBody(body);
      if (!parsed) {
        setError("응답 형식 오류 — 다시 시도하세요.");
        return;
      }
      setRun({
        ...parsed,
        settingCount: slots.length,
        diffs: slots.map((slot, i) => (i === 0 ? [] : diffAgainstFirst(slot, slots[0]))),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3">
      <p className="text-sm font-semibold text-zinc-500">테스트 (A/B 벤치)</p>
      <p className="mt-1 text-xs text-zinc-400">
        실행할 때마다 fal 실비가 과금되며, 결과는 저장되지 않는 세션 일회성이라 새로고침하면
        소실됩니다. 설정 최대 {MAX_SLOTS}개 · 설정당 2장 · 모든 설정에 동일한 seed 쌍(공정 비교) ·
        정장색은 각 설정의 첫 색 고정.
      </p>

      {cropSrc && (
        <PhotoCropper
          imageUrl={cropSrc}
          onConfirm={(blob) => {
            URL.revokeObjectURL(cropSrc);
            setCropSrc(null);
            if (croppedPreview) URL.revokeObjectURL(croppedPreview);
            setCroppedPreview(URL.createObjectURL(blob));
            setFile(new File([blob], "bench-cropped.jpg", { type: "image/jpeg" }));
          }}
          onCancel={() => {
            URL.revokeObjectURL(cropSrc);
            setCropSrc(null);
          }}
        />
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-zinc-500">
          원본 사진{" "}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              if (!picked) return;
              if (cropSrc) URL.revokeObjectURL(cropSrc);
              setCropSrc(URL.createObjectURL(picked));
              e.target.value = "";
            }}
            className="text-xs"
          />
        </label>
        {croppedPreview && (
          <span className="inline-flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- 세션 로컬 blob 미리보기 */}
            <img
              src={croppedPreview}
              alt="크롭된 원본 미리보기"
              className="h-14 w-auto rounded-md border border-foreground/15"
            />
            <button
              type="button"
              onClick={() => {
                if (croppedPreview) URL.revokeObjectURL(croppedPreview);
                setCroppedPreview(null);
                setFile(null);
              }}
              className="text-xs text-zinc-500 underline underline-offset-2"
            >
              제거
            </button>
          </span>
        )}
        <button
          type="button"
          disabled={slots.length >= MAX_SLOTS}
          onClick={() => setSlots((prev) => [...prev, slotFrom(current)])}
          className="rounded-full border border-foreground/15 px-3 py-1.5 text-xs font-semibold text-zinc-500 transition hover:bg-foreground/5 disabled:opacity-40"
        >
          + 현재 편집값 복제로 슬롯 추가 ({slots.length}/{MAX_SLOTS})
        </button>
      </div>

      {slots.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {slots.map((slot, index) => (
            <div key={index} className="rounded-xl border border-foreground/10 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-bold text-foreground">설정 {index + 1}</p>
                <button
                  type="button"
                  onClick={() => setSlots((prev) => prev.filter((_, i) => i !== index))}
                  className="text-[11px] text-zinc-400 hover:text-red-400"
                >
                  제거
                </button>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-zinc-500">template</span>
                  <textarea
                    value={slot.template}
                    rows={5}
                    onChange={(e) => setSlot(index, { template: e.target.value })}
                    className="w-full resize-y rounded-lg border border-foreground/15 ui-field p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-foreground/40"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-zinc-500">negative</span>
                  <textarea
                    value={slot.negative}
                    rows={3}
                    onChange={(e) => setSlot(index, { negative: e.target.value })}
                    className="w-full resize-y rounded-lg border border-foreground/15 ui-field p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-foreground/40"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <SlotNumField
                    label="steps"
                    value={slot.steps}
                    onChange={(v) => setSlot(index, { steps: v })}
                  />
                  <SlotNumField
                    label="guidance"
                    value={slot.guidance}
                    onChange={(v) => setSlot(index, { guidance: v })}
                  />
                  <SlotNumField
                    label="true_cfg"
                    value={slot.trueCfg}
                    onChange={(v) => setSlot(index, { trueCfg: v })}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={slot.imageSize}
                    onChange={(e) =>
                      setSlot(index, {
                        imageSize: e.target.value as BenchSlot["imageSize"],
                      })
                    }
                    className="rounded-lg border border-foreground/15 ui-field p-1.5 text-xs outline-none focus:border-foreground/40"
                  >
                    {GENERATION_IMAGE_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <select
                    value={slot.role}
                    onChange={(e) => setSlot(index, { role: e.target.value as RoleId })}
                    className="rounded-lg border border-foreground/15 ui-field p-1.5 text-xs outline-none focus:border-foreground/40"
                  >
                    {ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                    <input
                      type="checkbox"
                      checked={slot.wearsGlasses}
                      onChange={(e) => setSlot(index, { wearsGlasses: e.target.checked })}
                    />
                    안경
                  </label>
                </div>
                {index > 0 && (
                  <p className="text-[11px] text-zinc-400">
                    설정 1 대비:{" "}
                    {diffAgainstFirst(slot, slots[0]).join(" · ") || "동일"}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      <button
        type="button"
        onClick={() => void execute()}
        disabled={busy || slots.length === 0 || !file}
        className="mt-3 flex items-center justify-center gap-2 rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-foreground/5 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        실행 — 설정 {slots.length}개 × 2장 (fal 실비 과금)
      </button>

      {run && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-xs text-zinc-400">
            seed 쌍: {run.seeds.join(" · ")} (전 설정 공통) — 결과는 세션 일회성, 새로고침 시
            소실됩니다.
          </p>
          <div>
            <p className="text-[11px] font-semibold text-zinc-500">
              원본 (정규화 768×1024 · 서명 URL 10분 만료)
            </p>
            <div className="mt-1 h-40 w-32 overflow-hidden rounded-lg border border-foreground/10 bg-foreground/5">
              <FadeImg src={run.faceUrl} className="h-full w-full object-cover" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {Array.from({ length: run.settingCount }, (_, settingIndex) => (
              <div key={settingIndex} className="rounded-xl border border-foreground/10 p-3">
                <p className="text-xs font-bold text-foreground">설정 {settingIndex + 1}</p>
                {settingIndex > 0 && (
                  <p className="mt-0.5 text-[11px] text-zinc-400">
                    설정 1 대비: {run.diffs[settingIndex]?.join(" · ") || "동일"}
                  </p>
                )}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {run.requests
                    .filter((r) => r.settingIndex === settingIndex)
                    .map((r) => {
                      const status = r.requestId ? results[r.requestId] : null;
                      return (
                        <div key={r.imageIndex} className="flex flex-col gap-1">
                          <span className="text-[11px] text-zinc-400">
                            seed {run.seeds[r.imageIndex]}
                          </span>
                          <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-foreground/5">
                            {r.requestId === null ? (
                              <span className="p-2 text-center text-[11px] text-red-400">
                                제출 실패
                              </span>
                            ) : status?.status === "completed" && status.imageUrl ? (
                              <FadeImg
                                src={status.imageUrl}
                                className="h-full w-full object-cover"
                              />
                            ) : status?.status === "completed" && status.nsfw ? (
                              <span className="p-2 text-center text-[11px] text-orange-500">
                                안전 차단(NSFW)
                              </span>
                            ) : status?.status === "failed" ? (
                              <span className="p-2 text-center text-[11px] text-red-400">
                                실패
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 p-2 text-[11px] text-zinc-400">
                                <Spinner className="h-3 w-3" />
                                {status?.status === "in_progress" ? "생성중" : "대기중"}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
