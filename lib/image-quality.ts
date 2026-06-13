/**
 * 클라이언트 얼굴 사진 화질 판정 — 저화질 입력으로 깨진 캐릭터가 나오기 전 차단.
 *
 * 두 신호로 판정:
 *  1) native 해상도: 크롭 영역의 원본 픽셀 짧은변 (작으면 PuLID 가 뭉갬)
 *  2) 선명도: Laplacian variance (낮을수록 흐림) — 해상도 의존이라 ≤512 로 정규화 후 계산
 *
 * 임계값은 시작값이며 실사용 데이터로 캘리브레이션 필요.
 * (server-only 아님 — 브라우저 canvas 에서만 동작)
 */

/** react-easy-crop 의 Area 와 구조적으로 호환되는 최소 타입 */
export type CropRect = { x: number; y: number; width: number; height: number };

export type FaceQualityReason = "low_res" | "blurry";
export type FaceQuality =
  | { ok: true; nativePx: number; sharpness: number }
  | { ok: false; reason: FaceQualityReason; nativePx: number; sharpness: number };

/**
 * 크롭 짧은변 native 픽셀 하한. 300 → 300px대 크롭까지 통과(그 안 얼굴 ~150-200px).
 * 그 이하는 PuLID 가 뭉개기 쉬워 차단. (필요 시 캘리브레이션해 조정)
 */
export const MIN_CROP_SHORT_PX = 300;
/** ≤512 정규화 캔버스 기준 Laplacian variance 하한 (낮출수록 흐린 사진도 허용) */
export const MIN_SHARPNESS = 90;
/** Laplacian 계산용 다운샘플 한도(긴변) — 해상도 의존성 정규화 */
const SAMPLE_MAX = 512;

/** 그레이스케일 + 3×3 Laplacian 커널의 분산. 선명할수록 큼. */
export function laplacianVariance(img: ImageData): number {
  const { data, width, height } = img;
  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const lap = new Float64Array(width * height);
  let mean = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const v =
        gray[idx - width] +
        gray[idx - 1] -
        4 * gray[idx] +
        gray[idx + 1] +
        gray[idx + width];
      lap[idx] = v;
      mean += v;
      count++;
    }
  }
  if (count === 0) return 0;
  mean /= count;
  let varSum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const d = lap[y * width + x] - mean;
      varSum += d * d;
    }
  }
  return varSum / count;
}

/**
 * 크롭 영역의 native 해상도 + 선명도로 얼굴 사진 화질을 판정.
 * @param img  원본 이미지 element (자연 해상도)
 * @param area 크롭 영역 (원본 native 픽셀 기준 — react-easy-crop croppedAreaPixels)
 */
export function assessFaceCrop(
  img: HTMLImageElement,
  area: CropRect
): FaceQuality {
  const nativePx = Math.round(Math.min(area.width, area.height));
  if (nativePx < MIN_CROP_SHORT_PX) {
    return { ok: false, reason: "low_res", nativePx, sharpness: 0 };
  }

  // ≤512(긴변) 로 다운샘플해 Laplacian 정규화
  const scale = Math.min(1, SAMPLE_MAX / Math.max(area.width, area.height));
  const w = Math.max(1, Math.round(area.width * scale));
  const h = Math.max(1, Math.round(area.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // ctx 불가(드문 환경) — 화질 검사 불가하므로 통과시킴(정상 사용자 차단 방지)
  if (!ctx) return { ok: true, nativePx, sharpness: MIN_SHARPNESS };

  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, w, h);
  const sharpness = laplacianVariance(ctx.getImageData(0, 0, w, h));
  if (sharpness < MIN_SHARPNESS) {
    return { ok: false, reason: "blurry", nativePx, sharpness };
  }
  return { ok: true, nativePx, sharpness };
}
