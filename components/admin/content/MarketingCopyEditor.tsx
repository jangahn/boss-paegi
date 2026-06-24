"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import type { MarketingCopy } from "@/lib/config/domains/marketing";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { ROLE_IDS } from "@/lib/roles";
import { resolveCopy, unknownTokens } from "@/lib/config/template";
import { SurfaceDiagram, FIELD_SURFACE } from "@/components/admin/content/diagram/SurfaceDiagram";

// 미리보기용 샘플 값(값 토큰 자리). 실제론 런타임 값이 들어감.
const SAMPLE = {
  제작자: "홍길동",
  점수: "12,345",
  등급: "전설의 퇴사자",
  특이사항: "맞을수록 강해짐",
  상위: "3",
};

type Section = { key: keyof MarketingCopy; label: string; fields: Field[] };
type Field = { k: string; label: string; max: number; multiline?: boolean };

const SECTIONS: Section[] = [
  {
    key: "home",
    label: "홈 화면",
    fields: [
      { k: "tagline", label: "태그라인 (줄바꿈=여러 줄)", max: 120, multiline: true },
      { k: "primaryCta", label: "주 버튼(만들기)", max: 30 },
      { k: "secondaryCta", label: "보조 버튼(바로 시작)", max: 30 },
      { k: "disclaimer", label: "고지 (줄바꿈=여러 줄)", max: 240, multiline: true },
    ],
  },
  {
    key: "signupBanner",
    label: "가입 배너 (갤러리)",
    fields: [
      { k: "nonmemberTitle", label: "비회원 제목", max: 80 },
      { k: "nonmemberSub", label: "비회원 설명", max: 200, multiline: true },
      { k: "memberEmptyTitle", label: "회원·0캐릭터 제목", max: 80 },
      { k: "memberEmptySub", label: "회원·0캐릭터 설명", max: 200, multiline: true },
    ],
  },
  {
    key: "share",
    label: "공유·CTA 문구  ({호칭}=롤 호칭·조사 자동 / {제작자}{점수}{등급}{특이사항}=자동 입력)",
    fields: [
      { k: "dollHook", label: "인사기록 — 후킹 문구", max: 80 },
      { k: "dollCtaMake", label: "인사기록 — 만들기 버튼", max: 30 },
      { k: "dollCtaDefault", label: "인사기록 — 기본 캐릭터 버튼", max: 40 },
      { k: "dollShareText", label: "인사기록 — 웹 공유 텍스트", max: 160, multiline: true },
      { k: "dollOgTitle", label: "인사기록 — 공유 OG 제목", max: 80 },
      { k: "dollOgDesc", label: "인사기록 — 공유 OG 설명", max: 160, multiline: true },
      { k: "scoreHook", label: "점수공유 — 후킹(페르소나 보유 시)", max: 60 },
      { k: "scoreCtaPlay", label: "점수공유 — 패러 가기 버튼", max: 40 },
      { k: "scoreCtaPersona", label: "점수공유 — 페르소나 받기 버튼", max: 40 },
      { k: "scoreShareText", label: "점수공유 — 웹 공유 텍스트", max: 60 },
      { k: "scoreOgTitle", label: "점수공유 — 공유 OG 제목", max: 80 },
      { k: "gameoverShareBtn", label: "게임오버 — 공유 버튼", max: 30 },
      { k: "gameoverRetryBtn", label: "게임오버 — 다시 버튼", max: 20 },
    ],
  },
];

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "입력값이 형식에 맞지 않아요(길이 등). 빨간 칸을 확인하세요.",
  domain_not_ready: "아직 편집할 수 없는 영역이에요.",
  update_failed: "저장에 실패했어요. 잠시 후 다시 시도하세요.",
};

export function MarketingCopyEditor({
  initial,
  version,
  source,
  invalid,
}: {
  initial: MarketingCopy;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<MarketingCopy>(initial);
  const [baseVersion, setBaseVersion] = useState(version);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const roleCfg = useRoleConfig();
  const surf = focused ? FIELD_SURFACE[focused] : null;

  const setField = (section: keyof MarketingCopy, k: string, v: string) => {
    setForm((f) => ({ ...f, [section]: { ...f[section], [k]: v } }));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "marketing_copy", value: form, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
      };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 다음 로드부터 반영됩니다." });
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
    <div className="mt-5 flex flex-col gap-6">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 현재 코드 기본값으로 동작 중이에요. 아래에서 고쳐 발행하면 회복됩니다."
            : "아직 발행된 적 없어 코드 기본값을 보여줍니다. 발행하면 이 값이 적용됩니다."}
        </p>
      )}

      <p className="rounded-lg bg-foreground/5 p-2 text-[11px] leading-relaxed text-zinc-500">
        💡 일반 문구는 발행 후 바로 반영돼요. <b>공유 미리보기(OG) 이미지·제목은 최대 1시간</b> 늦게 바뀔 수 있어요(캐시). ·
        토큰: <code>{"{호칭}"}</code>=롤 호칭(조사 자동), <code>{"{제작자}/{점수}/{등급}/{특이사항}"}</code>=자동 입력.
      </p>
      {/* 스크롤 시 아래 필드가 비치지 않게 불투명 배경 밴드 + 하단 구분선 */}
      <div className="sticky top-0 z-20 -mx-1 border-b border-foreground/10 bg-background px-1 pb-2 pt-2">
        <SurfaceDiagram surface={surf?.surface ?? "home"} active={surf?.region} />
      </div>

      {SECTIONS.map((sec) => (
        <fieldset key={String(sec.key)} className="flex flex-col gap-3">
          <legend className="text-sm font-semibold text-zinc-500">{sec.label}</legend>
          {sec.fields.map((fld) => {
            const val = (form[sec.key] as Record<string, string>)[fld.k] ?? "";
            return (
              <label key={fld.k} className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">
                  {fld.label} <span className="text-zinc-400">({val.length}/{fld.max})</span>
                </span>
                {fld.multiline ? (
                  <textarea
                    value={val}
                    maxLength={fld.max}
                    onFocus={() => setFocused(fld.k)}
                    onChange={(e) => setField(sec.key, fld.k, e.target.value)}
                    className="h-16 w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
                  />
                ) : (
                  <input
                    value={val}
                    maxLength={fld.max}
                    onFocus={() => setFocused(fld.k)}
                    onChange={(e) => setField(sec.key, fld.k, e.target.value)}
                    className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
                  />
                )}
                {val.includes("{") && (
                  <div className="flex flex-col gap-0.5 rounded-lg bg-foreground/5 p-2 text-[11px] text-zinc-500">
                    {unknownTokens(val).length > 0 && (
                      <p className="text-red-400">
                        알 수 없는 토큰: {unknownTokens(val).join(", ")} — 저장되지 않아요
                      </p>
                    )}
                    {val.includes("{호칭") ? (
                      ROLE_IDS.map((rid) => (
                        <div key={rid} className="truncate">
                          <b className="text-zinc-400">{roleFrom(rid, roleCfg).label}</b> ·{" "}
                          {resolveCopy(val, roleFrom(rid, roleCfg).label, SAMPLE)}
                        </div>
                      ))
                    ) : (
                      <div className="truncate">
                        예시 · {resolveCopy(val, roleFrom("boss", roleCfg).label, SAMPLE)}
                      </div>
                    )}
                  </div>
                )}
              </label>
            );
          })}
        </fieldset>
      ))}

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
