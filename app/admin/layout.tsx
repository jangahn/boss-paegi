import type { Viewport } from "next";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { AppNav } from "@/components/AppNav";
import { AdminNav } from "@/components/admin/AdminNav";

// 어드민 전 구역 공통 셸 — 로그인은 proxy 가, is_admin 은 여기서 1회 게이트 + 서브 네비.
// 각 페이지/route 도 방어적으로 requireAdmin 재확인(layout 은 API route 를 보호하지 않음).
export const dynamic = "force-dynamic";

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
      {/* 운영 모드 시그널 — 플레이(크림) 모드와 구분 */}
      <div className="border-b border-gold/30 bg-gold/10 px-4 py-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-gold">
        운영 모드 · ADMIN
      </div>
      <AppNav />
      <AdminNav />
      {children}
    </div>
  );
}
