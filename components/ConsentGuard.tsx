"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getMyProfile, writeCachedProfile } from "@/lib/profile";
import { safeNext } from "@/lib/oauth-metadata";

// /consent(동의 화면 자체)·/auth/callback(로그인 콜백)은 consent_incomplete 가 정상 → 예외(루프 방지).
const EXEMPT = ["/consent", "/auth/callback"];

/**
 * "동의까지 끝나야 로그인"(I7) — route 변경 시 consent_incomplete 세션을 `/consent` 로 수렴시킨다.
 * 포커스 중 페이지 한복판에서 강제이탈은 하지 않음(게임 플레이 보호) — **내비게이션 시점에만**.
 * 주 경로는 OAuth 콜백의 서버 리다이렉트이고, 이 가드는 뒤로가기/직접 URL 진입의 안전망이다.
 * (member 액션은 서버 requireMember 가 즉시 consent_required 로 차단하므로 법적 enforcement 는 별도 보장.)
 */
export function ConsentGuard() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (EXEMPT.some((p) => pathname === p || pathname.startsWith(p + "/"))) return;
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
