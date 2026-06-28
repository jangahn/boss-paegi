"use client";

import { SERVICE_NAME } from "@/lib/policy";
import { PUBLIC_ENV } from "@/lib/env";
import { runShare, type ShareResult } from "@/lib/share";
import type { RoleId } from "@/lib/roles";
import { roleFrom, type RoleConfig } from "@/lib/config/domains/roles";
import { MARKETING_COPY_DEFAULT, type MarketingCopy } from "@/lib/config/domains/marketing";
import { resolveCopy } from "@/lib/config/template";

/** 워터마크에 박을 정규 호스트 — 공유 링크 도메인(SITE_URL)과 일치시킨다. */
function siteHost(): string {
  try {
    return new URL(PUBLIC_ENV.SITE_URL).host;
  } catch {
    return PUBLIC_ENV.SITE_URL;
  }
}

/**
 * 갤러리 커스텀 캐릭터의 저장/공유.
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
  ctx.fillText(`${SERVICE_NAME} · ${siteHost()}`, W - pad, H - pad);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("이미지 합성 실패"))),
      "image/png"
    )
  );
}

/**
 * 워터마크 이미지 + 공개 페이지 링크를 통일 공유 규약([[runShare]])으로.
 * - url 은 text 마지막 줄에 1개만 합성(분리 url 필드 미사용).
 * - 워터마크 합성 성공 시에만 file 첨부 후보; 첨부는 모바일 OS 에서만(데스크톱 자동 제외).
 * - 합성 실패/데스크톱/첨부 실패 → 문구+링크 공유 → 클립보드(문구 유실 없음).
 */
export async function shareDoll(
  imageUrl: string,
  dollId: string,
  role: RoleId = "boss",
  cfg?: RoleConfig,
  copy?: MarketingCopy
): Promise<ShareResult> {
  const pageUrl = `${PUBLIC_ENV.SITE_URL}/doll/${dollId}`;
  const c = roleFrom(role, cfg);
  const brandText = resolveCopy((copy ?? MARKETING_COPY_DEFAULT).share.dollShareText, c.label);

  let file: File | null = null;
  try {
    const composed = await composeWatermark(await fetchBlob(imageUrl));
    file = new File([composed], `boss-${dollId.slice(0, 8)}.png`, { type: "image/png" });
  } catch {
    // 합성/로드 실패 → 파일 없이 문구+링크 공유
  }

  return runShare({ brandText, url: pageUrl, title: SERVICE_NAME, file });
}
