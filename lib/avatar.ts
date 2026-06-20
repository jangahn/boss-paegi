"use client";

import { createClient } from "@/lib/supabase/client";

const BUCKET = "avatars";
const MAX_DIM = 512;

/** 선택 이미지를 정사각 512px 이내로 다운스케일 → webp blob (업로드 비용·노출 크기 절감). */
async function downscale(file: File): Promise<Blob> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unsupported");
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9)
  );
  if (!blob) throw new Error("encode failed");
  return blob;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * 프로필 사진 업로드 — 다운스케일 → 서명 URL → 직접 업로드 → 검증/반영.
 * @returns 반영된 public avatar URL
 */
export async function uploadAvatar(file: File): Promise<string> {
  const blob = await downscale(file);
  const mime = blob.type || "image/webp";

  const r1 = await fetch("/api/avatar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mime }),
  });
  if (!r1.ok) throw new Error("업로드 준비에 실패했어요");
  const { path, token } = (await r1.json()) as { path: string; token: string };

  const sb = createClient();
  const { error: upErr } = await sb.storage
    .from(BUCKET)
    .uploadToSignedUrl(path, token, blob, { contentType: mime });
  if (upErr) throw new Error("업로드에 실패했어요");

  const r2 = await fetch("/api/avatar", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r2.ok) throw new Error("프로필 반영에 실패했어요");
  const { avatarUrl } = (await r2.json()) as { avatarUrl: string };
  return avatarUrl;
}
