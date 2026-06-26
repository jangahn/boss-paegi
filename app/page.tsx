"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SERVICE_NAME } from "@/lib/policy";
import { createClient } from "@/lib/supabase/client";
import { AppNav } from "@/components/AppNav";
import { PaperPanel, Paperclip, DashedDivider } from "@/components/dossier";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { useSiteContent } from "@/components/SiteContentProvider";
import { log, errInfo } from "@/lib/log";

export default function Home() {
  const { home } = useMarketingCopy();
  const site = useSiteContent();
  const [hasDolls, setHasDolls] = useState(false);
  const [isMember, setIsMember] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = createClient();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) return;
      if (!cancelled)
        setIsMember(sessionData.session.user.is_anonymous !== true);
      const { count, error } = await sb
        .from("dolls")
        .select("*", { head: true, count: "exact" });
      if (error) log.warn("home.dolls_count_fail", errInfo(error));
      if (!cancelled) setHasDolls((count ?? 0) > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col items-center px-4 py-10">
        <div className="flex w-full max-w-md flex-col gap-5">
          <PaperPanel folded className="relative px-7 pb-7 pt-10 text-center">
            <Paperclip className="left-7" />
            <h1 className="font-display text-5xl tracking-tight text-ink sm:text-6xl">
              {SERVICE_NAME}
            </h1>
            <p className="mt-3 whitespace-pre-line text-base leading-relaxed text-zinc-600">
              {home.tagline}
            </p>

            <DashedDivider className="my-6" />

            <div className="flex w-full flex-col gap-3">
              <Link
                href={isMember ? "/generate" : "/login?next=/generate"}
                className="rounded-lg bg-foreground px-6 py-3.5 text-base font-bold text-background transition hover:opacity-90"
              >
                {home.primaryCta}
              </Link>
              <Link
                href="/play"
                className="rounded-lg border-2 border-line px-6 py-3.5 text-base font-semibold text-ink transition hover:bg-paper-3/60"
              >
                {home.secondaryCta}
              </Link>
              <div className="flex justify-center gap-4 pt-1 text-sm">
                {isMember && hasDolls && (
                  <Link
                    href="/gallery"
                    className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                  >
                    내 부장님 갤러리 →
                  </Link>
                )}
                <Link
                  href="/leaderboard"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  오늘의 랭킹 →
                </Link>
              </div>
            </div>
          </PaperPanel>

          <PaperPanel className="px-6 py-5 text-center">
            <p className="whitespace-pre-line text-xs leading-relaxed text-zinc-600">
              {site.intro}
            </p>
            <Link
              href="/faq"
              className="mt-3 inline-block text-sm font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
            >
              소개·자주 묻는 질문 →
            </Link>
          </PaperPanel>

          <div className="px-2 text-center">
            <p className="whitespace-pre-line text-xs leading-relaxed text-zinc-500">
              {home.disclaimer}
            </p>
            <nav className="mt-3 flex flex-wrap justify-center gap-3 text-[11px] text-zinc-500">
              <Link href="/faq" className="underline-offset-4 hover:text-stamp hover:underline">
                소개·FAQ
              </Link>
              <span aria-hidden>·</span>
              <Link href="/terms" className="underline-offset-4 hover:text-stamp hover:underline">
                이용약관
              </Link>
              <span aria-hidden>·</span>
              <Link href="/privacy" className="underline-offset-4 hover:text-stamp hover:underline">
                개인정보처리방침
              </Link>
            </nav>
          </div>
        </div>
      </main>
    </>
  );
}
