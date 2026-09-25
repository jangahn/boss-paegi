import { z } from "zod";
import type { DomainEntry } from "../registry";
import { unknownTokens } from "../template";
import { MARKETING_COPY_DEFAULT, normalizeMarketingCopyInput } from "./marketing";

// 마케팅 카피 검증 schema(v1.64 분리) — zod 는 서버(getter · 레지스트리 · 어드민 저장)에서만 쓴다. 값 · 정규화는 `./marketing`.

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
    // 게임오버 — 비회원 다음 플레이 버튼 아래 부제(v1.42, 종료 화면 전용 키 — 갤러리 배너 제목과 분리). 발행행 무중단 .default().
    gameoverNonmemberSub: tpl(80).default("부장님 한 명으로 부족하죠? 가입하면 4명이 더 열려요"),
    // 게임오버 — 공유 버튼(하이라이트 없을 때/있을 때, 3차) + 다시 패기 버튼(하단 고정 1차, v1.54 — 구 하단 텍스트 행 링크). 발행행 무중단 .default().
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

// 전부 공개 마케팅 문구 → projection 그대로(운영필드 없음).
export const marketingEntry: DomainEntry<MarketingCopy> = {
  schema: marketingCopySchema,
  codeDefault: MARKETING_COPY_DEFAULT,
  publicSurfaces: ["marketing"],
};
