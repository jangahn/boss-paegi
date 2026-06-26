"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SERVICE_NAME } from "@/lib/policy";
import { createClient } from "@/lib/supabase/client";
import { AppNav } from "@/components/AppNav";
import { Paperclip, CornerFold } from "@/components/dossier";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";

export default function Home() {
  const { home } = useMarketingCopy();
  const [isMember, setIsMember] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = createClient();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) return;
      if (!cancelled)
        setIsMember(sessionData.session.user.is_anonymous !== true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <AppNav />
      <main className="flex flex-1 flex-col items-center px-6 py-12">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="relative flex flex-col items-center gap-6 rounded-2xl border border-foreground/10 bg-paper-2 px-7 pb-7 pt-10 text-center shadow-sm">
            <Paperclip className="left-7" />
            <CornerFold />
            <h1 className="font-display text-4xl tracking-tight text-ink">
              {SERVICE_NAME}
            </h1>
            <p className="whitespace-pre-line text-base leading-relaxed text-zinc-600">
              {home.tagline}
            </p>

            <div className="flex w-full flex-col gap-3">
              <Link
                href={isMember ? "/generate" : "/login?next=/generate"}
                className="rounded-full bg-foreground px-6 py-4 text-base font-semibold text-background transition hover:opacity-90"
              >
                {home.primaryCta}
              </Link>
              <Link
                href="/play"
                className="rounded-full border border-foreground/15 px-6 py-4 text-base font-medium transition hover:bg-foreground/5"
              >
                {home.secondaryCta}
              </Link>
              <div className="flex justify-center gap-4 pt-1 text-sm">
                <Link
                  href="/gallery"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  내 부장님 갤러리 →
                </Link>
                <Link
                  href="/leaderboard"
                  className="font-semibold text-steel underline-offset-4 transition hover:text-stamp hover:underline"
                >
                  오늘의 랭킹 →
                </Link>
              </div>
            </div>
          </div>

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
