// 계정 동의(14세+약관+방침) 상태 판정의 **단일 소스**(server·client 공용 — server-only 아님).
// requireMember(서버 게이트)·OAuth 콜백·getMyProfile(클라)·/consent 페이지·/api/account/consent 가
// 전부 이 함수만 사용한다(중복 구현 금지). 이미지사용 동의(ConsentDialog)는 별개 트랙으로 여기 없음.

export type ConsentItem = "age" | "terms" | "privacy";

/**
 * 현재 발행본 버전(정수). **null = 발행본 없음(I1 fail-open) 또는 조회 실패(I9 미강등)** —
 * 둘 다 terms/privacy 비교를 보류한다(없는/모르는 기준으로 사용자를 막지 않음).
 */
export type LegalVersions = { terms: number | null; privacy: number | null };

/** 동의 판정에 필요한 member 필드. row 없으면(in-between/신규) null 전달. */
export type ConsentMember = {
  age_confirmed_at: string | null;
  terms_version: number | null;
  privacy_version: number | null;
} | null;

/**
 * 아직 받아야 할 동의 항목 (단일 규칙).
 * - **age**: row 없음 ∨ `age_confirmed_at == null`. **법률 버전과 무관·항상 enforce** →
 *   인프라 실패·발행본 부재로도 신규/미완료 계정을 member 로 승격시키지 않는다.
 * - **terms**: 현재 발행본 버전이 **있을 때만**(null=발행본없음/조회실패면 보류) ∧
 *   (row 없음 ∨ 미동의 ∨ **동의 버전이 현재보다 낮음**). `<` 사용(`!==` 아님) —
 *   동의 버전이 현재보다 **높아도**(이미 더 최신 동의) 재동의 요구 안 함. 이는 두 버전 소스
 *   (app server unstable_cache vs proxy edge-versions 60s)가 publish 직후 잠깐 어긋날 때
 *   "방금 동의한 사용자"가 proxy↔목적지로 루프 도는 것을 막는다.
 * - **privacy**: terms 와 동일.
 */
export function missingConsentItems(
  member: ConsentMember,
  curr: LegalVersions
): ConsentItem[] {
  const items: ConsentItem[] = [];
  if (!member || member.age_confirmed_at == null) items.push("age");
  if (
    curr.terms != null &&
    (!member || member.terms_version == null || member.terms_version < curr.terms)
  ) {
    items.push("terms");
  }
  if (
    curr.privacy != null &&
    (!member || member.privacy_version == null || member.privacy_version < curr.privacy)
  ) {
    items.push("privacy");
  }
  return items;
}

/** 동의가 더 필요한가(=consent_incomplete). */
export function needsConsent(member: ConsentMember, curr: LegalVersions): boolean {
  return missingConsentItems(member, curr).length > 0;
}
