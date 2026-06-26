/**
 * 루트 OG 이미지(app/opengraph-image.png) 일회성 생성기.
 *
 * 텍스트 없이 캐치하게 — 찡그린 기본 부장님 얼굴(프사 크롭) + 다크 그라데이션 +
 * 앰버 스포트라이트 글로우 + 앰버 링 메달리온. 공유 카드의 글자는 og:title/description
 * (메타)이 담당하고, 이미지는 순수 비주얼.
 *
 * 왜 Satori(opengraph-image.tsx) 가 아니라 정적 PNG 인가:
 *  - 루트 OG 는 per-request 데이터가 없는 정적 이미지라 동적일 필요가 없고,
 *  - next/og(Satori) 는 투명 PNG <img> 의 알파를 배경과 합성하지 않고 그대로 뚫어
 *    (배경색/ backgroundImage 어떤 방식도 안 먹음) 공유 시 플랫폼 배경이 비쳐 깨진다.
 *  - sharp 로 미리 불투명 평탄화하면 알파 이슈 0 + 픽셀 제어가 확실하다.
 *
 * boss-default.png 가 바뀌면 재실행: node scripts/gen-root-og.mjs
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = resolve(ROOT, "public/sprites/boss-default.png");
const OUT = resolve(ROOT, "app/opengraph-image.png");

const W = 1200;
const H = 630;
const CX = 600;
const CY = 315;
const D = 506; // 얼굴 원 지름
const R = D / 2;

// 1) 고해상 boss-default 에서 얼굴 정사각 크롭 → 원형 마스크
const faceCrop = await sharp(SRC)
  .extract({ left: 150, top: 60, width: 470, height: 470 })
  .resize(D, D)
  .toBuffer();
const mask = Buffer.from(
  `<svg width="${D}" height="${D}"><circle cx="${R}" cy="${R}" r="${R}" fill="#fff"/></svg>`
);
const circularFace = await sharp(faceCrop)
  .composite([{ input: mask, blend: "dest-in" }])
  .png()
  .toBuffer();

// 2) 배경 캔버스: 다크 그라데이션 + 앰버 글로우 + 앰버 링(메달리온 바탕)
const baseSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="52%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0b1220"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.55"/>
      <stop offset="35%" stop-color="#f59e0b" stop-opacity="0.18"/>
      <stop offset="66%" stop-color="#f59e0b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="${CX}" cy="${CY}" rx="660" ry="440" fill="url(#glow)"/>
  <circle cx="${CX}" cy="${CY}" r="${R + 7}" fill="#0f172a" stroke="#f59e0b" stroke-width="14"/>
</svg>`;

// 3) 합성 + 불투명 평탄화
const out = await sharp(Buffer.from(baseSvg))
  .composite([{ input: circularFace, left: Math.round(CX - R), top: Math.round(CY - R) }])
  .flatten({ background: "#0b1220" })
  .removeAlpha()
  .png()
  .toBuffer();

writeFileSync(OUT, out);
const meta = await sharp(out).metadata();
console.log(
  `생성 완료: ${OUT} (${(out.length / 1024).toFixed(0)}KB, ${meta.width}x${meta.height}, hasAlpha=${meta.hasAlpha})`
);
