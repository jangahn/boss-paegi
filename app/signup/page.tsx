import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNext } from "@/lib/oauth-metadata";
import { SignupConsent } from "./SignupConsent";

export const dynamic = "force-dynamic";

/**
 * 회원가입 동의 — OAuth 콜백이 "신규 계정"으로 판별하면 여기로 보냄.
 * 가드: 세션 authed·비익명·deleted 아님·member 없음. 동의 후 onboard 가 member 생성 + 익명 데이터 이전.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNext(next);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) {
    redirect(`/login?next=${encodeURIComponent(dest)}`);
  }

  const admin = createAdminClient();
  const { data: prof } = await admin
    .from("profiles")
    .select("deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if ((prof as { deleted_at?: string | null } | null)?.deleted_at) {
    redirect("/login?error=account_deleted");
  }

  const { data: member } = await admin
    .from("member_accounts")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (member) redirect(dest); // 이미 회원 → 동의 불필요

  return <SignupConsent next={dest} />;
}
