import type { Metadata } from "next";
import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { JsonLd } from "@/components/JsonLd";
import { getSiteContent } from "@/lib/config/getters";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";
import { PaperPanel, Paperclip, DashedDivider } from "@/components/dossier";

export async function generateMetadata(): Promise<Metadata> {
  const sc = await getSiteContent();
  return {
    title: "소개·자주 묻는 질문",
    description: sc.metaDescription,
    alternates: { canonical: "/faq" },
    openGraph: {
      title: `${SERVICE_NAME} 소개·자주 묻는 질문`,
      description: sc.definition,
      url: `${SITE_URL}/faq`,
      type: "website",
    },
  };
}

export default async function FaqPage() {
  const sc = await getSiteContent();
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    inLanguage: "ko-KR",
    mainEntity: sc.faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <AppNav />
      <JsonLd data={faqLd} />
      <main className="flex flex-1 flex-col px-5 py-10">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <PaperPanel folded className="relative px-7 pb-7 pt-10">
            <Paperclip className="left-7" />
            <h1 className="font-display text-4xl tracking-tight text-ink">{SERVICE_NAME} 소개</h1>
            <p className="mt-4 text-base leading-relaxed text-zinc-600 dark:text-zinc-300">{sc.intro}</p>
          </PaperPanel>

          <PaperPanel className="px-7 pb-7 pt-6">
            <h2 className="font-display text-2xl tracking-tight text-ink">자주 묻는 질문</h2>
            <DashedDivider className="my-5" />
            <div className="flex flex-col divide-y divide-line">
              {sc.faq.map((f, i) => (
                <section key={i} className="py-5 first:pt-0 last:pb-0">
                  <h3 className="text-base font-semibold text-ink">{f.q}</h3>
                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {f.a}
                  </p>
                </section>
              ))}
            </div>
          </PaperPanel>

          <nav className="flex flex-wrap gap-x-5 gap-y-2 px-1 text-sm text-zinc-500">
            <Link href="/" className="underline-offset-4 hover:text-foreground hover:underline">홈</Link>
            <Link href="/play" className="underline-offset-4 hover:text-foreground hover:underline">바로 플레이</Link>
            <Link href="/terms" className="underline-offset-4 hover:text-foreground hover:underline">이용약관</Link>
            <Link href="/privacy" className="underline-offset-4 hover:text-foreground hover:underline">개인정보처리방침</Link>
          </nav>
        </div>
      </main>
    </>
  );
}
