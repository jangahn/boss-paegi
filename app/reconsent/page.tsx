import { redirect } from "next/navigation";
import { requireMember } from "@/lib/auth-server";
import { safeNext } from "@/lib/oauth-metadata";
import { ReconsentConsent } from "./ReconsentConsent";

/**
 * 재활성(탈퇴 복구) 회원의 재동의 화면 — 현재 약관·방침에 다시 동의해야 서비스 재이용.
 * 게이트는 allowReconsent(이 경로만 reconsent_required 우회). 이미 동의했으면 목적지로.
 */
export default async function ReconsentPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNext(next);

  const gate = await requireMember({ allowReconsent: true });
  if (!gate.ok) {
    redirect(
      gate.error === "account_deleted"
        ? "/login?error=account_deleted"
        : `/login?next=${encodeURIComponent("/reconsent")}`
    );
  }
  if (!gate.member.reconsent_required) redirect(dest); // 이미 동의 완료

  return <ReconsentConsent next={dest} />;
}
