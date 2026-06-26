"use client";

import { useRef, useState } from "react";
import { PhotoCropper } from "@/components/PhotoCropper";
import { ModalShell } from "@/components/ModalShell";
import { uploadAvatar, removeAvatar } from "@/lib/avatar";
import { Spinner } from "@/components/Spinner";

/**
 * 프로필 사진 변경/삭제 — 인형 생성과 동일한 크롭 UX(정사각). 너무 작으면 128, 크면 512 로 정규화.
 * onSaved(null) = 기본 프사로 삭제됨.
 */
export function AvatarEditor({
  current,
  hasCustomAvatar,
  onClose,
  onSaved,
}: {
  current: string;
  hasCustomAvatar: boolean;
  onClose: () => void;
  onSaved: (url: string | null) => void;
}) {
  const [src, setSrc] = useState<string | null>(null); // 선택된 원본 objectURL (크롭 대상)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File) => {
    setError(null);
    if (!f.type.startsWith("image/")) {
      setError("이미지 파일만 올릴 수 있어요");
      return;
    }
    if (src) URL.revokeObjectURL(src);
    setSrc(URL.createObjectURL(f));
  };

  const onRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeAvatar();
      onSaved(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
      setBusy(false);
    }
  };

  const onConfirm = async (blob: Blob) => {
    setBusy(true);
    setError(null);
    try {
      const url = await uploadAvatar(blob);
      if (src) URL.revokeObjectURL(src);
      onSaved(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "업로드 실패");
      setBusy(false);
    }
  };

  // ── 크롭 단계 ──
  if (src) {
    return (
      <ModalShell wide onClose={busy ? () => {} : onClose}>
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
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">프로필 사진 변경</h2>
      <p className="mt-1 text-xs text-zinc-500">
        랭킹에 표시되는 사진이에요. 정사각형으로 잘려요.
      </p>
      <div className="mt-4 flex flex-col items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current}
          alt=""
          className="h-28 w-28 rounded-full border border-foreground/15 object-cover"
        />
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
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-foreground/15 ui-surface px-5 py-2.5 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
        >
          사진 선택
        </button>
        {hasCustomAvatar && (
          <button
            type="button"
            onClick={() => void onRemove()}
            disabled={busy}
            className="flex items-center gap-1.5 text-sm text-red-400 transition hover:text-red-500 disabled:opacity-50"
          >
            {busy && <Spinner className="h-3.5 w-3.5" />}
            기본 사진으로 되돌리기
          </button>
        )}
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
