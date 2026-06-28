"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { createClient } from "@/lib/supabase/client";
import { SITE_ASSETS_BUCKET } from "@/lib/storage-path";
import type { MediaConfig } from "@/lib/config/domains/media-config";

const ERR_KO: Record<string, string> = {
  version_conflict: "다른 곳에서 먼저 변경됐어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "이미지 경로 형식이 맞지 않아요. 다시 업로드해 주세요.",
  domain_not_ready: "아직 편집할 수 없는 영역이에요.",
  update_failed: "저장에 실패했어요. 잠시 후 다시 시도하세요.",
  invalid_mime: "JPG·PNG·WebP 이미지만 업로드할 수 있어요.",
  invalid_slot: "잘못된 항목이에요.",
  invalid_path: "업로드 경로가 올바르지 않아요. 다시 시도하세요.",
  signed_url_failed: "업로드 준비에 실패했어요. 다시 시도하세요.",
  upload_failed: "업로드에 실패했어요. 다시 시도하세요.",
  upload_init_failed: "업로드 준비에 실패했어요. 다시 시도하세요.",
  upload_confirm_failed: "업로드 확인에 실패했어요. 다시 시도하세요.",
  upload_missing: "업로드가 확인되지 않았어요. 다시 시도하세요.",
  rejected: "이미지가 거부됐어요(형식·5MB 초과). 다른 파일로 시도하세요.",
};

type Slot = "og" | "logo";

// 슬롯별 권장 사양·미리보기 박스(소비 transform 과 같은 종횡비).
const SLOTS: Record<
  Slot,
  { label: string; hint: string; box: string; fit: "cover" | "contain"; minW: number; minH: number }
> = {
  og: {
    label: "기본 OG 공유 이미지",
    hint: "카카오·X 등 공유 시 뜨는 미리보기 이미지. 권장 1200×630 (1.91:1). 미설정 시 기본 이미지를 사용합니다.",
    box: "aspect-[40/21] w-full max-w-sm",
    fit: "cover",
    minW: 1200,
    minH: 630,
  },
  logo: {
    label: "서비스 로고",
    hint: "홈·로그인 상단 로고. 투명 배경 PNG/WebP 권장, 정사각에 가깝게. 미설정 시 기본 로고를 사용합니다.",
    box: "aspect-square w-28",
    fit: "contain",
    minW: 320,
    minH: 320,
  },
};

type SlotState = { og: string | null; logo: string | null };

export function MediaConfigEditor({
  initial,
  initialPreviews,
  version,
  source,
  invalid,
}: {
  initial: MediaConfig;
  initialPreviews: SlotState;
  version: number;
  source: "db" | "default";
  invalid: boolean;
}) {
  const router = useRouter();
  const [paths, setPaths] = useState<MediaConfig>(initial);
  const [previews, setPreviews] = useState<SlotState>(initialPreviews);
  const [warn, setWarn] = useState<SlotState>({ og: null, logo: null });
  const [baseVersion, setBaseVersion] = useState(version);
  const [uploading, setUploading] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const pathOf = (slot: Slot) => (slot === "og" ? paths.ogImagePath : paths.logoPath);
  const setSlotPath = (slot: Slot, p: string | null) =>
    setPaths((s) => (slot === "og" ? { ...s, ogImagePath: p } : { ...s, logoPath: p }));

  // 2-step 서명 업로드(site-asset) → { path, previewUrl(작은 transform) }. raw URL 미수신.
  const upload = async (file: File, slot: Slot): Promise<{ path: string; previewUrl: string }> => {
    const r1 = await fetch("/api/admin/site-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mime: file.type, slot }),
    });
    const d1 = (await r1.json()) as { path?: string; token?: string; error?: string };
    if (!r1.ok || !d1.path || !d1.token) throw new Error(d1.error ?? "upload_init_failed");
    const sb = createClient();
    const { error } = await sb.storage.from(SITE_ASSETS_BUCKET).uploadToSignedUrl(d1.path, d1.token, file);
    if (error) throw new Error("upload_failed");
    const r2 = await fetch("/api/admin/site-asset", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: d1.path, slot }),
    });
    const d2 = (await r2.json()) as { path?: string; previewUrl?: string; error?: string };
    if (!r2.ok || !d2.path || !d2.previewUrl) throw new Error(d2.error ?? "upload_confirm_failed");
    return { path: d2.path, previewUrl: d2.previewUrl };
  };

  // 저해상도 경고(차단 아님) — 자연 크기가 권장 미만이면 안내만.
  const checkLowRes = (file: File, slot: Slot) => {
    const url = URL.createObjectURL(file);
    const probe = new window.Image();
    probe.onload = () => {
      const { minW, minH } = SLOTS[slot];
      const low = probe.naturalWidth < minW || probe.naturalHeight < minH;
      setWarn((w) => ({
        ...w,
        [slot]: low
          ? `해상도가 낮아요 (${probe.naturalWidth}×${probe.naturalHeight}). 권장 ${minW}×${minH} 이상 — 흐리게 보일 수 있어요.`
          : null,
      }));
      URL.revokeObjectURL(url);
    };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  };

  const onPick = async (file: File | undefined, slot: Slot) => {
    if (!file || uploading) return;
    setUploading(slot);
    setMsg(null);
    checkLowRes(file, slot);
    try {
      const { path, previewUrl } = await upload(file, slot);
      setSlotPath(slot, path);
      setPreviews((p) => ({ ...p, [slot]: previewUrl }));
    } catch (e) {
      const code = (e as Error).message;
      setMsg({ ok: false, text: ERR_KO[code] ?? "업로드 실패" });
    } finally {
      setUploading(null);
    }
  };

  const onRemove = (slot: Slot) => {
    setSlotPath(slot, null);
    setPreviews((p) => ({ ...p, [slot]: null }));
    setWarn((w) => ({ ...w, [slot]: null }));
  };

  const submit = async () => {
    if (busy || uploading) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "media_config", value: paths, baseVersion }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; version?: number; error?: string };
      if (res.ok && out.ok) {
        setBaseVersion(out.version ?? baseVersion + 1);
        setMsg({ ok: true, text: "발행됐어요. 공유 이미지·로고가 다음 로드부터 반영됩니다." });
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

  const renderSlot = (slot: Slot) => {
    const s = SLOTS[slot];
    const preview = previews[slot];
    const has = !!pathOf(slot);
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-foreground/10 ui-surface p-4">
        <span className="text-sm font-semibold">{s.label}</span>
        <p className="text-xs text-zinc-500">{s.hint}</p>
        {/* 모바일: 미리보기 위·버튼 아래로 스택(w-full 미리보기가 버튼을 밀어내 잘리던 것 방지). 데스크톱: 가로 배치 */}
        <div className="mt-1 flex flex-col items-start gap-3 sm:flex-row sm:gap-4">
          {preview ? (
            <FadeImg
              src={preview}
              className={`${s.box} shrink-0 rounded-xl border border-foreground/10`}
              fit={s.fit}
              placeholder="gray"
            />
          ) : (
            <div
              className={`${s.box} grid shrink-0 place-items-center rounded-xl border border-dashed border-foreground/20 text-[11px] text-zinc-400`}
            >
              미설정 · 기본값
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-foreground/20 px-3 py-1.5 text-xs hover:bg-foreground/5">
              {uploading === slot ? <Spinner className="h-3.5 w-3.5" /> : has ? "변경" : "업로드"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => void onPick(e.target.files?.[0], slot)}
              />
            </label>
            {has && (
              <button
                type="button"
                onClick={() => onRemove(slot)}
                className="text-xs text-red-400 hover:underline"
              >
                기본값으로 되돌리기
              </button>
            )}
          </div>
        </div>
        {warn[slot] && <p className="text-[11px] text-amber-600 dark:text-amber-400">{warn[slot]}</p>}
      </div>
    );
  };

  return (
    <div className="mt-5 flex flex-col gap-5">
      {(source === "default" || invalid) && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {invalid
            ? "저장된 설정이 형식에 맞지 않아 기본 이미지로 동작 중이에요. 다시 업로드해 발행하면 회복됩니다."
            : "아직 발행된 적 없어 기본 이미지·로고를 사용 중이에요. 업로드해 발행하면 적용됩니다."}
        </p>
      )}
      <p className="rounded-lg bg-foreground/5 p-2 text-[11px] leading-relaxed text-zinc-500">
        💡 업로드한 이미지는 자동으로 용량 최적화(서버 리사이즈)되어 공유 미리보기·로고로 쓰입니다. 발행 후 다음 로드부터 반영(공유 이미지는 캐시로 최대 1시간 지연될 수 있어요). 파비콘은 여기서 관리하지 않습니다.
      </p>

      {renderSlot("og")}
      {renderSlot("logo")}

      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-400"}`}>{msg.text}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || uploading !== null}
        className="flex items-center justify-center gap-2 rounded-full bg-foreground py-3 text-sm font-semibold text-paper-2 transition hover:opacity-90 disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        발행
      </button>
    </div>
  );
}
