import { z } from "zod";
import type { DomainEntry } from "../registry";
import { unknownTokens } from "../template";

// 마케팅 카피 도메인 — 순수 모듈(client 프로바이더의 기본값 + server getter 가 공용으로 import).
const tagline = z.string().trim().min(1).max(120); // 멀티라인(개행 인식)
const disclaimer = z.string().trim().min(1).max(240); // 멀티라인
const title = z.string().trim().min(1).max(80);
const desc = z.string().trim().min(1).max(200);
const button = z.string().trim().min(1).max(30);

// 치환 토큰 문구 — 허용 토큰({호칭}·값 토큰) 외 {...} 가 있으면 거절(공개 화면 누출 방지).
const tpl = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => unknownTokens(s).length === 0, {
      message: "허용되지 않은 치환 토큰이 있어요({호칭}/{호칭을}/{호칭은}/{호칭으로}/{제작자}/{점수}/{등급}/{특이사항}/{상위}만 가능).",
    });

export const marketingCopySchema = z.object({
  home: z.object({
    tagline, // 줄바꿈으로 여러 줄
    primaryCta: button,
    secondaryCta: button,
    disclaimer, // 줄바꿈으로 여러 줄
  }),
  signupBanner: z.object({
    nonmemberTitle: title,
    nonmemberSub: desc,
    memberEmptyTitle: title,
    memberEmptySub: desc,
    // 갤러리 진입 버튼 라벨(href 는 코드 고정 라우팅). 이미 발행된 행엔 없을 수 있어 .default().
    nonmemberCta: button.default("가입하고 만들기"),
    memberEmptyCta: button.default("캐릭터 만들기"),
    memberHeaderCta: button.default("+ 새로 만들기"),
  }),
  // 공유/CTA 문구 — {호칭}(조사 자동) + 값 토큰(코드 합성). 수치·이름은 토큰 위치에 코드가 채움.
  share: z.object({
    // 인사기록 카드(doll 공유)
    dollHook: tpl(80),
    dollCtaMake: tpl(30),
    dollCtaDefault: tpl(40),
    dollShareText: tpl(160),
    dollOgTitle: tpl(80),
    dollOgDesc: tpl(160),
    // 점수 공유(share). scoreOgDesc 는 롤 OG 후킹(롤 콘텐츠)에서 제어 → 여기 없음.
    scoreHook: tpl(60),
    scoreCtaPlay: tpl(40),
    scoreCtaPersona: tpl(40),
    scoreShareText: tpl(60),
    scoreOgTitle: tpl(80),
    // 게임오버
    gameoverShareBtn: tpl(30),
    gameoverRetryBtn: tpl(20),
    // 보고서 구조 라벨. 이미 발행된 행엔 없을 수 있어 .default().
    reportTitle: tpl(40).default("스트레스 해소 결과 보고서"),
    scoreRankLink: tpl(40).default("이 점수, 랭킹 몇 등인지 보기"),
  }),
});

export type MarketingCopy = z.infer<typeof marketingCopySchema>;

// 코드 기본값 = 현재 하드코딩 문구(폴백·시드 전 동작 동일). boss 기준 바이트 동일.
export const MARKETING_COPY_DEFAULT: MarketingCopy = {
  home: {
    tagline: "오늘 부장님한테 받은 스트레스,\n여기서 마음껏 풀고 가세요.",
    primaryCta: "내 부장님 만들기",
    secondaryCta: "기본 부장님으로 바로 시작",
    disclaimer:
      "본 서비스는 코믹한 스트레스 해소를 위한 캐주얼 게임입니다.\n타인 비방·괴롭힘 목적의 사용은 금지됩니다.",
  },
  signupBanner: {
    nonmemberTitle: "가입하면 가입기념 생성권 2개를 드려요",
    nonmemberSub: "내 사진으로 나만의 캐릭터를 만들고 공유·롤 변경까지!",
    memberEmptyTitle: "나만의 캐릭터를 만들어보세요",
    memberEmptySub: "기본부장님 말고, 내 사진으로 만든 캐릭터로 플레이!",
    nonmemberCta: "가입하고 만들기",
    memberEmptyCta: "캐릭터 만들기",
    memberHeaderCta: "+ 새로 만들기",
  },
  share: {
    dollHook: "당신의 {호칭은} 무사하십니까?",
    dollCtaMake: "나도 우리 {호칭} 만들기",
    dollCtaDefault: "기본 부장님으로 바로 풀기",
    dollShareText: "내가 만든 {호칭을} 소개합니다. 당신의 {호칭은} 무사하십니까?",
    dollOgTitle: "[인사기록] {제작자}님의 {호칭}",
    dollOgDesc: "특이사항: {특이사항} — 당신의 {호칭은} 무사하십니까?",
    scoreHook: "나도 한 판, 몇 점이 나올까?",
    scoreCtaPlay: "우리 {호칭}도 패러 가기",
    scoreCtaPersona: "기본 부장님으로 바로 풀기",
    scoreShareText: "{호칭} {점수}점 패고 옴 🥊",
    scoreOgTitle: "[결재완료] {제작자} — {점수}점 ({등급})",
    gameoverShareBtn: "보고서 공유하기",
    gameoverRetryBtn: "다시 패기",
    reportTitle: "스트레스 해소 결과 보고서",
    scoreRankLink: "이 점수, 랭킹 몇 등인지 보기",
  },
};

// 전부 공개 마케팅 문구 → projection 그대로(운영필드 없음).
export const marketingEntry: DomainEntry<MarketingCopy> = {
  schema: marketingCopySchema,
  codeDefault: MARKETING_COPY_DEFAULT,
  publicSurfaces: ["marketing"],
};
