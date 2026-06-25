import type { Metadata } from "next";
import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { JsonLd } from "@/components/JsonLd";
import { getSiteContent } from "@/lib/config/getters";
import { SERVICE_NAME } from "@/lib/policy";
import { SITE_URL } from "@/lib/site";

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
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="text-3xl font-extrabold tracking-tight">{SERVICE_NAME} 소개</h1>
          <p className="mt-4 text-base leading-relaxed text-zinc-600 dark:text-zinc-300">{sc.intro}</p>

          <h2 className="mt-12 text-xl font-bold">자주 묻는 질문</h2>
          <div className="mt-4 flex flex-col divide-y divide-foreground/10">
            {sc.faq.map((f, i) => (
              <section key={i} className="py-5">
                <h3 className="text-base font-semibold">{f.q}</h3>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {f.a}
                </p>
              </section>
            ))}
          </div>

          <nav className="mt-10 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-500">
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
