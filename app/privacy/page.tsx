import type { Metadata } from "next";
import { LegalPublicPage } from "@/components/legal/LegalPublicPage";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";
import { resolveOgImages } from "@/lib/site-assets";

export const dynamic = "force-dynamic";
// openGraph 는 layout 과 deep-merge 되지 않아 images 를 항상 명시(누락 시 기본 OG 이미지 소실).
export async function generateMetadata(): Promise<Metadata> {
  const ogImages = await resolveOgImages();
  return {
    title: "개인정보처리방침",
    alternates: { canonical: "/privacy" },
    openGraph: {
      title: `개인정보처리방침 · ${SERVICE_NAME}`,
      url: `${SITE_URL}/privacy`,
      type: "website",
      images: ogImages,
    },
  };
}

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v } = await searchParams;
  return <LegalPublicPage docType="privacy" viewId={v} />;
}
