import { z } from "zod";
import type { DomainEntry } from "../registry";

// 마케팅 카피 도메인 — 순수 모듈(client 프로바이더의 기본값 + server getter 가 공용으로 import).
// 길이 bound = 보강#8(title≤80·desc≤200·button≤30·짧은 라인≤60).
const line = z.string().trim().min(1).max(60);
const title = z.string().trim().min(1).max(80);
const desc = z.string().trim().min(1).max(200);
const button = z.string().trim().min(1).max(30);
const disclaimer = z.string().trim().min(1).max(120);

export const marketingCopySchema = z.object({
  home: z.object({
    taglineLine1: line,
    taglineLine2: line,
    primaryCta: button,
    secondaryCta: button,
    galleryLink: button,
    leaderboardLink: button,
    disclaimerLine1: disclaimer,
    disclaimerLine2: disclaimer,
  }),
  signupBanner: z.object({
    nonmemberTitle: title,
    nonmemberSub: desc,
    memberEmptyTitle: title,
    memberEmptySub: desc,
  }),
});

export type MarketingCopy = z.infer<typeof marketingCopySchema>;

// 코드 기본값 = 현재 하드코딩 문구(폴백·시드 전 동작 동일).
export const MARKETING_COPY_DEFAULT: MarketingCopy = {
  home: {
    taglineLine1: "오늘 부장님한테 받은 스트레스,",
    taglineLine2: "여기서 마음껏 풀고 가세요.",
    primaryCta: "내 부장님 만들기",
    secondaryCta: "기본 부장님으로 바로 시작",
    galleryLink: "내 부장님 갤러리 →",
    leaderboardLink: "오늘의 랭킹 →",
    disclaimerLine1: "본 서비스는 코믹한 스트레스 해소를 위한 캐주얼 게임입니다.",
    disclaimerLine2: "타인 비방·괴롭힘 목적의 사용은 금지됩니다.",
  },
  signupBanner: {
    nonmemberTitle: "가입하면 가입기념 생성권 2개를 드려요",
    nonmemberSub: "내 사진으로 나만의 캐릭터를 만들고 공유·롤 변경까지!",
    memberEmptyTitle: "나만의 캐릭터를 만들어보세요",
    memberEmptySub: "기본부장님 말고, 내 사진으로 만든 캐릭터로 플레이!",
  },
};

// 전부 공개 마케팅 문구 → projection 그대로(운영필드 없음).
export const marketingEntry: DomainEntry<MarketingCopy> = {
  schema: marketingCopySchema,
  codeDefault: MARKETING_COPY_DEFAULT,
  publicSurfaces: ["marketing"],
};
