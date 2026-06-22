"use client";

import { SERVICE_NAME } from "@/lib/policy";
import { getRoleContent, type RoleId } from "@/lib/roles";

/**
 * 갤러리 커스텀 인형의 저장/공유.
 * - 저장: share-first — 모바일은 공유 시트의 "이미지 저장" 으로 사진 앱에
 *   바로 (iOS 는 OS 가 사진 권한 팝업 처리). 미지원 환경은 다운로드 fallback.
 * - 공유: 이미지 + /doll/[id] 공개 페이지 링크를 Web Share 로.
 * - 워터마크: 우하단에 작고 어색하지 않게 (반투명 + 그림자) — 저장/공유 공통.
 */

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error("이미지를 불러오지 못했어요");
  return await r.blob();
}

/** 우하단 작은 워터마크 합성 — 캔버스 크기는 원본 그대로 */
async function composeWatermark(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const W = bitmap.width;
  const H = bitmap.height;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const fontSize = Math.max(14, Math.round(W * 0.026));
  const pad = Math.round(W * 0.03);
  ctx.font = `600 ${fontSize}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  ctx.textBaseline = "bottom";
  ctx.textAlign = "right";
  // 밝은 배경/어두운 배경 어디 깔려도 보이게: 반투명 흰 글씨 + 어두운 그림자
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = fontSize * 0.35;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(`${SERVICE_NAME} · ${location.host}`, W - pad, H - pad);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("이미지 합성 실패"))),
      "image/png"
    )
  );
}

export type ShareResult = "shared" | "copied" | "failed";

/** 워터마크 이미지 + 공개 페이지 링크를 Web Share 로. fallback 링크 복사. */
export async function shareDoll(
  imageUrl: string,
  dollId: string,
  role: RoleId = "boss"
): Promise<ShareResult> {
  const pageUrl = `${location.origin}/doll/${dollId}`;
  const c = getRoleContent(role);
  const text = `내가 만든 ${c.targetObj} 소개합니다. ${c.ctaSafe}`;

  try {
    const composed = await composeWatermark(await fetchBlob(imageUrl));
    const file = new File([composed], `boss-${dollId.slice(0, 8)}.png`, {
      type: "image/png",
    });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: SERVICE_NAME,
        text: `${text}\n${pageUrl}`,
      });
      return "shared";
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return "shared"; // 사용자가 시트 닫음
    // 합성/파일 공유 실패 → 링크 공유로 fallback
  }

  try {
    if (navigator.share) {
      await navigator.share({ title: SERVICE_NAME, text, url: pageUrl });
      return "shared";
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return "shared";
  }

  try {
    await navigator.clipboard.writeText(pageUrl);
    return "copied";
  } catch {
    // 구형/권한 제한 환경 fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = pageUrl;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok ? "copied" : "failed";
    } catch {
      return "failed";
    }
  }
}
