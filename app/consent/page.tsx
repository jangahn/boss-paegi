import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentLegal, getCurrentLegalVersions } from "@/lib/legal";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { safeNext } from "@/lib/oauth-metadata";
import { ConsentForm, type LegalDocLite } from "./ConsentForm";

export const dynamic = "force-dynamic";

/**
 * 통합 동의 화면 — **로그인의 마지막·필수 단계**(신규가입·재활성·레거시·구버전 재동의 공용).
 * 경량 가드(I6, authed·비익명·비탈퇴 — requireMember 안 씀 → row 없는 in-between 도 통과).
 * 빠진/구버전 동의 항목만 서버 산출(`lib/consent` 단일 규칙). 0개면(이미 회원) 목적지로.
 */
export default async function ConsentPage({
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

  const [member, curr] = await Promise.all([
    admin
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version")
      .eq("user_id", user.id)
      .maybeSingle()
      .then((r) => (r.data as ConsentMember) ?? null),
    getCurrentLegalVersions(),
  ]);
  const items = missingConsentItems(member, curr);
  if (items.length === 0) redirect(dest); // 이미 동의 완료(member)

  // 표시 항목의 약관/방침 전문(sections)을 함께 내려 "보기"를 인라인 모달로(네비게이션 없음).
  const [termsDoc, privacyDoc] = await Promise.all([
    items.includes("terms") ? getCurrentLegal("terms") : Promise.resolve(null),
    items.includes("privacy") ? getCurrentLegal("privacy") : Promise.resolve(null),
  ]);
  const toLite = (d: Awaited<ReturnType<typeof getCurrentLegal>>): LegalDocLite | null =>
    d ? { title: d.title, sections: d.sections, version: d.version, effectiveDate: d.effective_date } : null;

  return (
    <ConsentForm
      items={items}
      next={dest}
      docs={{ terms: toLite(termsDoc), privacy: toLite(privacyDoc) }}
    />
  );
}
