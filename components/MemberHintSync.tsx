"use client";

import { useLayoutEffect } from "react";
import { applyMemberHint, memberHintCookieName, memberHintFromCookie } from "@/lib/member-hint";

/**
 * 회원 힌트 재적용(v1.51) — <head> 인라인 스크립트가 단 `<html data-member-hint>` 를 같은 쿠키에서 다시 계산해 맞춘다.
 * 프로덕션에서는 같은 값이라 아무 일도 하지 않는다. 개발 모드의 Strict Mode 재마운트는 <html> 속성을 JSX 가 관리하는 것만 남기고
 * 지우므로(Next 가이드 「Re-applying attributes in development」) paint 전(useLayoutEffect)에 되살린다.
 */
export function MemberHintSync() {
  useLayoutEffect(() => {
    applyMemberHint(memberHintFromCookie(document.cookie, memberHintCookieName()));
  }, []);
  return null;
}
