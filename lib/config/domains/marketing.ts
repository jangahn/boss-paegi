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

// 웹 공유 텍스트 전용 — 공유 helper(runShare)가 URL 을 마지막 줄에 1개 자동 부착하므로
// 문구 안에 raw URL 을 넣으면 링크가 중복된다. 저장 단계에서 차단.
const tplNoUrl = (max: number) =>
  tpl(max).refine((s) => !/https?:\/\//i.test(s), {
    message: "URL 은 공유 시 자동으로 붙으니 문구에 넣지 마세요.",
  });

/**
 * 홈 버튼 키 개명(v1.49) 읽기 정규화 — 구 `primaryCta`(만들기)·`secondaryCta`(바로 패기)는 자리 이름이라 홈 개편으로
 * 1차·2차가 뒤바뀌며 뜻이 어긋났다. 역할 이름 `createCta`·`playCta` 로 바꾸고, 발행행의 구 키 값을 새 키로 무손실 승계한다
 * (새 키가 이미 있으면 그대로 — 재발행 뒤 no-op, 구 키는 z.object 가 strip). score_config·role_content 와 같은 패턴.
 */
export function normalizeMarketingCopyInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const c = input as { home?: unknown };
  if (!c.home || typeof c.home !== "object" || Array.isArray(c.home)) return input;
  const home = c.home as Record<string, unknown>;
  if (!("primaryCta" in home) && !("secondaryCta" in home)) return input;
  return {
    ...c,
    home: {
      ...home,
      createCta: home.createCta ?? home.primaryCta,
      playCta: home.playCta ?? home.secondaryCta,
    },
  };
}

const marketingCopyBaseSchema = z.object({
  home: z.object({
    tagline, // 줄바꿈으로 여러 줄
    // 캐릭터 줄 캡션(비회원 전용) — 잠긴 추가 캐릭터 4종 아래 가입 혜택 한 줄. 발행행 무중단 .default().
    lockedCaption: title.default("가입하면 캐릭터 4명이 더 열려요"),
    // 1차 버튼(플레이): 비회원 = 기본 부장님 바로 플레이 / 회원 = 갤러리에서 골라 플레이.
    playCta: button,
    memberPlayCta: button.default("캐릭터 골라서 패기"),
    // 2차 버튼(만들기): 비회원 = 가입 후 생성 / 회원 = 바로 생성. 문구는 공통.
    createCta: button,
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
    dollShareText: tplNoUrl(160),
    dollOgTitle: tpl(80),
    dollOgDesc: tpl(160),
    // 점수 공유(share)
    scoreHook: tpl(60),
    scoreCtaPlay: tpl(40),
    scoreCtaPersona: tpl(40),
    // 게임 종료 화면에서 공유 시 웹 공유 텍스트(키 유지=발행값 보존; URL 은 helper 가 자동 부착).
    scoreShareText: tplNoUrl(60),
    scoreOgTitle: tpl(80),
    // 점수 공유 OG 설명 — 롤 무관 단일 값(구 롤 ogLines 대체). 발행된 행엔 없을 수 있어 .default().
    scoreOgDesc: tpl(160).default("{점수}점! 오패완(오늘도 패기 완료)💥"),
    // 게임오버 — 1차 '다음 플레이' 버튼: 회원=갤러리("다른 캐릭터로 패기") / 비회원=가입 후 생성
    // ("다른 캐릭터 더 열고 패기" → 가입 후 갤러리, v1.42). 비회원 부제는 gameoverNonmemberSub(종료 화면 전용). 발행행 무중단 .default().
    gameoverPlayBtnMember: tpl(30).default("다른 캐릭터로 패기"),
    gameoverPlayBtnNonmember: tpl(30).default("다른 캐릭터 더 열고 패기"),
    // 게임오버 — 비회원 1차 버튼 아래 부제(v1.42, 종료 화면 전용 키 — 갤러리 배너 제목과 분리). 발행행 무중단 .default().
    gameoverNonmemberSub: tpl(80).default("부장님 한 명으로 부족하죠? 가입하면 4명이 더 열려요"),
    // 게임오버 — 공유 버튼(하이라이트 없을 때/있을 때, 2차) + 다시 패기 링크(하단 텍스트 행). 발행행 무중단 .default().
    gameoverShareBtn: tpl(30),
    gameoverShareBtnHighlight: tpl(30).default("🔥 하이라이트 공유하기"),
    gameoverRetryBtn: tpl(20),
    // 이전 플레이 기록 화면(history) — 공유 버튼 2종 + 웹 공유 텍스트. 발행행 무중단 .default().
    historyShareBtn: tpl(30).default("결과 보고서 공유"),
    historyShareBtnHighlight: tpl(30).default("🔥 하이라이트 공유"),
    historyShareText: tplNoUrl(60).default("{제작자}님 {호칭} {점수}점 패기 결과 🥊"),
    scoreRankLink: tpl(40).default("전체 순위 보기"),
    // 어뷰징 의심 점수 — 운영자 검토 대기 안내 + 정지 경고(발행행 무중단 .default()).
    pendingReviewNotice: tpl(160).default(
      "비정상 플레이 패턴이 감지되어 운영자 확인 후 랭킹에 반영됩니다."
    ),
    pendingReviewWarning: tpl(160).default(
      "매크로 등 부정한 방법으로 점수를 조작하면 계정이 정지될 수 있습니다."
    ),
  }),
});

export const marketingCopySchema = z.preprocess(normalizeMarketingCopyInput, marketingCopyBaseSchema);

export type MarketingCopy = z.infer<typeof marketingCopyBaseSchema>;

// 코드 기본값 = 현재 하드코딩 문구(폴백·시드 전 동작 동일). boss 기준 바이트 동일.
export const MARKETING_COPY_DEFAULT: MarketingCopy = {
  home: {
    tagline: "오늘 부장님한테 받은 스트레스,\n여기서 마음껏 풀고 가세요.",
    lockedCaption: "가입하면 캐릭터 4명이 더 열려요",
    playCta: "기본 부장님 바로 패기",
    memberPlayCta: "캐릭터 골라서 패기",
    createCta: "내 캐릭터 만들어서 패기",
    disclaimer:
      "본 서비스는 코믹한 스트레스 해소를 위한 캐주얼 게임입니다.\n타인 비방·괴롭힘 목적의 사용은 금지됩니다.",
  },
  signupBanner: {
    nonmemberTitle: "가입하면 생성권 1개 지급",
    nonmemberSub: "이미지 한 장으로 나만의 캐릭터 만들고, 역할 선택부터 공유까지!",
    memberEmptyTitle: "나만의 캐릭터로 더 재밌게 플레이",
    memberEmptySub: "기본 캐릭터 대신 직접 만든 캐릭터로 플레이!",
    nonmemberCta: "가입하고 만들기",
    memberEmptyCta: "캐릭터 만들기",
    memberHeaderCta: "+ 새로 만들기",
  },
  share: {
    dollHook: "머릿속에 떠오른 얼굴이 있나요?",
    dollCtaMake: "나만의 캐릭터 만들기",
    dollCtaDefault: "기본 부장님으로 몸풀기",
    dollShareText: "내가 만든 {호칭} 캐릭터를 소개합니다.",
    dollOgTitle: "[인사기록] {제작자}님의 {호칭}",
    dollOgDesc: "나만의 {호칭} 캐릭터도 만들어보세요!",
    scoreHook: "내가 더 잘 팰 것 같다면?",
    scoreCtaPlay: "내 {호칭으로} 패기",
    scoreCtaPersona: "기본 부장님으로 패기",
    scoreShareText: "우리 {호칭} {점수}점 패고 옴 🥊",
    scoreOgTitle: "[결재완료] {제작자} — {점수}점 ({등급})",
    scoreOgDesc: "{점수}점! 오패완(오늘도 패기 완료)💥",
    gameoverPlayBtnMember: "다른 캐릭터로 패기",
    gameoverPlayBtnNonmember: "다른 캐릭터 더 열고 패기",
    gameoverNonmemberSub: "부장님 한 명으로 부족하죠? 가입하면 4명이 더 열려요",
    gameoverShareBtn: "보고서 공유하기",
    gameoverShareBtnHighlight: "🔥 하이라이트 공유하기",
    gameoverRetryBtn: "다시 패기",
    historyShareBtn: "결과 보고서 공유",
    historyShareBtnHighlight: "🔥 하이라이트 공유",
    historyShareText: "{제작자}님 {호칭} {점수}점 패기 결과 🥊",
    scoreRankLink: "전체 순위 보기",
    pendingReviewNotice: "비정상 플레이 패턴이 감지되어 운영자 확인 후 랭킹에 반영됩니다.",
    pendingReviewWarning: "매크로 등 부정한 방법으로 점수를 조작하면 계정이 정지될 수 있습니다.",
  },
};

// 전부 공개 마케팅 문구 → projection 그대로(운영필드 없음).
export const marketingEntry: DomainEntry<MarketingCopy> = {
  schema: marketingCopySchema,
  codeDefault: MARKETING_COPY_DEFAULT,
  publicSurfaces: ["marketing"],
};
