import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-server";
import { AppNav } from "@/components/AppNav";
import { AdminNav } from "@/components/admin/AdminNav";

// 어드민 전 구역 공통 셸 — 로그인은 proxy 가, is_admin 은 여기서 1회 게이트 + 서브 네비.
// 각 페이지/route 도 방어적으로 requireAdmin 재확인(layout 은 API route 를 보호하지 않음).
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const gate = await requireAdmin();
  if (!gate.ok) redirect("/");
  return (
    <>
      <AppNav />
      <AdminNav />
      {children}
    </>
  );
}
