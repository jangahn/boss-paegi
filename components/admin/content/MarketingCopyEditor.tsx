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

// 화면(표면) 단위 그룹. 그룹 안 필드 순서 = 실제 화면 렌더 순서. sec = 저장 도메인 내 위치.
type Field = {
  sec: keyof MarketingCopy;
  k: string;
  label: string;
  max: number;
  multiline?: boolean;
};
type Group = { label: string; fields: Field[] };

const GROUPS: Group[] = [
  {
    label: "홈 화면",
    fields: [
      { sec: "home", k: "tagline", label: "태그라인 (개행=여러 줄)", max: 120, multiline: true },
      { sec: "home", k: "primaryCta", label: "주 버튼", max: 30 },
      { sec: "home", k: "secondaryCta", label: "보조 버튼", max: 30 },
      { sec: "home", k: "disclaimer", label: "고지 (개행=여러 줄)", max: 240, multiline: true },
    ],
  },
  {
    label: "갤러리 — 비회원 배너",
    fields: [
      { sec: "signupBanner", k: "nonmemberTitle", label: "제목", max: 80 },
      { sec: "signupBanner", k: "nonmemberSub", label: "설명", max: 200, multiline: true },
      { sec: "signupBanner", k: "nonmemberCta", label: "버튼", max: 30 },
    ],
  },
  {
    label: "갤러리 — 회원·첫 캐릭터 전 배너",
    fields: [
      { sec: "signupBanner", k: "memberEmptyTitle", label: "제목", max: 80 },
      { sec: "signupBanner", k: "memberEmptySub", label: "설명", max: 200, multiline: true },
      { sec: "signupBanner", k: "memberEmptyCta", label: "버튼", max: 30 },
    ],
  },
  {
    label: "갤러리 — 헤더 버튼 (캐릭터 보유 회원)",
    fields: [
      { sec: "signupBanner", k: "memberHeaderCta", label: "새로 만들기 버튼", max: 30 },
    ],
  },
  {
    label: "캐릭터 공유 카드",
    fields: [
      { sec: "share", k: "dollHook", label: "후킹 문구", max: 80 },
      { sec: "share", k: "dollCtaMake", label: "만들기 버튼", max: 30 },
      { sec: "share", k: "dollCtaDefault", label: "기본 캐릭터 버튼", max: 40 },
      { sec: "share", k: "dollShareText", label: "웹 공유 텍스트", max: 160, multiline: true },
    ],
  },
  {
    label: "캐릭터 공유 미리보기 (OG)",
    fields: [
      { sec: "share", k: "dollOgTitle", label: "OG 제목", max: 80 },
      { sec: "share", k: "dollOgDesc", label: "OG 설명", max: 160, multiline: true },
    ],
  },
  {
    label: "점수 결과 보고서 공유",
    fields: [
      { sec: "share", k: "scoreHook", label: "후킹 문구", max: 60 },
      { sec: "share", k: "scoreCtaPlay", label: "패러 가기 버튼", max: 40 },
      { sec: "share", k: "scoreCtaPersona", label: "두 번째 버튼", max: 40 },
      { sec: "share", k: "scoreRankLink", label: "랭킹 보기 링크", max: 40 },
      { sec: "share", k: "scoreShareText", label: "웹 공유 텍스트", max: 60 },
    ],
  },
  {
    label: "점수 공유 미리보기 (OG)",
    fields: [{ sec: "share", k: "scoreOgTitle", label: "OG 제목 (메타)", max: 80 }],
  },
  {
    label: "게임 종료 화면",
    fields: [
      { sec: "share", k: "gameoverShareBtn", label: "공유 버튼", max: 30 },
      { sec: "share", k: "gameoverRetryBtn", label: "다시 버튼", max: 20 },
    ],
  },
  {
    label: "공통 (여러 화면에 함께 적용)",
    fields: [{ sec: "share", k: "reportTitle", label: "보고서 제목", max: 40 }],
  },
];

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "입력값이 형식에 맞지 않아요(길이·토큰 등). 빨간 칸을 확인하세요.",
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
  const surfs = focused ? FIELD_SURFACE[focused] ?? [] : [];

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
        💡 일반 문구는 발행 후 바로, <b>공유 미리보기(OG) 이미지·제목은 최대 1시간</b> 뒤 반영(캐시). ·
        토큰: <code>{"{호칭}"}</code>=롤 호칭(조사 자동), <code>{"{제작자}/{점수}/{등급}/{특이사항}"}</code>=자동 입력.
      </p>

      {/* 포커스한 필드가 실제 들어가는 화면(들) 미리보기 — 스크롤 시 비침 방지 불투명 밴드 */}
      <div className="sticky top-14 z-20 -mx-1 border-b border-foreground/10 bg-background px-1 pb-2 pt-2">
        {surfs.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-2">
            {surfs.map((s, i) => (
              <div key={`${s.surface}-${i}`} className="min-w-[200px] flex-1">
                <SurfaceDiagram surface={s.surface} active={s.region} />
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-[11px] text-zinc-400">
            아래 입력칸을 선택하면 그 문구가 들어가는 화면이 여기 표시돼요.
          </p>
        )}
      </div>

      {GROUPS.map((g) => (
        <fieldset key={g.label} className="flex flex-col gap-3">
          <legend className="text-sm font-semibold text-zinc-500">{g.label}</legend>
          {g.fields.map((fld) => {
            const val = (form[fld.sec] as Record<string, string>)[fld.k] ?? "";
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
                    onChange={(e) => setField(fld.sec, fld.k, e.target.value)}
                    className="h-16 w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
                  />
                ) : (
                  <input
                    value={val}
                    maxLength={fld.max}
                    onFocus={() => setFocused(fld.k)}
                    onChange={(e) => setField(fld.sec, fld.k, e.target.value)}
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
