/**
 * 루트 OG 이미지(app/opengraph-image.png) 생성기 — 제공된 완성 디자인을 OG 규격으로 맞춤.
 *
 * 사용: node scripts/gen-root-og.mjs <source-design.png>
 *   - 소스를 1200×630(OG 표준, ≈1.91:1) cover 리사이즈(중앙) + 무손실 PNG 최적화.
 *   - 디자인이 갱신되면 새 소스로 재실행하면 끝.
 *
 * 비고:
 *  - 루트 OG 는 타이틀·태그라인·캐릭터·도장을 포함한 **완성 디자인**이라 정적 PNG 로 커밋한다.
 *    (이전엔 boss-default 기반 Satori 메달리온 자동생성이었으나 핸드 디자인으로 대체.)
 *  - next/og(Satori) 는 투명 PNG 알파를 배경과 합성하지 못해(backgroundColor/Image 무용,
 *    공유 시 플랫폼 흰배경 비침) 동적 대신 **정적 PNG** 가 안전 — README·메모 참조.
 *  - 텍스트+3D 그라데이션 혼합이라 palette 양자화는 얼굴에 디더 노이즈 → full-color PNG 사용.
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src = process.argv[2];
if (!src) throw new Error("usage: node scripts/gen-root-og.mjs <source-design.png>");

const OUT = resolve(import.meta.dirname, "../app/opengraph-image.png");
const out = await sharp(src)
  .resize(1200, 630, { fit: "cover", position: "center" })
  .png({ compressionLevel: 9, effort: 10 })
  .toBuffer();
writeFileSync(OUT, out);

const m = await sharp(out).metadata();
console.log(`생성: ${OUT} (${(out.length / 1024).toFixed(0)}KB, ${m.width}x${m.height}, hasAlpha=${m.hasAlpha})`);
