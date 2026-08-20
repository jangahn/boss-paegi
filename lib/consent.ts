// 계정 동의(만 19세+약관+방침) 상태 판정의 **단일 소스**(server·client 공용 — server-only 아님).
// requireMember(서버 게이트)·OAuth 콜백·/consent 페이지·/api/account/consent 가
// 전부 이 함수만 사용한다(중복 구현 금지). 이미지사용 동의(ConsentDialog)는 별개 트랙으로 여기 없음.
// 2026-08-21: 버전 추적·개정 재동의 로직 폐지 — 동의는 "했냐/안 했냐"(+시각)만 본다.
// 약관 개정 시 기존 회원 재동의를 강제하지 않는다(게시·고지로 갈음, 약관 제3조).

export type ConsentItem = "age" | "terms" | "privacy";

/** 동의 판정에 필요한 member 필드. row 없으면(in-between/신규) null 전달. */
export type ConsentMember = {
  age_confirmed_at: string | null;
  terms_agreed_at: string | null;
  privacy_agreed_at: string | null;
} | null;

/**
 * 아직 받아야 할 동의 항목 (단일 규칙).
 * 각 항목은 timestamp 유무로만 판정한다 — row 없음 ∨ null = 미동의.
 * 탈퇴 시 세 값이 모두 초기화되므로(트리거) 재활성 후 재가입은 신규가입과
 * 완전히 같은 3항목 플로우를 탄다.
 */
export function missingConsentItems(member: ConsentMember): ConsentItem[] {
  const items: ConsentItem[] = [];
  if (!member || member.age_confirmed_at == null) items.push("age");
  if (!member || member.terms_agreed_at == null) items.push("terms");
  if (!member || member.privacy_agreed_at == null) items.push("privacy");
  return items;
}

/** 동의가 더 필요한가(=consent_incomplete). */
export function needsConsent(member: ConsentMember): boolean {
  return missingConsentItems(member).length > 0;
}
