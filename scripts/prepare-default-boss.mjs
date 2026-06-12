/**
 * 기본 부장님 이미지 일회성 전처리:
 *  1. 원본 (체커보드가 픽셀로 박힌 가짜 투명) 을 fal storage 에 업로드
 *  2. birefnet 으로 누끼 (진짜 알파)
 *  3. sharp 로 투명 여백 trim → AI 캐릭터 규격 (768×1024, 캐릭터 높이 ~82%) 캔버스에 중앙 배치
 *  4. public/sprites/boss-default.png 저장
 *
 * 실행: node scripts/prepare-default-boss.mjs "<원본 이미지 경로>"
 */
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// .env.local 의 FAL_KEY 로드
const env = readFileSync(resolve(import.meta.dirname, "../.env.local"), "utf8");
const falKey = env.match(/^FAL_KEY=(.+)$/m)?.[1]?.trim();
if (!falKey) throw new Error("FAL_KEY not found in .env.local");
fal.config({ credentials: falKey });

const srcPath = process.argv[2];
if (!srcPath) throw new Error("usage: node prepare-default-boss.mjs <image>");

const CANVAS_W = 768;
const CANVAS_H = 1024;
const CHAR_H_RATIO = 0.82; // 캐릭터 높이 = 캔버스 높이의 82% (기존 AI 인형과 동일)

console.log("1) fal storage 업로드...");
const buf = readFileSync(srcPath);
const file = new File([buf], "boss-default-src.png", { type: "image/png" });
const url = await fal.storage.upload(file);
console.log("   →", url);

console.log("2) birefnet 누끼...");
const result = await fal.subscribe("fal-ai/birefnet", {
  input: { image_url: url },
  pollInterval: 1000,
});
const cutUrl = result.data.image.url;
console.log("   →", cutUrl);

console.log("3) 다운로드 + 규격화...");
const cutBuf = Buffer.from(await (await fetch(cutUrl)).arrayBuffer());

// 투명 여백 trim
const trimmed = await sharp(cutBuf).trim().png().toBuffer();
const meta = await sharp(trimmed).metadata();
console.log(`   trim 후: ${meta.width}x${meta.height}`);

// 캐릭터 높이를 캔버스의 82% 로 리사이즈 (가로가 넘치면 가로 기준)
const targetH = Math.round(CANVAS_H * CHAR_H_RATIO);
let resized = await sharp(trimmed)
  .resize({ height: targetH, fit: "inside" })
  .png()
  .toBuffer();
let rMeta = await sharp(resized).metadata();
if (rMeta.width > CANVAS_W * 0.94) {
  resized = await sharp(trimmed)
    .resize({ width: Math.round(CANVAS_W * 0.94), fit: "inside" })
    .png()
    .toBuffer();
  rMeta = await sharp(resized).metadata();
}
console.log(`   resize 후: ${rMeta.width}x${rMeta.height}`);

// 768×1024 투명 캔버스 중앙 배치
const out = await sharp({
  create: {
    width: CANVAS_W,
    height: CANVAS_H,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    {
      input: resized,
      left: Math.round((CANVAS_W - rMeta.width) / 2),
      top: Math.round((CANVAS_H - rMeta.height) / 2),
    },
  ])
  .png()
  .toBuffer();

const outPath = resolve(import.meta.dirname, "../public/sprites/boss-default.png");
writeFileSync(outPath, out);
console.log("4) 저장 완료:", outPath, `(${(out.length / 1024).toFixed(0)}KB)`);
