"use client";

import { createClient } from "@/lib/supabase/client";

const BUCKET = "avatars";
const MIN_DIM = 128;
const MAX_DIM = 512;

/**
 * 정사각 crop blob → 128~512 정사각 webp 로 정규화.
 * 너무 작으면 128×128 로 업스케일, 너무 크면 512×512 로 다운스케일.
 */
async function normalizeSquare(blob: Blob): Promise<Blob> {
  const img = await loadImage(blob);
  const src = Math.min(img.width, img.height); // crop 은 정사각이지만 방어적으로 min
  const target = Math.min(MAX_DIM, Math.max(MIN_DIM, src));
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unsupported");
  const sx = (img.width - src) / 2;
  const sy = (img.height - src) / 2;
  ctx.drawImage(img, sx, sy, src, src, 0, 0, target, target);
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9)
  );
  if (!out) throw new Error("encode failed");
  return out;
}

function loadImage(src: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(src);
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
 * 프로필 사진 업로드 — 정사각 crop blob 정규화 → 서명 URL → 직접 업로드 → 검증/반영.
 * @param cropped PhotoCropper 가 만든 1:1 crop blob
 * @returns 반영된 public avatar URL
 */
export async function uploadAvatar(cropped: Blob): Promise<string> {
  const blob = await normalizeSquare(cropped);
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

/** 프로필 사진 삭제 → 기본 프사로 복귀. */
export async function removeAvatar(): Promise<void> {
  const r = await fetch("/api/avatar", { method: "DELETE" });
  if (!r.ok) throw new Error("기본 사진으로 되돌리지 못했어요");
}
