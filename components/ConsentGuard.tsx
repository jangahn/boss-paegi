"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getMyProfile, writeCachedProfile } from "@/lib/profile";
import { safeNext } from "@/lib/oauth-metadata";
import { isMemberOnlyPath } from "@/lib/routes";

/**
 * "동의까지 끝나야 로그인"(I7) — consent_incomplete 세션이 **회원 전용 페이지**(lib/routes)에 들어오면
 * route 변경 시 `/consent` 로 보낸다. **공개 페이지(비로그인도 보는 홈·랭킹·플레이·갤러리·공유·약관·방침
 * 등)는 전체 허용** — consent_incomplete 는 메뉴상 비회원으로 보이고(accountState), member 자원 접근은
 * 서버 requireMember 가 별도 차단하므로 공개 페이지 열람을 막을 이유가 없다.
 * 포커스 중 강제이탈은 안 함(게임 플레이 보호) — 내비게이션 시점에만. 주 경로는 OAuth 콜백의 서버 리다이렉트.
 */
export function ConsentGuard() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isMemberOnlyPath(pathname)) return; // 공개 페이지 전체 허용
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (cancelled || !p) return;
        writeCachedProfile(p.id, p);
        if (p.accountState === "consent_incomplete") {
          const search = typeof window !== "undefined" ? window.location.search : "";
          const next = safeNext(pathname + search);
          router.replace(`/consent?next=${encodeURIComponent(next)}`);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
