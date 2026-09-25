// 소식 본문 이미지 크기(v1.60) — 어드민이 본문에 이미지를 넣을 때 가로세로를 주소 조각(`…/uuid.png#1731x909`)으로 함께 기록하고,
// 렌더러(components/events/Markdown.tsx)가 그 비율로 자리를 먼저 잡는다. 크기 정보가 없던 종전에는 이미지가 도착하면서 본문 전체가
// 아래로 밀렸다(2026-09-25 실측: 소식 상세 176px, CLS 0.11).
// 주소 조각은 요청에 실리지 않아 이미지 주소·캐시에 영향이 없고, 마크다운 문법 안에 그대로 남아 본문 편집에도 보존된다.
// 크기 정보가 없는 이미지(종전 글, 손으로 붙인 주소)는 커버·공유 이미지와 같은 40:21 자리에 맞춘다 — 종전 글의 이미지(1731×909)는
// 정확히 40:21 이라 그대로 보인다.

export type EventImageSize = { width: number; height: number };

// 가로세로 각 1~5자리 정수. 조각이 이 형식이 아니면 크기 정보 없음으로 본다.
const SIZE_FRAGMENT = /#(\d{1,5})x(\d{1,5})$/;

/** 본문 이미지 주소에서 크기 조각을 떼어 낸다 — url 은 조각을 뺀 실제 이미지 주소. */
export function parseEventImageSrc(src: string): { url: string; size: EventImageSize | null } {
  const match = SIZE_FRAGMENT.exec(src);
  if (!match) return { url: src, size: null };
  const width = Number(match[1]);
  const height = Number(match[2]);
  const url = src.slice(0, match.index);
  return width > 0 && height > 0 ? { url, size: { width, height } } : { url, size: null };
}

/** 본문의 첫 이미지 주소(마크다운 `![…](주소)`) — 상단 대표 이미지를 lazy 대신 바로 받기 위해 쓴다. 없으면 null. */
export function firstMarkdownImageSrc(markdown: string): string | null {
  const match = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/.exec(markdown);
  return match ? match[1] : null;
}

/** 이미지 주소 뒤에 크기 조각을 붙인다(업로드 직후 본문에 넣을 때). */
export function withEventImageSize(url: string, size: EventImageSize): string {
  return `${url}#${Math.round(size.width)}x${Math.round(size.height)}`;
}

// 폭별 변환본(v1.61) — 원본(예: PNG 2.2MB)을 그대로 받던 것을 Supabase 이미지 변환(WebP, 폭 750 약 61KB)으로 바꾼다.
// 폭 후보는 휴대폰 2~3배 DPR 과 데스크톱 본문 칸(최대 672px)을 덮는다. 원본보다 넓게 늘리지 않는다.
// width 만 주면 height 가 안 줄어드는 Supabase 함정 때문에 항상 width + height + contain(lib/site-assets.ts 와 같은 규칙).
const RENDER_WIDTHS = [750, 1080, 1440] as const;
/** 소식 본문 칸 최대 폭(max-w-2xl) — 좌우 여백 20px 씩(app/news/[id]/page.tsx). */
const BODY_MAX_WIDTH = 672;
const BODY_GUTTER = 40;
const OBJECT_MARKER = "/storage/v1/object/public/";
const RENDER_MARKER = "/storage/v1/render/image/public/";

/**
 * 본문 이미지의 폭별 변환 주소(src · srcSet · sizes). 크기를 모르면 40:21 자리 비율로 만든다. 공개 버킷 주소가 아니면 null(원본 그대로).
 */
export function eventImageVariants(
  url: string,
  size: EventImageSize | null,
): { src: string; srcSet: string; sizes: string } | null {
  const at = url.indexOf(OBJECT_MARKER);
  if (at < 0) return null;
  const base = `${url.slice(0, at)}${RENDER_MARKER}${url.slice(at + OBJECT_MARKER.length)}`;
  const ratio = size ? size.height / size.width : 21 / 40;
  const widths = [...new Set(RENDER_WIDTHS.map((w) => Math.min(w, size?.width ?? w)))];
  const variant = (w: number) => `${base}?width=${w}&height=${Math.max(1, Math.round(w * ratio))}&resize=contain`;
  const shown = Math.min(size?.width ?? BODY_MAX_WIDTH, BODY_MAX_WIDTH);
  return {
    src: variant(widths[widths.length - 1]),
    srcSet: widths.map((w) => `${variant(w)} ${w}w`).join(", "),
    sizes: `(min-width: ${shown + BODY_GUTTER}px) ${shown}px, calc(100vw - ${BODY_GUTTER}px)`,
  };
}

/**
 * 고른 이미지 파일의 가로세로(브라우저 전용) — 화면에 그려질 방향(EXIF 회전 반영) 그대로의 크기. 읽지 못하면 null
 * (본문에는 크기 조각 없이 들어가 40:21 자리를 쓴다).
 */
export function readImageFileSize(file: Blob): Promise<EventImageSize | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = new window.Image();
    probe.onload = () => {
      const size = { width: probe.naturalWidth, height: probe.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(size.width > 0 && size.height > 0 ? size : null);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    probe.src = url;
  });
}
