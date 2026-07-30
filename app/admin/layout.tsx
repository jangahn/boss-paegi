import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { AppNav } from "@/components/AppNav";
import { AdminNav } from "@/components/admin/AdminNav";

// 어드민 전 구역 공통 셸 — 로그인은 proxy 가, is_admin 은 layout/page 가까이에서 각각 게이트.
// 동일 render pass는 React cache로 한 authority read를 공유하고 API route는 독립 재확인한다.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "운영",
  robots: { index: false, follow: false },
  alternates: { canonical: null },
};

// 어드민은 다크 콘솔 → 상단 상태바/브라우저 크롬 색도 다크로(루트 크림 themeColor 오버라이드).
// 이탈 시 루트 viewport(크림)로 복귀 → iOS 에서 최상단이 다크로 잔존하지 않고 리페인트됨.
export const viewport: Viewport = {
  themeColor: "#0d1726",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const gate = await requireAdmin();
  // 동의는 proxy 가 렌더 전 게이트(미동의면 여기 안 옴). consent_required 분기는 edge/app 버전캐시
  // 일시 divergence 방어(→/consent, 루프 없음). 비관리자 등은 홈.
  if (!gate.ok) redirect(gate.error === "consent_required" ? "/consent?next=/admin" : "/");
  return (
    <div className="theme-admin flex flex-1 flex-col bg-background text-foreground">
      {/* 어드민 전용 AppNav — root layout 의 AppNav 는 /admin 에서 hide, 여기서 theme-admin(다크) 안에 직접. */}
      <AppNav forceShow />
      {/* 운영 모드 시그널 — 플레이(크림) 모드와 구분 */}
      <div className="border-b border-gold/30 bg-gold/10 px-4 py-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
        운영 모드 · ADMIN
      </div>
      <AdminNav />
      {children}
    </div>
  );
}
