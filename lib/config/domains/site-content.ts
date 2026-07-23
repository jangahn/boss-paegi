import { z } from "zod";
import type { DomainEntry } from "../registry";

// 소개·FAQ·SEO 메타 도메인 — 홈 소개 섹션, /faq, 메타데이터·JSON-LD·llms.txt·OG 의 단일 소스.
// 어드민 콘솔에서 편집(수정내역=app_settings_audit). 코드 기본값이 곧 초기 시드(미발행 시 폴백).
const faqItemSchema = z.object({
  q: z.string().trim().min(1).max(200),
  a: z.string().trim().min(1).max(2000),
});

// (사업자정보는 0061 로 business_info 도메인 분리 — lib/config/domains/business-info.ts.
//  기존 발행값의 잔존 businessInfo 키는 z.object 파싱이 무시하고 다음 발행 때 자연 소거.)
export const siteContentSchema = z.object({
  /** 한 줄 정의 — title·OG·JSON-LD·llms.txt 공통 엔티티 설명. */
  definition: z.string().trim().min(1).max(200),
  /** 검색 메타 description. */
  metaDescription: z.string().trim().min(1).max(200),
  /** 메타/콘텐츠 키워드(어드민 편집). */
  keywords: z.array(z.string().trim().min(1).max(40)).max(20),
  /** 소개 문단 — 홈 섹션·/faq·llms.txt(GEO 추출용). */
  intro: z.string().trim().min(1).max(1000),
  /** 자주 묻는 질문 — /faq·FAQPage JSON-LD. */
  faq: z.array(faqItemSchema).min(1).max(30),
});

export type SiteContent = z.infer<typeof siteContentSchema>;
export type FaqItem = z.infer<typeof faqItemSchema>;

export const SITE_CONTENT_DEFAULT: SiteContent = {
  definition:
    "부장님 패기는 내 사진으로 만든 AI 캐릭터를 두들겨 직장 스트레스를 푸는 캐주얼 웹게임입니다.",
  metaDescription:
    "내 사진으로 만든 AI 캐릭터를 제한 시간 동안 두들겨 직장 스트레스를 푸는 무료 캐주얼 웹게임. 설치 없이 웹에서 바로 즐기고, 만 14세 이상이면 누구나 이용할 수 있어요.",
  keywords: [
    "부장님 패기",
    "스트레스 해소 게임",
    "직장인 게임",
    "스트레스 푸는 게임",
    "AI 캐릭터 만들기",
    "사진 캐릭터 변환",
    "펀치 게임",
    "부장님 게임",
  ],
  intro:
    "부장님 패기는 직장 스트레스를 가볍게 푸는 캐주얼 웹게임입니다. 내 사진을 올리면 AI가 실제 인물과 닮지 않은 캐릭터로 바꿔 주고, 제한 시간 동안 그 캐릭터를 두들겨 점수와 랭킹에 도전합니다. 설치 없이 웹브라우저에서 바로 즐길 수 있고, 만 14세 이상이면 누구나 이용할 수 있습니다. 업로드한 원본 사진은 생성 직후 폐기됩니다.",
  faq: [
    {
      q: "부장님 패기란 무엇인가요?",
      a: "내 사진으로 만든 AI 캐릭터를 제한 시간 동안 두들겨 점수를 얻는 캐주얼 웹게임입니다. 직장에서 쌓인 스트레스를 가볍게 푸는 펀치형 미니게임으로, 설치 없이 웹브라우저에서 바로 즐길 수 있습니다.",
    },
    {
      q: "어떻게 플레이하나요?",
      a: "접속하면 기본 캐릭터로 바로 시작할 수 있습니다. 제한 시간 안에 화면의 캐릭터를 빠르게 타격해 점수와 콤보를 올리고, 점수는 랭킹에 등록하거나 결과를 공유할 수 있습니다. 원하면 내 사진으로 나만의 AI 캐릭터를 만들어 플레이할 수도 있습니다.",
    },
    {
      q: "무료인가요? 요금은 어떻게 되나요?",
      a: "게임 플레이는 무료입니다. 내 사진으로 AI 캐릭터를 만들 때만 '생성권'이 1개 사용되며, 가입하면 생성권 1개를 무료로 드립니다. 추가 생성권은 충전(유료)할 수 있습니다. 충전한 생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있고, 유효기간은 구매일(지급일)로부터 1년입니다. 결제일로부터 7일 이내에는 미사용 생성권을 전액 환불받을 수 있습니다.",
    },
    {
      q: "어떤 사진을 올려야 하나요? 다른 사람 사진을 올려도 되나요?",
      a: "본인 사진이거나, 사진 속 인물의 동의를 받았거나 사용 권한이 있는 사진만 올려야 합니다. 타인의 사진을 동의 없이 올리는 것은 금지되며, 그로 인한 책임은 업로드한 이용자에게 있습니다. 업로드한 원본 사진은 캐릭터 생성이 끝나는 즉시 폐기되고, 캐릭터화된 결과 이미지만 저장됩니다.",
    },
    {
      q: "제 사진과 개인정보는 안전한가요?",
      a: "업로드한 원본 얼굴 사진은 AI 생성이 끝나거나 실패하는 즉시 자동으로 폐기되며 영구 저장하지 않습니다. 저장되는 것은 실제 인물과 닮지 않도록 강하게 캐릭터화된 결과 이미지뿐입니다. 결과를 외부에 공유할지는 이용자가 직접 선택하며, 자세한 처리 내용은 개인정보처리방침에서 확인할 수 있습니다.",
    },
    {
      q: "몇 세부터 이용할 수 있나요?",
      a: "만 14세 이상부터 이용할 수 있습니다.",
    },
    {
      q: "어떤 기기에서 할 수 있나요?",
      a: "별도 설치 없이 모바일·PC 웹브라우저에서 바로 즐길 수 있습니다. 휴대폰 홈 화면에 추가하면 앱처럼 사용할 수도 있습니다.",
    },
    {
      q: "로그인이나 회원가입이 꼭 필요한가요? 탈퇴는 어떻게 하나요?",
      a: "로그인 없이도 바로 플레이할 수 있습니다. 카카오·구글 계정으로 가입하면 점수 기록과 만든 캐릭터를 보관할 수 있고, 가입 후에는 마이페이지에서 닉네임·프로필 사진을 바꾸거나 언제든 회원탈퇴할 수 있습니다.",
    },
  ],
};

export const siteContentEntry: DomainEntry<SiteContent> = {
  schema: siteContentSchema,
  codeDefault: SITE_CONTENT_DEFAULT,
};
