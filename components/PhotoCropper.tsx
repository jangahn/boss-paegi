"use client";

import { useCallback, useState } from "react";
import Cropper, { Area } from "react-easy-crop";
import { assessFaceCrop, type FaceQualityReason } from "@/lib/image-quality";

type Props = {
  imageUrl: string;
  /** crop 확정 시 호출. crop 영역 JPEG Blob 반환. */
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
  /** crop 비율 (default 3:4 — 인형 생성용). 아바타는 1. */
  aspect?: number;
  /** 얼굴 화질 검사 (default true — 인형용). 아바타는 false. */
  assessQuality?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export function PhotoCropper({
  imageUrl,
  onConfirm,
  onCancel,
  aspect = 3 / 4,
  assessQuality = true,
  title = "얼굴 위치 맞추기",
  subtitle = "드래그로 위치, 두 손가락(또는 슬라이더)으로 줌",
  confirmLabel = "이대로 만들기",
  cancelLabel = "다른 사진 선택",
}: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState<FaceQualityReason | null>(null);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedArea(pixels);
    setReject(null); // 크롭 조정하면 이전 거부 메시지 초기화
  }, []);

  const handleConfirm = async () => {
    if (!croppedArea) return;
    setBusy(true);
    setReject(null);
    try {
      const img = await loadImage(imageUrl);
      // 저화질(작거나 흐린) 얼굴은 깨진 캐릭터를 만들므로 생성 전 차단 (인형 전용)
      if (assessQuality) {
        const quality = assessFaceCrop(img, croppedArea);
        if (!quality.ok) {
          setReject(quality.reason);
          return;
        }
      }
      const blob = await cropToBlob(img, croppedArea);
      onConfirm(blob);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="text-center">
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
      </div>

      {/* sentry-block-face: 크롭 중인 원본 사진은 Session Replay 에서 차단(정책 #1/PIPA) */}
      <div
        data-sentry-block
        style={{ aspectRatio: String(aspect) }}
        className="sentry-block-face relative w-full overflow-hidden rounded-2xl bg-black"
      >
        <Cropper
          image={imageUrl}
          crop={crop}
          zoom={zoom}
          minZoom={1}
          maxZoom={4}
          aspect={aspect}
          showGrid={true}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
        />
      </div>

      <div className="flex items-center gap-3 px-1">
        <span className="text-xs text-zinc-500">−</span>
        <input
          type="range"
          min={1}
          max={4}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1 accent-foreground"
        />
        <span className="text-xs text-zinc-500">+</span>
      </div>

      {reject && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-semibold text-amber-300">
            {reject === "low_res"
              ? "얼굴 영역이 너무 작아요"
              : "사진이 흐릿해요"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-300">
            {reject === "low_res"
              ? "더 크게 나오거나 더 고해상도인 얼굴 사진을 써주세요. 이 사진으로는 캐릭터가 깨질 수 있어요."
              : "또렷하게 찍힌 정면 얼굴 사진을 써주세요. 흐린 사진은 캐릭터가 깨질 수 있어요."}
          </p>
          <p className="mt-1.5 text-[11px] text-zinc-500">
            밝은 곳에서 · 정면으로 · 또렷하게 찍힌 사진일수록 더 닮게 나와요.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-foreground/15 bg-paper-2 py-3 font-medium transition hover:bg-foreground/5 disabled:opacity-30"
        >
          {cancelLabel}
        </button>
        <button
          onClick={handleConfirm}
          disabled={busy || !croppedArea}
          className="rounded-full bg-foreground py-3 font-semibold text-paper-2 transition disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy ? "처리 중…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}

async function cropToBlob(img: HTMLImageElement, area: Area): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(area.width);
  canvas.height = Math.round(area.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    area.width,
    area.height
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.92
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
