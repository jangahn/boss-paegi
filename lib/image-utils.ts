import "server-only";
import sharp from "sharp";

const INPUT_W = 768;
const INPUT_H = 1024; // 3:4 portrait — 정사각형이면 머리만 보여서 어색
const PADDING_RATIO = 0.12;
const MAX_DIM = 1024;
const ASPECT_W = 3;
const ASPECT_H = 4;

/**
 * 업로드된 입력 이미지를 768×1024 (3:4) 로 cover-crop.
 * 클라이언트가 이미 crop 했지만 비율이 정확히 3:4 보장 안 될 수 있어서 한 번 더 보정.
 */
export async function prepareInputImage(input: ArrayBuffer): Promise<Buffer> {
  return sharp(Buffer.from(input))
    .resize({
      width: INPUT_W,
      height: INPUT_H,
      fit: "cover",
      position: "attention",
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * 누끼 PNG (transparent edges) 를 받아서:
 * 1. transparent 가장자리 trim → 캐릭터 bbox 만 남김
 * 2. PADDING_RATIO 만큼 long side 비례 여백 추가 (캐릭터가 frame 의 ~77% 차지)
 * 3. 정사각형으로 extend (캐릭터 정중앙)
 * 4. MAX_DIM 까지 다운사이즈
 */
export async function normalizeDollImage(input: ArrayBuffer | Buffer): Promise<Buffer> {
  const buf: Buffer = Buffer.isBuffer(input) ? input : Buffer.from(input as ArrayBuffer);

  // 1) trim transparent edges → 캐릭터 bbox
  const trimmed = await sharp(buf)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
    .toBuffer({ resolveWithObject: true });
  let { data, info } = trimmed;

  // 2) bbox 가 너무 크면 다운사이즈 (최종 캔버스 ≤ MAX_DIM 보장).
  const maxBboxH = Math.round(MAX_DIM / (1 + 2 * PADDING_RATIO));
  if (Math.max(info.width, info.height) > maxBboxH) {
    const scale = maxBboxH / Math.max(info.width, info.height);
    const newW = Math.max(1, Math.round(info.width * scale));
    const newH = Math.max(1, Math.round(info.height * scale));
    const resized = await sharp(data).resize(newW, newH).png().toBuffer();
    data = resized;
    info = { ...info, width: newW, height: newH };
  }

  // 3) 3:4 캔버스로 pad. 캐릭터 비율 보존 + 양옆/위아래 골고루 transparent 여백.
  // - 현재 bbox W×H, target 3:4 (W/H = 0.75).
  // - bbox 가 더 가로형이면 (W/H > 0.75) → 가로 기준으로 캔버스, 위아래 더 늘림.
  // - 세로형이면 → 세로 기준, 좌우 더 늘림.
  const bboxRatio = info.width / info.height;
  const targetRatio = ASPECT_W / ASPECT_H;
  let canvasW: number;
  let canvasH: number;
  if (bboxRatio > targetRatio) {
    canvasW = Math.round(info.width * (1 + 2 * PADDING_RATIO));
    canvasH = Math.round(canvasW / targetRatio);
  } else {
    canvasH = Math.round(info.height * (1 + 2 * PADDING_RATIO));
    canvasW = Math.round(canvasH * targetRatio);
  }

  const left = Math.round((canvasW - info.width) / 2);
  const top = Math.round((canvasH - info.height) / 2);

  return sharp(data)
    .extend({
      top,
      bottom: canvasH - info.height - top,
      left,
      right: canvasW - info.width - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
