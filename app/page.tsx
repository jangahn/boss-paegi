"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SERVICE_NAME } from "@/lib/policy";
import { createClient } from "@/lib/supabase/client";
import { AppNav } from "@/components/AppNav";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";
import { log, errInfo } from "@/lib/log";

export default function Home() {
  const { home } = useMarketingCopy();
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
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex max-w-md flex-col items-center gap-6">
          <h1 className="text-5xl font-extrabold tracking-tight">
            {SERVICE_NAME}
          </h1>
          <p className="whitespace-pre-line text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            {home.tagline}
          </p>

          <div className="mt-4 flex w-full flex-col gap-3">
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
              {isMember && hasDolls && (
                <Link
                  href="/gallery"
                  className="font-medium text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline"
                >
                  내 부장님 갤러리 →
                </Link>
              )}
              <Link
                href="/leaderboard"
                className="font-medium text-zinc-500 underline-offset-4 transition hover:text-foreground hover:underline"
              >
                오늘의 랭킹 →
              </Link>
            </div>
          </div>

          <p className="mt-8 whitespace-pre-line text-xs leading-relaxed text-zinc-500">
            {home.disclaimer}
          </p>
        </div>
      </main>
    </>
  );
}
