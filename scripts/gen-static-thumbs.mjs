// 정적 이미지 썸네일 생성(v1.61) — 작은 칸에 게임용 원본을 그대로 받던 것을 줄인다.
//  - 기본 캐릭터 카드(갤러리 · 공유 · 기록 상세 · 캐릭터 공유): 768×1024 PNG(124~167KB) → public/sprites/thumb/<키>.webp
//    384×512(카드 약 160px 의 2배 DPR 이상). 게임 화면은 원본을 그대로 쓴다.
//  - 홈 캐릭터 얼굴: 256px PNG(21~26KB) → public/avatars/thumb/preset-N.webp 144×144(48px 의 3배). 프사 프리셋(업로드 원본 ·
//    기본 프사)은 원본 PNG 그대로.
// 원본을 바꾸면 이 스크립트를 다시 돌리고 **파일명을 바꾼다** — /sprites · /avatars 는 1년 immutable 캐시라 같은 이름이면 브라우저
// 캐시가 안 깨진다(next.config.ts headers). 키 · 경로는 lib/base-dolls.ts 와 같아야 한다(__tests__/qa/layout-shift-contract.test.ts 가 고정).
// 사용: node scripts/gen-static-thumbs.mjs
import sharp from "sharp";
import path from "node:path";
import { mkdirSync, statSync } from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const pub = (p) => path.join(root, "public", p);

const SPRITES = {
  "boss-m": "sprites/boss-default.png",
  "ceo-m": "sprites/base/ceo-m.png",
  "boss-f": "sprites/base/boss-f.png",
  "teamlead-f": "sprites/base/teamlead-f.png",
  "junior-m": "sprites/base/junior-m.png",
};
const FACES = [1, 2, 3, 4, 5];

const WEBP = { quality: 80, alphaQuality: 90, effort: 6 };

mkdirSync(pub("sprites/thumb"), { recursive: true });
mkdirSync(pub("avatars/thumb"), { recursive: true });

async function write(src, dest, width, height) {
  const info = await sharp(pub(src))
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp(WEBP)
    .toFile(pub(dest));
  const before = statSync(pub(src)).size;
  console.log(`${src} (${Math.round(before / 1024)}KB) → ${dest} ${info.width}×${info.height} ${Math.round(info.size / 1024)}KB`);
}

for (const [key, src] of Object.entries(SPRITES)) {
  await write(src, `sprites/thumb/${key}.webp`, 384, 512);
}
for (const n of FACES) {
  await write(`avatars/preset-${n}.png`, `avatars/thumb/preset-${n}.webp`, 144, 144);
}
