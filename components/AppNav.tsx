"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/AccountMenu";
import { isAuthSubtreePath } from "@/lib/routes";
import { NAV_PILL_NAME, NAV_TRANSITION } from "@/lib/view-transition";

/**
 * 전역 네비게이션 — 홈/갤러리/랭킹 자유 이동 + 계정 메뉴(닉네임·로그인·아바타·로그아웃).
 * /play 는 몰입 화면이라 미장착 (게임 종료 보고서에서 이동 제공).
 */
// AppNav 미노출 라우트 — 몰입 게임(play)·인증/동의 플로우(login·signup·consent·reconsent)·
// 최소 공유 랜딩(share·doll). **/admin 도 root 에선 hide** — 어드민은 layout 이 theme-admin(다크)
// 안에서 forceShow 로 직접 렌더(라이트색 누수·double-nav 방지). 그 외(홈·갤러리·랭킹·소식·약관/
// 방침·계정 등)엔 root layout 에서 1회 렌더 → 내비 간 remount 제거; 여기서 라우트별 self-hide.
const NAV_HIDDEN_PREFIXES = ["/play", "/login", "/consent", "/share", "/doll", "/admin"];

// forceShow: 어드민 layout 이 theme-admin(다크) 안에서 직접 렌더할 때 hide 우회.
export function AppNav({ forceShow = false }: { forceShow?: boolean }) {
  const pathname = usePathname();
  // `/auth` is an identity-mutation isolation boundary. This return must stay
  // before AccountMenu is instantiated; even forceShow may not bypass it.
  if (isAuthSubtreePath(pathname)) return null;
  if (!forceShow && NAV_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return null;

  const links = [
    { href: "/", label: "홈" },
    { href: "/gallery", label: "갤러리" },
    { href: "/leaderboard", label: "랭킹" },
    { href: "/news", label: "소식" },
  ];

  return (
    <nav className="sticky top-0 z-40 border-b border-foreground/10 bg-background/85 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-1.5 px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-0.5 sm:gap-1">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                // 메뉴 이동은 본문만 짧게 교차하고 선택 알약이 새 칸으로 미끄러진다(v1.65, lib/view-transition.ts).
                transitionTypes={[NAV_TRANSITION]}
                aria-current={active ? "page" : undefined}
                className={`relative isolate whitespace-nowrap rounded-full px-2.5 py-1.5 text-sm font-medium transition sm:px-3 ${
                  active ? "text-paper-2" : "text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
                }`}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-0 -z-10 rounded-full bg-foreground"
                    style={{ viewTransitionName: NAV_PILL_NAME }}
                  />
                )}
                {l.label}
              </Link>
            );
          })}
        </div>
        <AccountMenu />
      </div>
    </nav>
  );
}
