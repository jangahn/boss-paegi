import "server-only";
import sharp from "sharp";

const INPUT_SIZE = 1024;
const PADDING_RATIO = 0.15;
const MAX_DIM = 1024;

/**
 * 업로드된 입력 이미지를 1024×1024 정사각형으로 cover-crop.
 * 모든 fal img2img 호출의 출력이 동일 사이즈로 나오게 보장하기 위함.
 * attention 전략으로 얼굴 가운데 자동 crop.
 */
export async function prepareInputImage(input: ArrayBuffer): Promise<Buffer> {
  return sharp(Buffer.from(input))
    .resize({
      width: INPUT_SIZE,
      height: INPUT_SIZE,
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
  const trimmed = await sharp(buf)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
    .toBuffer({ resolveWithObject: true });
  const { data: trimData, info } = trimmed;

  const longSide = Math.max(info.width, info.height);
  const pad = Math.round(longSide * PADDING_RATIO);
  const squareSide = longSide + pad * 2;

  const left = Math.round((squareSide - info.width) / 2);
  const top = Math.round((squareSide - info.height) / 2);
  const right = squareSide - info.width - left;
  const bottom = squareSide - info.height - top;

  return sharp(trimData)
    .extend({
      top,
      bottom,
      left,
      right,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize({
      width: Math.min(squareSide, MAX_DIM),
      height: Math.min(squareSide, MAX_DIM),
      fit: "fill",
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
