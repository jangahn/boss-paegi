import type { Metadata } from "next";
import { LegalPublicPage } from "@/components/legal/LegalPublicPage";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "개인정보처리방침",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: `개인정보처리방침 · ${SERVICE_NAME}`,
    url: `${SITE_URL}/privacy`,
    type: "website",
  },
};

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  return <LegalPublicPage docType="privacy" viewId={v} />;
}
