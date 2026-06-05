"use client";

import { useCallback, useState } from "react";
import Cropper, { Area } from "react-easy-crop";

type Props = {
  imageUrl: string;
  /** crop 확정 시 호출. 3:4 비율 JPEG Blob 반환. */
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
};

const ASPECT = 3 / 4;

export function PhotoCropper({ imageUrl, onConfirm, onCancel }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedArea(pixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedArea) return;
    setBusy(true);
    try {
      const blob = await cropToBlob(imageUrl, croppedArea);
      onConfirm(blob);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="text-center">
        <h2 className="text-xl font-bold">얼굴 위치 맞추기</h2>
        <p className="mt-1 text-sm text-zinc-500">
          드래그로 위치, 두 손가락(또는 슬라이더)으로 줌
        </p>
      </div>

      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-black">
        <Cropper
          image={imageUrl}
          crop={crop}
          zoom={zoom}
          minZoom={1}
          maxZoom={4}
          aspect={ASPECT}
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

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-foreground/15 py-3 font-medium transition hover:bg-foreground/5 disabled:opacity-30"
        >
          다시 선택
        </button>
        <button
          onClick={handleConfirm}
          disabled={busy || !croppedArea}
          className="rounded-full bg-foreground py-3 font-semibold text-background transition disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy ? "처리 중…" : "이대로 만들기"}
        </button>
      </div>
    </div>
  );
}

async function cropToBlob(imageUrl: string, area: Area): Promise<Blob> {
  const img = await loadImage(imageUrl);
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
