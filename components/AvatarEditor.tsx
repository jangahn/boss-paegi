"use client";

import { useRef, useState } from "react";
import { PhotoCropper } from "@/components/PhotoCropper";
import { ModalShell } from "@/components/ModalShell";
import { uploadAvatar, uploadPresetAvatar } from "@/lib/avatar";
import { AVATAR_PRESET_INDEXES, avatarPresetUrl } from "@/lib/avatar-presets";
import { Spinner } from "@/components/Spinner";
import { useClientOperationScope } from "@/lib/use-client-operation-scope";

/**
 * 프로필 사진 변경/삭제 — 캐릭터 생성과 동일한 크롭 UX(정사각). 너무 작으면 128, 크면 512 로 정규화.
 * v1.41: 캐릭터 프리셋 5장 중 골라 그대로 올리는 경로 추가(`uploadPresetAvatar`, 알파 PNG 보존).
 * v1.44: "기본 사진으로 되돌리기"(DELETE) 제거 — 프리셋 5장 중 고르기가 그 역할을 대신한다(기본 프사 = 유저별 고정 프리셋).
 */
export function AvatarEditor({
  current,
  onClose,
  onSaved,
}: {
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null); // 선택된 원본 objectURL (크롭 대상)
  const [busy, setBusy] = useState(false);
  const [presetBusy, setPresetBusy] = useState<number | null>(null); // 업로드 중인 프리셋 번호
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const runScopedOperation = useClientOperationScope();

  const pickFile = (f: File) => {
    setError(null);
    if (!f.type.startsWith("image/")) {
      setError("이미지 파일만 올릴 수 있어요");
      return;
    }
    if (src) URL.revokeObjectURL(src);
    setSrc(URL.createObjectURL(f));
  };

  const onPreset = async (index: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPresetBusy(index);
    setError(null);
    try {
      const url = await runScopedOperation((signal) =>
        uploadPresetAvatar(index, { signal }),
      );
      onSaved(url);
    } catch (e) {
      busyRef.current = false;
      setError(e instanceof Error ? e.message : "업로드 실패");
      setBusy(false);
      setPresetBusy(null);
    }
  };

  const onConfirm = async (blob: Blob) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const url = await runScopedOperation((signal) =>
        uploadAvatar(blob, { signal }),
      );
      if (src) URL.revokeObjectURL(src);
      onSaved(url);
    } catch (e) {
      busyRef.current = false;
      setError(e instanceof Error ? e.message : "업로드 실패");
      setBusy(false);
    }
  };

  // ── 크롭 단계 ──
  if (src) {
    return (
      <ModalShell ariaLabel="프로필 사진 맞추기" wide onClose={busy ? () => {} : onClose}>
        {busy ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <Spinner className="h-6 w-6" />
            <p className="text-sm text-zinc-500">프로필 사진 올리는 중…</p>
          </div>
        ) : (
          <PhotoCropper
            imageUrl={src}
            aspect={1}
            assessQuality={false}
            title="프로필 사진 맞추기"
            subtitle="드래그로 위치, 슬라이더로 크기 조절"
            confirmLabel="이 사진으로"
            cancelLabel="다른 사진"
            onConfirm={onConfirm}
            onCancel={() => {
              if (src) URL.revokeObjectURL(src);
              setSrc(null);
            }}
          />
        )}
        {error && <p className="mt-3 text-center text-xs text-red-400">{error}</p>}
      </ModalShell>
    );
  }

  // ── 사진 선택 단계 ──
  return (
    <ModalShell ariaLabel="프로필 사진 변경" onClose={onClose}>
      <h2 className="text-lg font-bold">프로필 사진 변경</h2>
      <p className="mt-1 text-xs text-zinc-500">
        랭킹에 표시되는 사진이에요. 캐릭터 중에서 고르거나 사진을 올려요(정사각형으로 잘려요).
      </p>
      <div className="mt-4 flex flex-col items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current}
          alt=""
          className="h-28 w-28 rounded-full border border-foreground/15 object-cover"
        />
        {/* 캐릭터 프리셋 고르기 — 탭하면 바로 그 캐릭터로 저장(A 방식: 프리셋 PNG 를 커스텀 프사로 업로드) */}
        <div className="w-full">
          <p className="text-center text-xs text-zinc-500">캐릭터로 고르기</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            {AVATAR_PRESET_INDEXES.map((i) => (
              <button
                key={`${i}-${busy ? "busy" : "idle"}`}
                type="button"
                onClick={() => void onPreset(i)}
                disabled={busy}
                aria-label={`캐릭터 ${i}번으로 지정`}
                className="relative h-12 w-12 shrink-0 transform-gpu overflow-hidden rounded-full border border-foreground/15 transition hover:border-foreground/40 disabled:opacity-50"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={avatarPresetUrl(i)} alt="" className="h-full w-full object-cover" />
                {presetBusy === i && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Spinner className="h-4 w-4" />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
          }}
        />
        {/* busy 토글마다 re-key + transform-gpu — iOS WebKit 이 opacity 전환/내용 이동이 있는
            텍스트 레이어를 잘못 갱신해 옛 글자 잔상이 겹치는 문제의 검증된 처방
            (궁극기 게이지 선례: components/ScoreBoard.tsx 주석 참조). */}
        <button
          key={busy ? "pick-busy" : "pick-idle"}
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="transform-gpu rounded-full border border-foreground/15 ui-surface px-5 py-2.5 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
        >
          사진 선택
        </button>
      </div>
      {error && <p className="mt-3 text-center text-xs text-red-400">{error}</p>}
      <button
        type="button"
        onClick={onClose}
        className="mt-4 w-full rounded-full border border-foreground/15 ui-surface py-2.5 text-sm font-medium transition hover:bg-foreground/5"
      >
        닫기
      </button>
    </ModalShell>
  );
}
