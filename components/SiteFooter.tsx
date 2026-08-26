"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { BusinessInfo } from "@/lib/config/domains/business-info";

// 전체화면 게임·게이트 화면에선 숨김(AppNav self-hide 패턴과 동일 관용구).
// 심사 요건 노출 대상(홈·/credits)은 목록에 없으므로 항상 노출된다.
const FOOTER_HIDDEN_PREFIXES = ["/play", "/login", "/signup", "/consent", "/reconsent", "/admin", "/auth"];

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
    <footer className="border-t border-foreground/10 px-6 py-5 text-[11px] leading-relaxed text-zinc-600">
      <div className="mx-auto grid w-full max-w-3xl gap-x-8 gap-y-1 sm:grid-cols-2">
        {/* 라벨 칼럼: 모바일은 두 목록이 이어져 보이도록 5.5rem 공유 폭, sm+ 2단부터 칼럼별 자동 폭 */}
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-zinc-500">상호</dt>
          <dd>{info.companyName}</dd>
          <dt className="text-zinc-500">대표</dt>
          <dd>{info.ownerName}</dd>
          <dt className="text-zinc-500">사업자등록번호</dt>
          <dd>{info.bizRegNo}</dd>
          {info.mailOrderNo && (
            <>
              <dt className="text-zinc-500">통신판매업신고</dt>
              <dd>{info.mailOrderNo}</dd>
            </>
          )}
          <dt className="text-zinc-500">주소</dt>
          <dd>{info.address}</dd>
        </dl>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-1 self-start sm:grid-cols-[max-content_1fr]">
          <dt className="text-zinc-500">전화</dt>
          <dd>{info.phone}</dd>
          <dt className="text-zinc-500">이메일</dt>
          <dd>{info.email}</dd>
        </dl>
        <div className="mt-3 flex flex-col items-center gap-1 sm:col-span-2">
          <p>© 2026 {info.companyName}. All rights reserved.</p>
          <p className="flex gap-3">
            <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
              이용약관
            </Link>
            <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
              개인정보처리방침
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
