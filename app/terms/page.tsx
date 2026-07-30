import type { Metadata } from "next";
import { LegalPublicPage } from "@/components/legal/LegalPublicPage";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "이용약관",
  alternates: { canonical: "/terms" },
  openGraph: {
    title: `이용약관 · ${SERVICE_NAME}`,
    url: `${SITE_URL}/terms`,
    type: "website",
  },
};

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  return <LegalPublicPage docType="terms" viewId={v} />;
}
