import type { MarketingCopy } from "./marketing-schema";

// 마케팅 카피 도메인 — 순수 모듈(client 프로바이더의 기본값 + server getter 가 공용으로 import).
// 검증 schema(zod · 치환 토큰 · 글자 수)는 `./marketing-schema` — 이 모듈은 클라 번들에 들어가 zod 를 끌어오지 않는다(v1.64).

export type { MarketingCopy };

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
