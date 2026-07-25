import { AccountTabs } from "@/components/account/AccountTabs";

/**
 * 마이페이지 공통 셸 — 상단 2뎁스 탭바(회원정보 · 결제내역 · 생성권 내역) + 각 탭 page.tsx(children).
 * 게이트: proxy 가 /account/* 를 회원 전용으로 선차단, 각 page 도 방어적으로 재확인.
 * 탭바만 client(usePathname) 로 분리 — payments·credits 는 server(force-dynamic) 그대로 유지.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AccountTabs />
      {children}
    </>
  );
}
