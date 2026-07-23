"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { BusinessInfo } from "@/lib/config/domains/business-info";

// 전체화면 게임·게이트 화면에선 숨김(AppNav self-hide 패턴과 동일 관용구).
// 심사 요건 노출 대상(홈·/credits)은 목록에 없으므로 항상 노출된다.
const FOOTER_HIDDEN_PREFIXES = ["/play", "/login", "/signup", "/consent", "/reconsent", "/admin"];

/**
 * 전역 푸터 — 사업자정보 상시 노출(PG·카드사·카카오페이 입점 심사 요건: 메인 + 결제페이지 포함,
 * 사업자등록증과 일치). 루트 레이아웃에서 1회 렌더, 라우트별 self-hide. config(business_info.info)
 * 미설정이면 렌더하지 않음(심사 전 준비 단계 — 콘솔에서 채우면 즉시 노출).
 */
export function SiteFooter({ info }: { info: BusinessInfo | undefined }) {
  const pathname = usePathname();
  if (!info) return null;
  if (FOOTER_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return null;
  }
  return (
    <footer className="border-t border-foreground/10 px-6 py-5 text-[11px] leading-relaxed text-zinc-400">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
        <p>
          {info.companyName} · 대표 {info.ownerName} · 사업자등록번호 {info.bizRegNo}
          {info.mailOrderNo && <> · 통신판매업신고 {info.mailOrderNo}</>}
        </p>
        <p>
          {info.address} · 전화 {info.phone} · 이메일 {info.email}
        </p>
        <p className="flex gap-3">
          <Link href="/terms" className="underline underline-offset-2 hover:text-zinc-500">
            이용약관
          </Link>
          <Link href="/privacy" className="underline underline-offset-2 hover:text-zinc-500">
            개인정보처리방침
          </Link>
        </p>
      </div>
    </footer>
  );
}
